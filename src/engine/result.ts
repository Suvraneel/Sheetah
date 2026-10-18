import { DataType, type Table } from 'apache-arrow'
import { CancelledError, RESULTS_SCHEMA, ensureExtension, getEngine, isCancel, quoteIdent, quoteLiteral, restorePseudonym, sandboxPath, sendAll, withRunLock } from './db'
import { isNumericType, splitStatements } from './sql'

export { CancelledError, cancelRunning } from './db'
export { splitStatements } from './sql'

export interface ColumnInfo {
  name: string
  type: string
  numeric: boolean
  /**
   * The column's name inside the result table when it differs from `name`. A column called "rowid"
   * would hide DuckDB's row-position pseudo-column, which the grid fetches by, so it is stored renamed.
   */
  ident?: string
  /** Fractions converted from "18%" text: shown, described and filtered as percentages. */
  percent?: boolean
}

/** SQL reference to a column of a result table (see ColumnInfo.ident). */
export const colRef = (c: ColumnInfo) => quoteIdent(c.ident ?? c.name)

export type Row = (string | null)[]

/** Everything the grid needs, whatever produced the rows. */
export interface ResultSet {
  id: number
  sql: string
  rowCount: number
  columns: ColumnInfo[]
  elapsedMs: number
  /** Backing temp table (absent for statements that can't be materialised, e.g. PRAGMA). */
  table?: string
  /** Message for statements that return no rows (CREATE, INSERT, …). */
  message?: string
  fetch(start: number, end: number): Promise<Row[]>
}

export { isNumericType }

function tableToRows(table: Table): { columns: ColumnInfo[]; rows: Row[] } {
  const columns = table.schema.fields.map((f) => {
    const type = String(f.type)
    return { name: f.name, type, numeric: DataType.isInt(f.type) || DataType.isFloat(f.type) || DataType.isDecimal(f.type) }
  })
  const cols = columns.map((_, i) => {
    const v = table.getChildAt(i)
    return v ? Array.from(v as Iterable<unknown>) : []
  })
  const kinds = columns.map((c) => (/^Date/i.test(c.type) ? 'date' : /^Timestamp/i.test(c.type) ? 'ts' : null))
  const rows: Row[] = []
  for (let r = 0; r < table.numRows; r++) {
    rows.push(cols.map((c, i) => formatValue(c[r], kinds[i])))
  }
  return { columns, rows }
}

/** Arrow hands dates and timestamps over as epoch milliseconds; show them the way the grid does. */
function formatValue(v: unknown, kind: 'date' | 'ts' | null = null): string | null {
  if (v === null || v === undefined) return null
  if (kind && (typeof v === 'number' || typeof v === 'bigint')) v = new Date(Number(v))
  if (v instanceof Date && !isNaN(v.getTime())) {
    const iso = v.toISOString()
    return kind === 'date' ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.000Z$|Z$/, '')
  }
  if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
  return String(v)
}

let counter = 0
/** Result tables still alive, newest last. The previous one is kept while the grid swaps over to the new one. */
const alive: string[] = []
/** Result tables in use by long work (an Excel export reads its rows for a while): not dropped until released. */
const held = new Map<string, number>()

async function dropResult(table: string) {
  const { conn } = await getEngine()
  await conn.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {})
}

/** Keeps a result's table while it's read in the background (e.g. exporting); call the returned function when done. */
export function holdResult(result: ResultSet): () => void {
  const table = result.table
  if (!table) return () => {}
  held.set(table, (held.get(table) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (held.get(table) ?? 1) - 1
    if (n > 0) return void held.set(table, n)
    held.delete(table)
    if (!alive.includes(table)) void dropResult(table)
  }
}

/** DuckDB quotes the statement it failed on; for our wrapper that would show SQL the user never wrote. */
function stripWrapper(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e))
  // DuckDB quotes the line it stopped at: ours (the result table around the query), not the user's.
  if (/__sheetah\.result_\d+|LINE \d+:.*\bAS SELECT \* FROM \(/.test(err.message)) err.message = err.message.replace(/\n+LINE \d+:[\s\S]*$/, '').trim()
  return err
}

/** Errors that mean "this statement can't be wrapped in a query" (or is malformed), so it's worth running as written. */
const runAsWritten = (e: unknown) => /^(Parser|Binder|Catalog) Error/.test(e instanceof Error ? e.message : String(e))

/**
 * Runs a script. The last statement, if it's a query, is materialised into a result table so the
 * grid can fetch any window of rows by rowid (fast at any depth, unlike OFFSET). Scripts run one at a
 * time, and every statement can be cancelled.
 */
export function runSql(sql: string, opts: { isCurrent?: () => boolean } = {}): Promise<ResultSet> {
  return withRunLock(async () => {
    // Queued behind a file load or another query and superseded meanwhile: don't run it at all.
    if (opts.isCurrent && !opts.isCurrent()) throw new CancelledError()
    return runLocked(sql)
  }, 'query')
}

async function runLocked(sql: string): Promise<ResultSet> {
  const { runConn } = await getEngine()
  const statements = splitStatements(sql)
  if (!statements.length) throw new Error('Nothing to run. Type a query first.')
  const started = performance.now()
  // An earlier script may have redefined pseudonym() or its key; anonymizing always uses the real ones.
  if (/\bpseudonym\s*\(/i.test(sql)) await restorePseudonym()

  for (const s of statements.slice(0, -1)) await sendAll(s)
  const last = statements[statements.length - 1]
  const id = ++counter
  const table = `${RESULTS_SCHEMA}.result_${id}`

  try {
    // The newline keeps a trailing "-- comment" from swallowing the closing parenthesis.
    await sendAll(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM (${last}\n)`)
  } catch (e) {
    if (isCancel(e)) throw new CancelledError()
    if (!runAsWritten(e)) throw stripWrapper(e)
    // Not a query (CREATE / INSERT / PRAGMA …) or a mistake in it: run it as written, so the user
    // gets DuckDB's own message about their SQL rather than about our wrapper.
    const raw = await sendAll(last)
    if (raw.schema.fields.length) {
      // Keep it as a real result table when DuckDB can take the rows back, so export, charts and pivots work.
      try {
        await runConn.insertArrowTable(raw, { schema: RESULTS_SCHEMA, name: `result_${id}`, create: true })
        return await materialised(id, table, last, started)
      } catch {
        /* exotic types: fall through to the in-memory rows */
      }
    }
    const elapsedMs = performance.now() - started
    const { columns, rows } = tableToRows(raw)
    return {
      id,
      sql: last,
      rowCount: rows.length,
      columns,
      elapsedMs,
      message: columns.length ? undefined : 'Done. The statement ran and returned no rows.',
      fetch: async (s, e) => rows.slice(s, e),
    }
  }
  return materialised(id, table, last, started)
}

/** Called inside the run lock: the result table is inspected on runConn, after everything queued before it. */
async function materialised(id: number, table: string, sql: string, started: number): Promise<ResultSet> {
  const { conn } = await getEngine()
  let columns: ColumnInfo[]
  let rowCount: number
  try {
    const describe = await sendAll(`DESCRIBE ${table}`)
    columns = describe.toArray().map((r) => {
      const { column_name, column_type } = r.toJSON() as { column_name: string; column_type: string }
      return { name: column_name, type: column_type, numeric: isNumericType(column_type) }
    })
    // A real column named rowid would shadow the row position the grid relies on: store it renamed.
    for (const c of columns) {
      if (c.name.toLowerCase() !== 'rowid') continue
      c.ident = `__sheetah_${c.name}`
      await sendAll(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(c.name)} TO ${quoteIdent(c.ident)}`)
    }
    const countRes = await sendAll(`SELECT count(*)::DOUBLE AS n FROM ${table}`)
    rowCount = Number(countRes.toArray()[0]?.toJSON().n ?? 0)
  } catch (e) {
    // Cancelled (or failed) after the table was made: don't leave a full copy of the rows behind.
    void dropResult(table)
    throw isCancel(e) ? new CancelledError() : e
  }
  const elapsedMs = performance.now() - started

  // Free older results' memory (the one on screen stays until this one replaces it; held ones until released).
  alive.push(table)
  while (alive.length > 2) {
    const old = alive.shift()!
    if (!held.has(old)) void dropResult(old)
  }

  const select = columns.length ? columns.map((c) => `${colRef(c)}::VARCHAR`).join(', ') : '*'

  return {
    id,
    sql,
    table,
    rowCount,
    columns,
    elapsedMs,
    async fetch(start, end) {
      const res = await conn.query(`SELECT ${select} FROM ${table} WHERE rowid >= ${start} AND rowid < ${end} ORDER BY rowid`)
      const vecs = columns.map((_, i) => res.getChildAt(i))
      const out: Row[] = new Array(res.numRows)
      for (let r = 0; r < res.numRows; r++) {
        const row: Row = new Array(columns.length)
        for (let c = 0; c < columns.length; c++) {
          const v = vecs[c]?.get(r)
          row[c] = v === null || v === undefined ? null : String(v)
        }
        out[r] = row
      }
      return out
    },
  }
}

/* ------------------------------ Aggregates & profiles ------------------------------ */

export interface RangeStats {
  count: number
  numericCount: number
  sum: number | null
  avg: number | null
  min: number | null
  max: number | null
}

/** Spreadsheet-style status bar numbers for a selected block, computed by SQL (works on 1M rows). */
export async function rangeStats(result: ResultSet, cols: ColumnInfo[], r0: number, r1: number): Promise<RangeStats | null> {
  if (!result.table || !cols.length) return null
  const { conn } = await getEngine()
  const numeric = cols.filter((c) => c.numeric)
  const where = `rowid BETWEEN ${r0} AND ${r1}`
  const counts = cols.map((c) => `count(${colRef(c)})`).join(' + ')
  let sql = `SELECT (${counts})::DOUBLE AS count`
  if (numeric.length) {
    const vals = numeric.map((c) => `${colRef(c)}::DOUBLE`)
    const unpivot = vals.length === 1 ? vals[0] : `unnest([${vals.join(', ')}])`
    sql = `WITH v AS (SELECT ${unpivot} AS x FROM ${result.table} WHERE ${where}),
           c AS (${sql} FROM ${result.table} WHERE ${where})
           SELECT c.count, count(x)::DOUBLE AS n, sum(x) AS sum, avg(x) AS avg, min(x) AS min, max(x) AS max FROM v, c GROUP BY c.count`
  } else {
    sql += ` FROM ${result.table} WHERE ${where}`
  }
  const row = (await conn.query(sql)).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
  if (!row) return null
  return {
    count: Number(row.count ?? 0),
    numericCount: Number(row.n ?? 0),
    sum: row.sum ?? null,
    avg: row.avg ?? null,
    min: row.min ?? null,
    max: row.max ?? null,
  }
}

/** Row n (1-based, in the query's own order) of a query, every column as text, with the columns' names. */
export async function rowOf(sql: string, n: number): Promise<{ columns: string[]; values: (string | null)[] } | null> {
  const { conn } = await getEngine()
  const table = await conn.query(`SELECT * EXCLUDE (__sheetah_row) FROM (SELECT *, row_number() OVER () AS __sheetah_row FROM (\n${sql}\n)) WHERE __sheetah_row = ${Math.floor(n)}`)
  const columns = table.schema.fields.map((f) => f.name)
  const row = table.toArray()[0]?.toJSON() as Record<string, unknown> | undefined
  if (!row) return null
  return { columns, values: columns.map((c) => (row[c] === null || row[c] === undefined ? null : String(row[c]))) }
}

/* ------------------------------------ Export ------------------------------------ */

/**
 * CSV "formula injection": a text cell like =HYPERLINK(...) or +cmd|... runs as a formula when the CSV
 * is opened in a spreadsheet app. Excel-safe export prefixes such text cells with an apostrophe.
 */
const FORMULA_START = `'^[=+\\-@\\t\\r]'`

export async function exportResult(result: ResultSet, format: 'csv' | 'parquet', opts: { excelSafe?: boolean } = {}): Promise<Blob> {
  if (!result.table) throw new Error('This result can’t be exported.')
  const { db, conn } = await getEngine()
  if (format === 'parquet') await ensureExtension('parquet')
  const file = sandboxPath(`export_${result.id}.${format}`)
  const copyOpts = format === 'csv' ? '(HEADER, DELIMITER \',\')' : '(FORMAT PARQUET, COMPRESSION ZSTD)'
  // In Excel-safe mode, text-like columns (VARCHAR, ENUM, JSON) that would start a formula get a quote in
  // front (not a plain number: a refund of -12.50 stays a number), and doubles are written to the 15
  // significant digits Excel keeps (519314.16, not a sum's 519314.16000000003). Everything keeps its own name.
  const safe = format === 'csv' && opts.excelSafe
  const cols = result.columns
    .map((c) => {
      const ref = colRef(c)
      const out = quoteIdent(c.name)
      if (safe && /^(VARCHAR|ENUM|JSON)/i.test(c.type)) {
        const v = `${ref}::VARCHAR`
        // A plain negative (−12.50, −1,200): not a phone number written +91…, which Excel would turn into 9.19877E+11.
        return `CASE WHEN regexp_matches(${v}, ${FORMULA_START}) AND NOT regexp_full_match(${v}, '-([0-9]{1,3}(,[0-9]{3})+|[0-9]{1,15})(\\.[0-9]+)?') THEN '''' || ${v} ELSE ${v} END AS ${out}`
      }
      if (safe && /^(DOUBLE|FLOAT|REAL)$/i.test(c.type)) {
        return `CASE WHEN ${ref} = 0 OR NOT isfinite(${ref}) THEN ${ref} ELSE round(${ref}, 14 - floor(log10(abs(${ref})))::INTEGER) END AS ${out}`
      }
      return ref === out ? ref : `${ref} AS ${out}`
    })
    .join(', ')
  let buf: Uint8Array
  try {
    await conn.query(`COPY (SELECT ${cols || '*'} FROM ${result.table} ORDER BY rowid) TO ${quoteLiteral(file)} ${copyOpts}`)
    buf = await db.copyFileToBuffer(file)
  } finally {
    await db.dropFile(file).catch(() => {})
  }
  // A byte-order mark, so Excel reads the file as UTF-8 (René, £12.50) rather than its own code page.
  const parts: BlobPart[] = safe ? [new Uint8Array([0xef, 0xbb, 0xbf]), buf as Uint8Array<ArrayBuffer>] : [buf as Uint8Array<ArrayBuffer>]
  return new Blob(parts, { type: format === 'csv' ? 'text/csv' : 'application/vnd.apache.parquet' })
}
