import { DuckDBDataProtocol } from '@duckdb/duckdb-wasm'
import { CancelledError, ensureExtension, getEngine, isCancel, quoteIdent, quoteLiteral, sandboxPath, sendAll, withRunLock } from './db'
import { FileKindError } from './load-errors'
import { LOCALE, tableNameFor } from './sql'
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

/** Tables whose dates were read day-first or month-first from text (by the CSV reader's guess). */
export const dateOrders = new Map<string, 'dmy' | 'mdy'>()

const columnTypes = async (table: string) =>
  (await sendAll(`DESCRIBE ${quoteIdent(table)}`)).toArray().map((r) => {
    const c = r.toJSON() as { column_name: string; column_type: string }
    return { name: String(c.column_name), type: String(c.column_type) }
  })

/**
 * A two-digit-year-first format (%y/%m/%d) turned day-first or month-first, separators kept:
 * "%y/%m/%d %H:%M" → "%d/%m/%y %H:%M". Anything else stays as it is (null).
 */
function yearLast(format: string, order: 'dmy' | 'mdy'): string | null {
  const m = /^%y(\W)%m(\W)%d/.exec(format)
  if (!m) return null
  return (order === 'dmy' ? `%d${m[1]}%m${m[2]}%y` : `%m${m[1]}%d${m[2]}%y`) + format.slice(m[0].length)
}

/**
 * Which way round the reader took dates like 01/02/2024 (it can't know, up to the 12th): kept for the
 * date hint. Its pick for 01/04/24 is two-digit year first, 24 April 2001 (and 01/04/24 10:30, with no
 * seconds, isn't seen as a time at all: the year 1). Statements write the day first. When day-first or
 * month-first (the reader's own habit tried first) reads the same columns as dates, keeps their years as
 * close together, and puts them nearer today, the file is read again that way. A file that really is
 * year first (24/01/31, 24/02/29…) stays as it was read: read the other way, its dates are years away.
 */
async function readDates(name: string, path: string, read: (opts: string) => string): Promise<void> {
  const dated = (await columnTypes(name)).filter((c) => c.type === 'DATE' || c.type.startsWith('TIMESTAMP'))
  if (!dated.length) return
  const f = await sendAll(`SELECT DateFormat AS d, TimestampFormat AS t FROM sniff_csv(${quoteLiteral(path)})`)
    .then((t) => t.toArray()[0]?.toJSON() as { d?: string; t?: string } | undefined)
    .catch((e) => (isCancel(e) ? Promise.reject(e) : undefined))
  let date = String(f?.d ?? '')
  let time = String(f?.t ?? '')
  const one = (sql: string) => sendAll(sql).then((t) => (t.toArray()[0]?.toJSON() ?? {}) as Record<string, unknown>)
  // No format from the sniffer (a file whose rows have more or fewer fields than its header, read again with
  // its separator): how the dates are written, from the text itself, as the reader would have said it.
  const plain = dated.filter((c) => c.type === 'DATE')
  if (!date && plain.length) {
    const c = quoteIdent(plain[0].name)
    const raw = String((await one(`SELECT ${c} AS v FROM ${read('all_varchar = true')} WHERE ${c} IS NOT NULL AND trim(${c}) <> '' LIMIT 1`).catch(() => ({}) as Record<string, unknown>)).v ?? '')
    const m = /^\d{1,2}([/.-])\d{1,2}\1\d{2}$/.exec(raw.trim())
    if (m) date = `%y${m[1]}%m${m[1]}%d`
  }
  let order: 'dmy' | 'mdy' | undefined = /^%d\W%m/.test(date) ? 'dmy' : /^%m\W%d/.test(date) ? 'mdy' : undefined
  // Times read as the year 1 (no seconds, so no format found): how they're written, from the text itself.
  const times = dated.filter((c) => c.type.startsWith('TIMESTAMP'))
  if (times.length && !yearLast(time, 'dmy')) {
    const low = await one(`SELECT least(${times.map((c) => `min(year(${quoteIdent(c.name)}))`).join(', ')})::DOUBLE AS y FROM ${quoteIdent(name)}`)
    if (Number(low.y ?? 1e9) < 100) {
      const c = quoteIdent(times[0].name)
      const raw = String((await one(`SELECT ${c} AS v FROM ${read('all_varchar = true')} WHERE ${c} IS NOT NULL LIMIT 1`)).v ?? '')
      const m = /^\d{1,2}([/.-])\d{1,2}\1\d{2}\s+\d{1,2}:\d{2}(:\d{2})?$/.exec(raw.trim())
      if (m) time = `%y${m[1]}%m${m[1]}%d %H:%M${m[2] ? ':%S' : ''}` // as the reader would have said it; turned below
    }
  }
  if (yearLast(date, 'dmy') || yearLast(time, 'dmy')) {
    // How the dates sit: how many different years, and how far from today on average.
    const today = new Date().toISOString().slice(0, 10)
    const shape = async (table: string) => {
      const r = await one(
        `SELECT ${dated.map((c, i) => `count(DISTINCT year(${quoteIdent(c.name)}))::DOUBLE AS y${i}, sum(abs(date_diff('day', ${quoteIdent(c.name)}::DATE, DATE '${today}')))::DOUBLE AS d${i}, count(${quoteIdent(c.name)})::DOUBLE AS n${i}`).join(', ')} FROM ${quoteIdent(table)}`,
      )
      const sum = (k: string) => dated.reduce((s, _, i) => s + Number(r[`${k}${i}`] ?? 0), 0)
      return { years: sum('y'), away: sum('d') / Math.max(1, sum('n')) }
    }
    const now = await shape(name)
    const tmp = `__dates_${name}`
    for (const o of /^en-US$/i.test(LOCALE) ? (['mdy', 'dmy'] as const) : (['dmy', 'mdy'] as const)) {
      const d = yearLast(date, o)
      const t = yearLast(time, o)
      const opts = [d && `dateformat = ${quoteLiteral(d)}`, t && `timestampformat = ${quoteLiteral(t)}`].filter(Boolean).join(', ')
      try {
        await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(tmp)} AS SELECT * FROM ${read(opts)}`)
        const types = new Map((await columnTypes(tmp)).map((c) => [c.name, c.type]))
        const then = dated.every((c) => types.get(c.name) === c.type) ? await shape(tmp) : null
        if (then && then.years <= now.years && then.away < now.away) {
          // Swapped in one transaction (no second copy of the rows): a cancel part-way leaves the first reading.
          await sendAll('BEGIN TRANSACTION')
          try {
            await sendAll(`DROP TABLE ${quoteIdent(name)}`)
            await sendAll(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(name)}`)
            await sendAll('COMMIT')
          } catch (e) {
            await sendAll('ROLLBACK').catch(() => {})
            throw e
          }
          order = o
          break
        }
      } catch (e) {
        if (isCancel(e)) throw e
      } finally {
        await sendAll(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`).catch(() => {})
      }
    }
  }
  if (order) dateOrders.set(name.toLowerCase(), order)
}

/**
 * Registers the File with DuckDB (it reads straight from disk, nothing is uploaded) and
 * creates a table. CSV/JSON are materialised so scrolling and sorting stay fast;
 * Parquet stays a view because it's already columnar and compressed.
 * Loads run one at a time on the cancellable connection, so the Cancel button stops them.
 */
export async function ingestFile(file: File, taken: Set<string> = new Set(), onNote?: Noted): Promise<string[]> {
  if (!file.size) throw new FileKindError(`${file.name} is empty.`)
  const { sniff, notATable } = await import('./sniff')
  const kind = sniff(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))
  const wrong = notATable(kind, file.name)
  if (wrong) throw new FileKindError(wrong)
  // Tally's own XML (its vouchers, or a report, in an ENVELOPE), in UTF-8: its <BODY> isn't a web page's.
  if ((kind === 'html' || kind === 'text') && /^\s*</.test((await file.slice(0, 1024).text()).replace(/^\uFEFF/, '')) && TALLY.test(await file.slice(0, 8192).text()))
    return ingestTally(file, await textOf(file), taken, onNote)
  if (kind === 'html' || kind === 'xml-sheet') return ingestMarkup(file, kind, taken, onNote)
  if (kind === 'text' && /\.html?$/i.test(file.name)) return ingestMarkup(file, 'html', taken, onNote)
  if (kind === 'text' && /\.xml$/i.test(file.name)) {
    throw new FileKindError(`${file.name} is XML, but not a spreadsheet. Sheetah opens XML saved by Excel (XML Spreadsheet 2003) or Tally; for other XML, export a CSV.`)
  }
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
    // Tally writes its XML in UTF-16 by default; Excel's XML Spreadsheet can be too.
    if (/^\s*</.test(text) && /\.xml$/i.test(file.name)) {
      if (TALLY.test(text.slice(0, 8192))) return ingestTally(file, text, taken, onNote)
      if (/<Workbook\b/.test(text.slice(0, 8192))) return ingestMarkup(file, 'xml-sheet', taken, onNote, text)
    }
    return ingestRead(new File([text], file.name, { type: 'text/plain' }), taken, onNote)
  }
  return ingestRead(file, taken, onNote)
}


function ingestRead(file: File, taken: Set<string>, onNote?: Noted): Promise<string[]> {
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
        const cols = (await columnTypes(name)).map((c) => c.name)
        const sep = cols.length === 1 ? [',', ';', '\t', '|'].find((d) => cols[0].includes(d)) : undefined
        let read = (opts: string) => `read_csv_auto(${quoteLiteral(virtualPath)}${opts ? `, ${opts}` : ''})`
        if (sep) {
          read = (opts) =>
            `read_csv(${quoteLiteral(virtualPath)}, delim = ${quoteLiteral(sep)}, header = true, null_padding = true, strict_mode = false${opts ? `, ${opts}` : ''})`
          await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`)
          onNote?.(`Some rows of ${file.name} have more or fewer fields than its header: missing ones are left empty.`)
        }
        await readDates(name, virtualPath, read)
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
async function ingestExcel(file: File, taken: Set<string>, onNote?: Noted): Promise<string[]> {
  const reply = await parseExcel(file)
  if (!reply.ok) throw reply.plain ? new FileKindError(reply.error) : new Error(reply.error)
  return ingestSheets(file, reply.sheets, taken, onNote)
}

/** An ".xls" that is a web page's table or Excel 2003 XML: read here (the browser parses markup). */
async function ingestMarkup(file: File, kind: 'html' | 'xml-sheet', taken: Set<string>, onNote?: Noted, decoded?: string): Promise<string[]> {
  // The browser builds the whole page in memory (several times the file), and that can't be stopped.
  if (file.size > 50 * 1024 ** 2) throw new FileKindError(`${file.name} is a web page or XML spreadsheet over 50 MB. Save it as CSV or .xlsx and open that.`)
  const { markupToCsv } = await import('./markup-sheets')
  const sheets = markupToCsv(decoded ?? (await textOf(file)), kind)
  if (!sheets.length && kind === 'html') throw new FileKindError(`${file.name} is a web page with no table in it.`)
  return ingestSheets(file, sheets, taken, onNote)
}

/** A note about a file as it opened (title lines left out…), or a check on it (a trial balance's tie-out). */
export type Noted = (note: string, check?: { ok: boolean }) => void

/** Tally's XML: its envelope, or the messages inside one. */
const TALLY = /<ENVELOPE\b|<TALLYMESSAGE\b/i

/** Tally's XML, read as a table: one row per voucher line, or per row of a report. */
async function ingestTally(file: File, source: string, taken: Set<string>, onNote?: Noted): Promise<string[]> {
  if (file.size > 100 * 1024 ** 2) throw new FileKindError(`${file.name} is Tally XML over 100 MB. From Tally, export the report to Excel or CSV instead, and open that.`)
  const { tallyToCsv } = await import('./tally')
  const { sheets, notes } = tallyToCsv(source, file.name)
  if (!sheets.length) throw new FileKindError(`${file.name} is Tally’s own XML, with no vouchers or report rows in it. From Tally, export the report to Excel or CSV instead, and open that.`)
  const names = await ingestSheets(file, sheets, taken, onNote)
  for (const n of notes) onNote?.(n.text, { ok: n.ok })
  return names
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

async function ingestSheets(file: File, sheets: XlsxSheet[], taken: Set<string>, onNote?: Noted): Promise<string[]> {
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
      const read = (opts: string) => `read_csv_auto(${quoteLiteral(path)}, header = true${opts ? `, ${opts}` : ''})`
      try {
        await sendAll(`CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`)
        await readDates(name, path, read).catch((e) => (isCancel(e) ? Promise.reject(e) : undefined))
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
