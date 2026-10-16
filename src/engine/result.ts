import type { Table } from 'apache-arrow'
import { ensureExtension, getEngine, quoteIdent, quoteLiteral, sandboxPath } from './db'

export interface ColumnInfo {
  name: string
  type: string
  numeric: boolean
}

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

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i
export const isNumericType = (t: string) => NUMERIC.test(t)

export class CancelledError extends Error {
  constructor() {
    super('Query cancelled.')
  }
}
const isCancel = (e: unknown) => /query was cancel/i.test(e instanceof Error ? e.message : String(e))

/** Interrupts the query currently running in runSql (if any). */
export async function cancelRunning(): Promise<boolean> {
  const { conn } = await getEngine()
  return conn.cancelSent()
}

/** Splits a script into statements, respecting quotes and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (!quote && ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      cur += sql.slice(i, stop)
      i = stop - 1
      continue
    }
    if (!quote && ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      cur += sql.slice(i, stop)
      i = stop - 1
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === ';') {
      if (stripComments(cur).trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (stripComments(cur).trim()) out.push(cur.trim())
  return out
}

const stripComments = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

function tableToRows(table: Table): { columns: ColumnInfo[]; rows: Row[] } {
  const columns = table.schema.fields.map((f) => {
    const type = String(f.type)
    return { name: f.name, type, numeric: /Int|Float|Decimal/.test(type) }
  })
  const cols = columns.map((_, i) => {
    const v = table.getChildAt(i)
    return v ? Array.from(v as Iterable<unknown>) : []
  })
  const rows: Row[] = []
  for (let r = 0; r < table.numRows; r++) {
    rows.push(cols.map((c) => formatValue(c[r])))
  }
  return { columns, rows }
}

function formatValue(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('.000Z', '')
  if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
  return String(v)
}

let counter = 0
let previous: string | undefined

/**
 * Runs a script. The last statement, if it's a query, is materialised into a temp table so the
 * grid can fetch any window of rows by rowid (fast at any depth, unlike OFFSET).
 */
export async function runSql(sql: string): Promise<ResultSet> {
  const { conn } = await getEngine()
  const statements = splitStatements(sql)
  if (!statements.length) throw new Error('Nothing to run. Type a query first.')
  const started = performance.now()

  for (const s of statements.slice(0, -1)) await conn.query(s)
  const last = statements[statements.length - 1]
  const id = ++counter
  const table = `__result_${id}`

  try {
    // send() (not query()) so the statement can be interrupted with cancelRunning().
    await conn.send(`CREATE OR REPLACE TEMP TABLE ${table} AS SELECT * FROM (${last})`)
  } catch (e) {
    if (isCancel(e)) throw new CancelledError()
    // Not a query (CREATE / INSERT / PRAGMA …) or a genuine error: run it as written so
    // the user sees DuckDB's own error message, not one about our wrapper.
    let raw
    try {
      raw = await conn.query(last)
    } catch (err) {
      if (isCancel(err)) throw new CancelledError()
      throw err
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

  const [countRes, describe] = await Promise.all([
    conn.query(`SELECT count(*)::DOUBLE AS n FROM ${table}`),
    conn.query(`DESCRIBE ${table}`),
  ])
  const rowCount = Number(countRes.toArray()[0]?.toJSON().n ?? 0)
  const columns: ColumnInfo[] = describe.toArray().map((r) => {
    const { column_name, column_type } = r.toJSON() as { column_name: string; column_type: string }
    return { name: column_name, type: column_type, numeric: isNumericType(column_type) }
  })
  const elapsedMs = performance.now() - started

  // Free the previous result's memory.
  if (previous) void conn.query(`DROP TABLE IF EXISTS ${previous}`).catch(() => {})
  previous = table

  const select = columns.length
    ? columns.map((c) => `${quoteIdent(c.name)}::VARCHAR`).join(', ')
    : '*'

  return {
    id,
    sql: last,
    table,
    rowCount,
    columns,
    elapsedMs,
    async fetch(start, end) {
      const res = await conn.query(
        `SELECT ${select} FROM ${table} WHERE rowid >= ${start} AND rowid < ${end} ORDER BY rowid`,
      )
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
  const counts = cols.map((c) => `count(${quoteIdent(c.name)})`).join(' + ')
  let sql = `SELECT (${counts})::DOUBLE AS count`
  if (numeric.length) {
    const vals = numeric.map((c) => `${quoteIdent(c.name)}::DOUBLE`)
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

export interface ColumnProfile {
  column: ColumnInfo
  nonNull: number
  nulls: number
  distinct: number
  min: string | null
  max: string | null
  avg: number | null
  top: { value: string | null; count: number }[]
}

export async function profileColumn(result: ResultSet, column: ColumnInfo): Promise<ColumnProfile | null> {
  if (!result.table) return null
  const { conn } = await getEngine()
  const c = quoteIdent(column.name)
  const stats = (
    await conn.query(`SELECT count(${c})::DOUBLE AS non_null, (count(*) - count(${c}))::DOUBLE AS nulls,
      approx_count_distinct(${c})::DOUBLE AS distinct_n, min(${c})::VARCHAR AS min, max(${c})::VARCHAR AS max
      ${column.numeric ? `, avg(${c})::DOUBLE AS avg` : ''} FROM ${result.table}`)
  ).toArray()[0]?.toJSON() as Record<string, unknown>
  const top = (
    await conn.query(`SELECT ${c}::VARCHAR AS v, count(*)::DOUBLE AS n FROM ${result.table} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`)
  )
    .toArray()
    .map((r) => {
      const o = r.toJSON() as { v: string | null; n: number }
      return { value: o.v, count: Number(o.n) }
    })
  return {
    column,
    nonNull: Number(stats.non_null ?? 0),
    nulls: Number(stats.nulls ?? 0),
    distinct: Number(stats.distinct_n ?? 0),
    min: (stats.min as string | null) ?? null,
    max: (stats.max as string | null) ?? null,
    avg: column.numeric ? Number(stats.avg ?? 0) : null,
    top,
  }
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
  const cols =
    format === 'csv' && opts.excelSafe
      ? result.columns
          .map((c) => {
            const q = quoteIdent(c.name)
            return /^VARCHAR/i.test(c.type) ? `CASE WHEN regexp_matches(${q}, ${FORMULA_START}) THEN '''' || ${q} ELSE ${q} END AS ${q}` : q
          })
          .join(', ')
      : '*'
  await conn.query(`COPY (SELECT ${cols} FROM ${result.table} ORDER BY rowid) TO ${quoteLiteral(file)} ${copyOpts}`)
  const buf = await db.copyFileToBuffer(file)
  await db.dropFile(file)
  return new Blob([buf as Uint8Array<ArrayBuffer>], { type: format === 'csv' ? 'text/csv' : 'application/vnd.apache.parquet' })
}
