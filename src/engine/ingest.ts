import { DuckDBDataProtocol } from '@duckdb/duckdb-wasm'
import { CancelledError, ensureExtension, getEngine, isCancel, quoteIdent, quoteLiteral, sandboxPath, sendAll, withRunLock } from './db'
import { FileKindError } from './load-errors'
import { tableNameFor } from './sql'
export { FileKindError } from './load-errors'

import type { XlsxReply, XlsxSheet } from './xlsx.worker'

export const ACCEPTED = '.csv,.tsv,.txt,.gz,.json,.jsonl,.ndjson,.parquet,.xlsx,.xlsm,.xls,.xml,.htm,.html'

export { tableNameFor } from './sql'

/** Names already in use, straight from the engine (DuckDB names are case-insensitive). */
async function takenNames(extra: Set<string>): Promise<Set<string>> {
  const { conn } = await getEngine()
  const res = await conn.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`)
  return new Set([...extra, ...res.toArray().map((r) => String(r.toJSON().table_name))])
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
 * Loads run one at a time on the cancellable connection, so the Cancel button stops them.
 */
/** Tables whose dates were read day-first or month-first from text (by the CSV reader's guess). */
export const dateOrders = new Map<string, 'dmy' | 'mdy'>()

export async function ingestFile(file: File, taken: Set<string> = new Set(), onNote?: (note: string) => void): Promise<string[]> {
  if (!file.size) throw new FileKindError(`${file.name} is empty.`)
  const { sniff, notATable } = await import('./sniff')
  const kind = sniff(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))
  const wrong = notATable(kind, file.name)
  if (wrong) throw new FileKindError(wrong)
  if (kind === 'html' || kind === 'xml-sheet') return ingestMarkup(file, kind, taken, onNote)
  if (kind === 'text' && /\.html?$/i.test(file.name)) return ingestMarkup(file, 'html', taken, onNote)
  if (kind === 'text' && /\.xml$/i.test(file.name))
    throw new FileKindError(`${file.name} is XML, but not a spreadsheet. Sheetah opens XML saved by Excel (XML Spreadsheet 2003); for other XML, export a CSV.`)
  if (/\.xls$/i.test(file.name)) {
    // Some systems save tab-separated text as .xls (Excel opens it): read it as the text it is.
    const head = await file.slice(0, 4096).text()
    if (!/[\t,;|].*\n/.test(head)) throw new FileKindError(`Old .xls files aren’t supported. Re-save ${file.name} as .xlsx or CSV and try again.`)
    return ingestRead(file, taken, onNote)
  }
  if (/\.xls[xm]$/i.test(file.name)) return ingestExcel(file, taken, onNote)
  // Excel's "Unicode Text" (UTF-16, tab-separated): DuckDB reads UTF-8, so it's turned into that first.
  if (kind === 'utf16le' || kind === 'utf16be') {
    if (file.size > 512 * 1024 ** 2) throw new FileKindError(`${file.name} is UTF-16 text over 512 MB. Save it as CSV UTF-8 and open that.`)
    const text = new TextDecoder(kind === 'utf16le' ? 'utf-16le' : 'utf-16be').decode(await file.arrayBuffer())
    return ingestRead(new File([text], file.name, { type: 'text/plain' }), taken, onNote)
  }
  return ingestRead(file, taken, onNote)
}


function ingestRead(file: File, taken: Set<string>, onNote?: (note: string) => void): Promise<string[]> {
  return withRunLock(async () => {
    const { db } = await getEngine()
    const name = tableNameFor(file.name, await takenNames(taken))
    dateOrders.delete(name.toLowerCase()) // a name used before (that table since dropped): read afresh
    const { fn, materialize } = readerFor(file.name)
    if (fn === 'read_parquet') await ensureExtension('parquet')
    if (fn === 'read_json_auto') await ensureExtension('json')
    const virtualPath = sandboxPath(`${name}__${file.name}`)
    await db.registerFileHandle(virtualPath, file, DuckDBDataProtocol.BROWSER_FILEREADER, true)
    const source = `${fn}(${quoteLiteral(virtualPath)})`
    try {
      await sendAll(
        materialize
          ? `CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM ${source}`
          : `CREATE VIEW ${quoteIdent(name)} AS SELECT * FROM ${source}`,
      )
    } catch (e) {
      await db.dropFile(virtualPath).catch(() => {})
      throw isCancel(e) ? new CancelledError() : e
    }
    // Rows with more or fewer fields than the header make the sniffer give up and read each line as
    // one text column ("name,city,amount"). Read it again with that separator, padding short rows.
    if (fn === 'read_csv_auto') {
      try {
        const described = (await sendAll(`DESCRIBE ${quoteIdent(name)}`)).toArray().map((r) => r.toJSON() as { column_name: string; column_type: string })
        const cols = described.map((r) => String(r.column_name))
        // Dates the reader recognised: which way round it read 01/02/2024 (it can't know, on dates up to the 12th).
        if (described.some((r) => r.column_type === 'DATE')) {
          const f = await sendAll(`SELECT DateFormat AS f FROM sniff_csv(${quoteLiteral(virtualPath)})`)
            .then((t) => String(t.toArray()[0]?.toJSON().f ?? ''))
            .catch((e) => (isCancel(e) ? Promise.reject(e) : ''))
          if (/^%d\W%m/.test(f)) dateOrders.set(name.toLowerCase(), 'dmy')
          else if (/^%m\W%d/.test(f)) dateOrders.set(name.toLowerCase(), 'mdy')
        }
        const sep = cols.length === 1 ? [',', ';', '\t', '|'].find((d) => cols[0].includes(d)) : undefined
        if (sep) {
          await sendAll(
            `CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM read_csv(${quoteLiteral(virtualPath)}, delim = ${quoteLiteral(sep)}, header = true, null_padding = true, strict_mode = false)`,
          )
          onNote?.(`Some rows of ${file.name} have more or fewer fields than its header: missing ones are left empty.`)
        }
      } catch (e) {
        if (isCancel(e)) {
          await db.dropFile(virtualPath).catch(() => {})
          throw new CancelledError()
        }
        /* keep the table as first read */
      }
    }
    // A materialised table no longer needs the file; a Parquet view keeps reading it.
    if (materialize) await db.dropFile(virtualPath).catch(() => {})
    return [name]
  })
}

let excelWorker: { stop: () => void } | null = null

/** Stops an Excel file that is still being read (the Cancel button calls this as well as cancelRunning). */
export function cancelExcel() {
  excelWorker?.stop()
}

function parseExcel(file: File): Promise<XlsxReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), { type: 'module' })
    const finish = (reply: XlsxReply) => {
      window.clearTimeout(timer)
      excelWorker = null
      resolve(reply)
      worker.terminate()
    }
    excelWorker = {
      stop: () => {
        window.clearTimeout(timer)
        excelWorker = null
        worker.terminate()
        reject(new CancelledError())
      },
    }
    // Large workbooks take seconds; anything past two minutes is treated as stuck.
    const timer = window.setTimeout(() => finish({ ok: false, error: 'Reading that workbook took too long. Try saving it as CSV.', plain: true }), 120_000)
    worker.onmessage = (e: MessageEvent<XlsxReply>) => finish(e.data)
    worker.onerror = (e) => finish({ ok: false, error: e.message || 'The spreadsheet couldn’t be read.' })
    worker.postMessage(file)
  })
}

/** Every non-empty sheet becomes its own table: budget.xlsx → budget_q1, budget_q2, … */
async function ingestExcel(file: File, taken: Set<string>, onNote?: (note: string) => void): Promise<string[]> {
  const reply = await parseExcel(file)
  if (!reply.ok) throw reply.plain ? new FileKindError(reply.error) : new Error(reply.error)
  return ingestSheets(file, reply.sheets, taken, onNote)
}

/** An ".xls" that is a web page's table or Excel 2003 XML: read here (the browser parses markup). */
async function ingestMarkup(file: File, kind: 'html' | 'xml-sheet', taken: Set<string>, onNote?: (note: string) => void): Promise<string[]> {
  // The browser builds the whole page in memory (several times the file), and that can't be stopped.
  if (file.size > 50 * 1024 ** 2) throw new FileKindError(`${file.name} is a web page or XML spreadsheet over 50 MB. Save it as CSV or .xlsx and open that.`)
  const { markupToCsv } = await import('./markup-sheets')
  const sheets = markupToCsv(await textOf(file), kind)
  if (!sheets.length && kind === 'html') throw new FileKindError(`${file.name} is a web page with no table in it.`)
  return ingestSheets(file, sheets, taken, onNote)
}

/** A web page's or XML file's text in the encoding it declares (Excel's web pages are often windows-1252). */
async function textOf(file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048))
  const label = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding\s*=\s*["']([\w:.-]+)["']/i.exec(head)?.[1]
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes) // a label the browser doesn't know
  }
}

async function ingestSheets(file: File, sheets: XlsxSheet[], taken: Set<string>, onNote?: (note: string) => void): Promise<string[]> {
  if (!sheets.length) throw new FileKindError('That workbook has no data in any sheet.')
  const reply = { sheets }
  return withRunLock(async () => {
    const { db } = await getEngine()
    const used = await takenNames(taken)
    const stem = file.name.replace(/\.(xls[xm]?|xml|html?|csv|tsv|txt)$/i, '')
    const names: string[] = []
    for (const sheet of reply.sheets) {
      const name = tableNameFor(reply.sheets.length === 1 ? `${stem}.x` : `${stem} ${sheet.name}.x`, used)
      used.add(name)
      dateOrders.delete(name.toLowerCase())
      const path = sandboxPath(`${name}__sheet.csv`)
      await db.registerFileText(path, sheet.csv)
      try {
        await sendAll(`CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM read_csv_auto(${quoteLiteral(path)}, header = true)`)
      } finally {
        await db.dropFile(path).catch(() => {})
      }
      names.push(name)
      if (sheet.skipped)
        onNote?.(`Left out ${sheet.skipped === 1 ? 'a title line' : `${sheet.skipped} title lines`} above the column names in ${reply.sheets.length === 1 ? file.name : sheet.name}.`)
    }
    return names
  })
}

/**
 * A realistic 1,000,000-row orders table generated inside DuckDB: no download needed. It's called
 * "orders" unless that name is taken (by the user's own file, or an earlier sample), so it never
 * replaces anyone's data.
 */
export function createDemo(rows = 1_000_000): Promise<string> {
  return withRunLock(async () => {
    const name = tableNameFor('orders.x', await takenNames(new Set()))
    await sendAll(`
      CREATE TABLE ${quoteIdent(name)} AS
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
    return name
  })
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
