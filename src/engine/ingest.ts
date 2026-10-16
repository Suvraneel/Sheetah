import { DuckDBDataProtocol } from '@duckdb/duckdb-wasm'
import { ensureExtension, exec, getEngine, quoteIdent, quoteLiteral, sandboxPath } from './db'

import type { XlsxReply } from './xlsx.worker'

export const ACCEPTED = '.csv,.tsv,.txt,.gz,.json,.jsonl,.ndjson,.parquet,.xlsx,.xlsm'

/** Turns "Sales Report (2024).csv.gz" into a friendly SQL name: sales_report_2024 */
export function tableNameFor(fileName: string, taken: Set<string>): string {
  const stem = fileName
    .replace(/\.(gz|gzip|zst)$/i, '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  let name = /^[a-z_]/.test(stem) ? stem || 'data' : `t_${stem}`
  const base = name
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  return name
}

function readerFor(fileName: string): { fn: string; materialize: boolean } {
  const n = fileName.toLowerCase().replace(/\.(gz|gzip|zst)$/, '')
  if (n.endsWith('.parquet')) return { fn: 'read_parquet', materialize: false }
  if (/\.(json|jsonl|ndjson)$/.test(n)) return { fn: 'read_json_auto', materialize: true }
  return { fn: 'read_csv_auto', materialize: true } // csv, tsv, txt: delimiter is sniffed
}

/**
 * Registers the File with DuckDB (it reads straight from disk, nothing is uploaded) and
 * creates a table. CSV/JSON are materialised so scrolling and sorting stay fast;
 * Parquet stays a view because it's already columnar and compressed.
 */
export async function ingestFile(file: File, taken: Set<string>): Promise<string[]> {
  const { db } = await getEngine()
  if (/\.xls$/i.test(file.name)) {
    throw new Error('Old .xls files aren’t supported. Re-save it as .xlsx or CSV and try again.')
  }
  if (/\.xls[xm]$/i.test(file.name)) return ingestExcel(file, taken)
  const name = tableNameFor(file.name, taken)
  const virtualPath = sandboxPath(`${name}__${file.name}`)
  await db.registerFileHandle(virtualPath, file, DuckDBDataProtocol.BROWSER_FILEREADER, true)
  const { fn, materialize } = readerFor(file.name)
  if (fn === 'read_parquet') await ensureExtension('parquet')
  if (fn === 'read_json_auto') await ensureExtension('json')
  const source = `${fn}(${quoteLiteral(virtualPath)})`
  await exec(
    materialize
      ? `CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${source}`
      : `CREATE OR REPLACE VIEW ${quoteIdent(name)} AS SELECT * FROM ${source}`,
  )
  return [name]
}

function parseExcel(file: File): Promise<XlsxReply> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), { type: 'module' })
    const finish = (reply: XlsxReply) => {
      window.clearTimeout(timer)
      resolve(reply)
      worker.terminate()
    }
    // Large workbooks take seconds; anything past two minutes is treated as stuck.
    const timer = window.setTimeout(() => finish({ ok: false, error: 'Reading that workbook took too long. Try saving it as CSV.' }), 120_000)
    worker.onmessage = (e: MessageEvent<XlsxReply>) => finish(e.data)
    worker.onerror = (e) => finish({ ok: false, error: e.message || 'The spreadsheet couldn’t be read.' })
    worker.postMessage(file)
  })
}

/** Every non-empty sheet becomes its own table: budget.xlsx → budget_q1, budget_q2, … */
async function ingestExcel(file: File, taken: Set<string>): Promise<string[]> {
  const { db } = await getEngine()
  const reply = await parseExcel(file)
  if (!reply.ok) throw new Error(reply.error)
  if (!reply.sheets.length) throw new Error('That workbook has no data in any sheet.')
  const stem = file.name.replace(/\.xls[xm]$/i, '')
  const names: string[] = []
  for (const sheet of reply.sheets) {
    const name = tableNameFor(reply.sheets.length === 1 ? `${stem}.x` : `${stem} ${sheet.name}.x`, taken)
    taken.add(name)
    const path = sandboxPath(`${name}__sheet.csv`)
    await db.registerFileText(path, sheet.csv)
    try {
      await exec(`CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM read_csv_auto(${quoteLiteral(path)}, header = true)`)
    } finally {
      await db.dropFile(path)
    }
    names.push(name)
  }
  return names
}

/** A realistic 1,000,000-row orders table generated inside DuckDB: no download needed. */
export async function createDemo(rows = 1_000_000): Promise<string> {
  await exec(`
    CREATE OR REPLACE TABLE orders AS
    WITH base AS (
      SELECT range AS i, hash(range) AS h, hash(range * 7919) AS g FROM range(${rows})
    )
    SELECT
      100000 + i AS order_id,
      TIMESTAMP '2023-01-01' + to_seconds((h % 56160000)::BIGINT) AS ordered_at,
      ['Aarav','Diya','Kabir','Meera','Rohan','Ananya','Vihaan','Isha','Arjun','Sara','Leo','Mia','Noah','Zoe','Kenji','Amara'][1 + (g % 16)::INT]
        || ' ' || ['Sharma','Iyer','Khan','Das','Patel','Mehta','Reddy','Bose','Smith','Garcia','Tanaka','Okafor'][1 + (h % 12)::INT] AS customer,
      ['Bengaluru','Mumbai','Delhi','Kolkata','Chennai','Pune','Hyderabad','Jaipur','London','Berlin','Singapore','Dubai','Toronto','Sydney'][1 + ((h >> 8) % 14)::INT] AS city,
      ['Electronics','Home','Fashion','Books','Beauty','Sports','Grocery','Toys'][1 + ((g >> 4) % 8)::INT] AS category,
      ['Wireless earbuds','Desk lamp','Linen shirt','Paperback novel','Face serum','Yoga mat','Cold brew pack','Puzzle set',
       'Mechanical keyboard','Ceramic mug','Running shoes','Cookbook','Sunscreen','Football','Green tea','Board game'][1 + ((h >> 16) % 16)::INT] AS product,
      1 + ((g >> 12) % 5)::INT AS quantity,
      round(99 + ((h >> 20) % 490000) / 100.0, 2) AS unit_price,
      [0, 0, 0, 5, 10, 15, 20][1 + ((g >> 20) % 7)::INT] AS discount_pct,
      round((1 + ((g >> 12) % 5)) * (99 + ((h >> 20) % 490000) / 100.0) * (1 - [0, 0, 0, 5, 10, 15, 20][1 + ((g >> 20) % 7)::INT] / 100.0), 2) AS total,
      ['delivered','delivered','delivered','delivered','shipped','processing','returned','cancelled'][1 + ((h >> 28) % 8)::INT] AS status
    FROM base
  `)
  return 'orders'
}

export interface TableMeta {
  name: string
  kind: 'table' | 'view'
  rows: number | null
  columns: { name: string; type: string }[]
}

export async function listTables(): Promise<TableMeta[]> {
  const { conn } = await getEngine()
  const tables = (
    await conn.query(`SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = 'main' AND table_name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY table_name`)
  )
    .toArray()
    .map((r) => r.toJSON() as { table_name: string; table_type: string })
  const cols = (
    await conn.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`)
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
