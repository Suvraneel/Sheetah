/*
 * The open tables, as the library lists them, and what's known about how their files were read: needed
 * from the first screen. Reading a file (ingest.ts) is loaded when one is opened.
 */
import { getEngine, quoteIdent } from './db'

/** The files the file picker offers. */
export const ACCEPTED = '.csv,.tsv,.txt,.gz,.json,.jsonl,.ndjson,.parquet,.xlsx,.xlsm,.xls,.xml,.htm,.html'

/** Tables whose dates were read day-first or month-first from text (by the CSV reader's guess). */
export const dateOrders = new Map<string, 'dmy' | 'mdy'>()

/** Tables whose dates read both ways (no day past the 12th), read the reader's way: offered the other way too. */
export const datesGuessed = new Set<string>()

export interface TableMeta {
  name: string
  kind: 'table' | 'view'
  rows: number | null
  columns: { name: string; type: string }[]
}

export async function listTables(): Promise<TableMeta[]> {
  const { conn } = await getEngine()
  const tables = (
    // Only the database's own tables: TEMP tables also report schema 'main', but live in the temp catalog.
    await conn.query(`SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = 'main' AND table_catalog = current_database()
        AND table_name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY table_name`)
  )
    .toArray()
    .map((r) => r.toJSON() as { table_name: string; table_type: string })
  const cols = (
    await conn.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'main' AND table_catalog = current_database() ORDER BY table_name, ordinal_position`)
  )
    .toArray()
    .map((r) => r.toJSON() as { table_name: string; column_name: string; data_type: string })

  const out: TableMeta[] = []
  for (const t of tables) {
    const kind = t.table_type === 'VIEW' ? 'view' : 'table'
    let rows: number | null = null
    if (kind === 'table') {
      const c = await conn.query(`SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(t.table_name)}`)
      rows = Number(c.toArray()[0]?.toJSON().n ?? 0)
    }
    out.push({
      name: t.table_name,
      kind,
      rows,
      columns: cols.filter((c) => c.table_name === t.table_name).map((c) => ({ name: c.column_name, type: c.data_type })),
    })
  }
  return out
}
