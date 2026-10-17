import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as duckdb from '@duckdb/duckdb-wasm/blocking'
import { CLEAN_MACROS } from '../../src/engine/clean'

/*
 * The same DuckDB-WASM build the app ships, run in Node (blocking API, no worker, no browser), so the
 * SQL the app generates is executed for real in unit tests: a typo or a type error fails here first.
 */
const require = createRequire(import.meta.url)
const dist = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'))

let ready: Promise<duckdb.DuckDBConnection> | null = null

export function engine(): Promise<duckdb.DuckDBConnection> {
  ready ??= (async () => {
    const db = await duckdb.createDuckDB(
      {
        mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: join(dist, 'duckdb-node-mvp.worker.cjs') },
        eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: join(dist, 'duckdb-node-eh.worker.cjs') },
      },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    )
    await db.instantiate()
    const c = db.connect()
    // The app's own SQL macros (clean-up conversions), as every app connection has them.
    for (const m of CLEAN_MACROS) c.query(m)
    return c
  })()
  return ready
}

/** Runs SQL (several statements allowed) and returns the last statement's rows as plain objects. */
export async function q(sql: string): Promise<Record<string, unknown>[]> {
  const c = await engine()
  const table = c.query(sql)
  return table.toArray().map((r) => {
    const o = r.toJSON() as Record<string, unknown>
    for (const k of Object.keys(o)) if (typeof o[k] === 'bigint') o[k] = Number(o[k])
    return o
  })
}
