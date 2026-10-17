import { DataType, type Table } from 'apache-arrow'
import { CancelledError, RESULTS_SCHEMA, ensureExtension, getEngine, isCancel, quoteIdent, quoteLiteral, restorePseudonym, sandboxPath, sendAll, withRunLock } from './db'
import { confidentConversion, dataSumsSql, eitherJunk, fillDownSql, isTextColumn, looksFilledDown, junkPredicates, labelSumsSql, totalsAgree, readStats, statsSql, suggestCleaning, type Clean, type CleanSuggestion, type DropRows } from './clean'
import { LOCALE, isNumericType, splitStatements } from './sql'

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

export interface ColumnProfile {
  column: ColumnInfo
  nonNull: number
  nulls: number
  distinct: number
  /** False when `distinct` is an estimate (very large results). */
  distinctExact: boolean
  min: string | null
  max: string | null
  sum: number | null
  avg: number | null
  top: { value: string | null; count: number }[]
}

export async function profileColumn(result: ResultSet, column: ColumnInfo): Promise<ColumnProfile | null> {
  if (!result.table) return null
  const { conn } = await getEngine()
  const c = colRef(column)
  // Exact up to a million rows (fast enough); beyond that an estimate, which can be off by a fifth.
  const exact = result.rowCount <= 1_000_000
  const distinct = exact ? `count(DISTINCT ${c})` : `least(approx_count_distinct(${c}), count(${c})) /* the estimate can overshoot */`
  const stats = (
    await conn.query(`SELECT count(${c})::DOUBLE AS non_null, (count(*) - count(${c}))::DOUBLE AS nulls,
      ${distinct}::DOUBLE AS distinct_n, min(${c})::VARCHAR AS min, max(${c})::VARCHAR AS max
      ${column.numeric ? `, avg(${c})::DOUBLE AS avg, sum(${c})::DOUBLE AS sum` : ''} FROM ${result.table}`)
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
    distinctExact: exact,
    min: (stats.min as string | null) ?? null,
    max: (stats.max as string | null) ?? null,
    sum: column.numeric && stats.sum != null ? Number(stats.sum) : null,
    avg: column.numeric && stats.avg != null ? Number(stats.avg) : null,
    top,
  }
}

/** Rows that aren't data in a freshly opened table: completely empty rows and total lines. */
/**
 * Date columns that could have been read the other way round: every day is the 12th or before, so
 * 01/02/2024 could be 1 February or January 2nd.
 */
export async function ambiguousDates(result: ResultSet): Promise<string[]> {
  const dates = result.columns.filter((c) => c.type === 'DATE')
  if (!result.table || !dates.length) return []
  const { conn } = await getEngine()
  const row = (await conn.query(`SELECT ${dates.map((c, i) => `max(day(${colRef(c)}))::DOUBLE AS d${i}, count(${colRef(c)})::DOUBLE AS n${i}`).join(', ')} FROM ${result.table}`)).toArray()[0]?.toJSON() as
    | Record<string, number | null>
    | undefined
  return row ? dates.filter((_, i) => Number(row[`n${i}`]) > 1 && Number(row[`d${i}`]) <= 12).map((c) => c.name) : []
}

const emptyScans = new WeakMap<ResultSet, Promise<string[]>>()

/**
 * Text columns with nothing in any row (an export's empty first column, a spacer): no use as labels or
 * data. Never every column (that's an empty table, not empty columns). Looked for in a sample first, then
 * confirmed on every row for the few candidates; asked once per result (several scans want it).
 */
export function emptyTextColumns(result: ResultSet): Promise<string[]> {
  const known = emptyScans.get(result)
  if (known) return known
  const scan = (async () => {
    const texts = result.columns.filter((c) => isTextColumn(c.type))
    if (!result.table || !texts.length || result.columns.length < 2 || result.rowCount === 0) return []
    const { conn } = await getEngine()
    const filled = async (cols: ColumnInfo[], from: string) => {
      const row = (await conn.query(`SELECT ${cols.map((c, i) => `count(nullif(trim(${colRef(c)}::VARCHAR), ''))::DOUBLE AS f${i}`).join(', ')} FROM ${from}`)).toArray()[0]?.toJSON() as
        | Record<string, number>
        | undefined
      return row ? cols.filter((_, i) => Number(row[`f${i}`]) === 0) : []
    }
    const sampled = result.rowCount > 100_000 ? await filled(texts, `(SELECT * FROM ${result.table} USING SAMPLE 20000 ROWS)`) : texts
    const empty = sampled.length ? await filled(sampled, result.table) : []
    return empty.length < result.columns.length ? empty.map((c) => c.name) : []
  })()
  emptyScans.set(result, scan)
  return scan
}

/**
 * Total lines in a big table (a year of a register, half a million rows and more): only the rows that
 * mention "total" are looked at (one quick pass), for "Sub-total" and "Grand Total" lines and short
 * "Total" lines. Empty rows and full "Total" lines that need their sums checked are left to smaller tables.
 */
async function bigTableTotals(result: ResultSet): Promise<DropRows[]> {
  const texts = result.columns.filter((c) => isTextColumn(c.type))
  if (!result.table || !texts.length) return []
  const { conn } = await getEngine()
  const p = junkPredicates(result.columns.map((c) => ({ ref: colRef(c), text: isTextColumn(c.type) })))
  if (!p.strong || !p.weak) return []
  const mentions = texts.map((c) => `${colRef(c)}::VARCHAR ILIKE '%total%'`).join(' OR ')
  const row = (
    await conn.query(`SELECT count(*) FILTER (WHERE ${p.strong.drop})::DOUBLE AS strong, count(*) FILTER (WHERE ${eitherJunk(p.strong, p.weak).drop})::DOUBLE AS total FROM (SELECT * FROM ${result.table} WHERE ${mentions})`)
  ).toArray()[0]?.toJSON() as { strong: number; total: number } | undefined
  const named = junkPredicates(result.columns.map((c) => ({ ref: quoteIdent(c.name), text: isTextColumn(c.type) })))
  if (!row || !named.strong || !named.weak) return []
  const strong = Number(row.strong)
  const total = Number(row.total)
  const weakOk = total - strong <= Math.max(3, result.rowCount * 0.1)
  const n = weakOk ? total : strong
  if (!n) return []
  return [{ label: `${n.toLocaleString(LOCALE)} total line${n === 1 ? '' : 's'}`, keep: (weakOk ? eitherJunk(named.strong, named.weak) : named.strong).keep }]
}

export async function junkRows(result: ResultSet): Promise<DropRows[]> {
  if (!result.table || !result.columns.length) return []
  // Scanning every value of a big table would hold the engine for seconds: a quick check for total lines only.
  if (result.rowCount > 500_000) return result.rowCount <= 5_000_000 ? bigTableTotals(result) : []
  const { conn } = await getEngine()
  // An empty first column (some exports start with one) would hide the labels in the next: left out.
  const empty = new Set(await emptyTextColumns(result))
  const columns = result.columns.filter((c) => !empty.has(c.name))
  if (!columns.length) return []
  const refs = columns.map((c) => ({ ref: colRef(c), text: isTextColumn(c.type), numeric: c.numeric }))
  const p = junkPredicates(refs)
  const counts = [`count(*) FILTER (WHERE ${p.blank.drop})::DOUBLE AS blank`]
  if (p.strong && p.weak && p.label)
    counts.push(
      `count(*) FILTER (WHERE ${p.strong.drop})::DOUBLE AS strong`,
      `count(*) FILTER (WHERE ${eitherJunk(p.strong, p.weak).drop})::DOUBLE AS total`,
      `count(*) FILTER (WHERE ${eitherJunk(p.strong, p.label).drop})::DOUBLE AS labelled`,
    )
  const row = (await conn.query(`SELECT ${counts.join(', ')} FROM ${result.table}`)).toArray()[0]?.toJSON() as
    | { blank: number; strong?: number; total?: number; labelled?: number }
    | undefined
  if (!row) return []
  // The same predicates written against the columns' own names, for the composed query.
  const named = junkPredicates(columns.map((c) => ({ ref: quoteIdent(c.name), text: isTextColumn(c.type) })))
  const out: DropRows[] = []
  const n = (x: number, one: string) => `${x.toLocaleString(LOCALE)} ${one}${x === 1 ? '' : 's'}`
  const strong = Number(row.strong ?? 0)
  let total = Number(row.total ?? 0)
  let totals = named.strong && named.weak ? eitherJunk(named.strong, named.weak) : null
  let totalsHere = p.strong && p.weak ? eitherJunk(p.strong, p.weak) : null // the same, on the result table
  // "Total" lines with nothing empty in them (Region, Sales / Total, 2000): trusted when they add up, and
  // while they're at most a quarter of the rows (a census's both-sexes rows add up too, by construction).
  const labelled = Number(row.labelled ?? 0)
  let verified = false
  const labelSql = p.label && p.first ? labelSumsSql(result.table, refs, p.label, p.first) : null
  if (labelled > total && labelled <= result.rowCount * 0.25 && labelSql && p.strong && p.label && p.first && named.strong && named.label) {
    const t = (await conn.query(labelSql)).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
    const which = Object.keys(t ?? {})
      .filter((k) => typeof t![k] === 'number')
      .map((k) => Number(k.slice(1)))
    if (t && which.length) {
      const keep = `${p.label.keep} AND ${p.strong.keep} AND ${p.blank.keep}`
      const d = (await conn.query(dataSumsSql(result.table, refs, p.first, which, keep))).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
      const pairs = which.filter((i) => typeof d?.[`d${i}`] === 'number').map((i) => ({ t: t[`t${i}`] as number, d: d![`d${i}`] as number }))
      if (totalsAgree(pairs)) {
        verified = true
        total = labelled
        totals = eitherJunk(named.strong, named.label)
        totalsHere = eitherJunk(p.strong, p.label)
      }
    }
  }
  // Plain "Total" lines are trusted when they add up, or while they're a few; a lot of them that don't add
  // up is a real value (a category called Total).
  const weakOk = verified || total - strong <= Math.max(3, result.rowCount * 0.1)
  if (totals && named.strong && (weakOk ? total : strong)) {
    // Tie-out: the total lines' numbers against the rows they'd leave (sub-totals and a grand total
    // come to twice them). Said on the suggestion, so leaving them out is a checked step, not a guess.
    let checked: DropRows['checked']
    const here = weakOk ? totalsHere : p.strong
    if (here && p.first) {
      const sums = labelSumsSql(result.table, refs, here, p.first)
      const t = sums ? ((await conn.query(sums)).toArray()[0]?.toJSON() as Record<string, number | null> | undefined) : undefined
      const which = Object.keys(t ?? {}).filter((k) => typeof t![k] === 'number').map((k) => Number(k.slice(1)))
      if (t && which.length) {
        const d = (await conn.query(dataSumsSql(result.table, refs, p.first, which, `${here.keep} AND ${p.blank.keep}`))).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
        const pairs = which.filter((i) => typeof d?.[`d${i}`] === 'number').map((i) => ({ i, t: t[`t${i}`] as number, d: d![`d${i}`] as number }))
        const others = columns.filter((_, k) => refs[k].ref !== p.first)
        // The column people check first: the one that adds up with the largest sum (the amount).
        const best = pairs.filter((x) => totalsAgree([x])).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0]
        if (totalsAgree(pairs) && best && others[best.i]) checked = { column: others[best.i].name, sum: best.d }
      }
    }
    out.push({ label: n(weakOk ? total : strong, 'total line'), keep: (weakOk ? totals : named.strong).keep, ...(checked ? { checked } : {}) })
  }
  if (row.blank) out.push({ label: n(Number(row.blank), 'empty row'), keep: named.blank.keep })
  return out
}

/**
 * Columns to fill down: a report's group names, written once at the top of each group. Only the first
 * columns, from the left (Region, then Branch within it): group names lead, and a column further right
 * with gaps is more likely filled in now and then.
 */
export async function fillDownColumns(result: ResultSet): Promise<string[]> {
  if (!result.table || result.columns.length < 2 || result.rowCount < 6 || result.rowCount > 500_000) return []
  const { conn } = await getEngine()
  const refs = result.columns.map(colRef)
  // An empty leading column (some exports start with one) doesn't count as one of the first.
  const empty = new Set(await emptyTextColumns(result))
  const out: string[] = []
  for (const c of result.columns.filter((x) => !empty.has(x.name)).slice(0, 3)) {
    const i = result.columns.indexOf(c)
    if (!isTextColumn(c.type) || i === result.columns.length - 1) break
    const s = (await conn.query(fillDownSql(result.table, refs[i], refs))).toArray()[0]?.toJSON() as Parameters<typeof looksFilledDown>[0] | undefined
    if (!s || !looksFilledDown({ ...s, n: Number(s.n), filled: Number(s.filled), pairs: Number(s.pairs), len: Number(s.len) })) break
    out.push(c.name)
  }
  return out
}

/**
 * The row the column names are really on, when the file reader didn't find them: most columns got
 * made-up names (column1, column_2: their header cells were empty, because titles sat above the
 * names), and one of the first rows is all different words (Invoice, Customer, Amount), not numbers.
 */
export async function namesRow(result: ResultSet): Promise<number | null> {
  const made = result.columns.filter((c) => /^column_?\d+$/i.test(c.name)).length
  if (result.columns.length < 2 || made < Math.ceil((result.columns.length - 1) / 2) || !result.rowCount) return null
  // A column the reader typed as dates or yes/no can't hold a column name: this file has no names row
  // (a headerless file of data, whose columns got numbered).
  if (result.columns.some((c) => /^(DATE|TIMESTAMP|BOOLEAN|TIME)/i.test(c.type.trim()))) return null
  const rows = await result.fetch(0, Math.min(10, result.rowCount))
  const year = (v: string) => /^(19|20)\d{2}$/.test(v)
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((v) => (v ?? '').trim())
    const filled = cells.filter(Boolean)
    // Words in text columns; in number columns only a year (Region, 2022, 2023, 2024) can be a name.
    const nameLike = cells.every((c, i) => !c || (result.columns[i].numeric ? year(c) : !/^[-+₹$€£¥(]?[\d.,\s]+%?\)?$/.test(c) || year(c)))
    const enough = filled.length >= Math.max(2, Math.ceil(cells.length / 2))
    if (nameLike && enough && new Set(filled.map((c) => c.toLowerCase())).size === filled.length) return r
  }
  return null
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

/** Which of these columns of a query have nothing in them (an export's months not reached yet). */
export async function emptyColumns(sql: string, columns: string[]): Promise<string[]> {
  if (!columns.length) return []
  const { conn } = await getEngine()
  const row = (await conn.query(`SELECT ${columns.map((c, i) => `count(${quoteIdent(c)})::DOUBLE AS c${i}`).join(', ')} FROM (\n${sql}\n)`)).toArray()[0]?.toJSON() as
    | Record<string, number>
    | undefined
  return row ? columns.filter((_, i) => Number(row[`c${i}`]) === 0) : []
}

/** How many pieces a text column splits into at `delim` (the most in any row, capped at 8). */
export async function splitParts(result: ResultSet, column: ColumnInfo, delim: string): Promise<number> {
  if (!result.table || !delim) return 0
  const { conn } = await getEngine()
  const row = (
    await conn.query(`SELECT max(len(string_split(${colRef(column)}::VARCHAR, ${quoteLiteral(delim)})))::DOUBLE AS n FROM ${result.table}`)
  ).toArray()[0]?.toJSON() as { n: number | null } | undefined
  return Math.min(8, Number(row?.n ?? 0))
}

/** Ways to clean a text column (convert to number or date, trim…), judged on a sample of its values. */
export async function cleaningFor(result: ResultSet, column: ColumnInfo, locale = navigator.language): Promise<CleanSuggestion[]> {
  if (!result.table || !isTextColumn(column.type)) return []
  const { conn } = await getEngine()
  const row = (await conn.query(statsSql(result.table, [colRef(column)]))).toArray()[0]?.toJSON() as Record<string, unknown> | undefined
  return row ? suggestCleaning(column.name, readStats(row, 0), locale) : []
}

/**
 * Text columns looked over once, in one query over one sample however many columns: numbers or dates
 * stored as text (typically from Excel), to convert; and names typed with stray spaces (" asha rao ",
 * "Kabir  Khan"), to tidy: they group and look up as different values.
 */
export async function textFindings(result: ResultSet, locale = navigator.language): Promise<{ convert: Clean[]; spaces: string[] }> {
  const cols = result.columns.filter((c) => isTextColumn(c.type)).slice(0, 40)
  if (!result.table || !cols.length) return { convert: [], spaces: [] }
  const { conn } = await getEngine()
  const row = (await conn.query(statsSql(result.table, cols.map(colRef)))).toArray()[0]?.toJSON() as Record<string, unknown> | undefined
  if (!row) return { convert: [], spaces: [] }
  const stats = cols.map((c, i) => ({ c, s: readStats(row, i) }))
  const convert = stats.map(({ c, s }) => confidentConversion(suggestCleaning(c.name, s, locale))).filter((c): c is Clean => !!c)
  const converted = new Set(convert.map((c) => c.column))
  const spaces = stats.filter(({ c, s }) => s.untrimmed > 0 && !converted.has(c.name)).map(({ c }) => c.name)
  return { convert, spaces }
}

/** A text column's distinct values with their rows, most first (up to `limit`): for spotting one value written two ways. */
export async function distinctValues(result: ResultSet, column: ColumnInfo, limit = 400): Promise<{ value: string | null; count: number }[]> {
  if (!result.table) return []
  const { conn } = await getEngine()
  const c = colRef(column)
  const res = await conn.query(`SELECT ${c}::VARCHAR AS v, count(*)::DOUBLE AS n FROM ${result.table} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${Math.floor(limit)}`)
  return res.toArray().map((r) => {
    const o = r.toJSON() as { v: string | null; n: number }
    return { value: o.v, count: Number(o.n) }
  })
}

/** Most common values of a column in any query (used to list choices without the column's own filter). */
export async function topValues(sql: string, column: string, limit = 12): Promise<{ value: string | null; count: number }[]> {
  const { conn } = await getEngine()
  const c = quoteIdent(column)
  const res = await conn.query(`SELECT ${c}::VARCHAR AS v, count(*)::DOUBLE AS n FROM (\n${sql}\n) GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`)
  return res.toArray().map((r) => {
    const o = r.toJSON() as { v: string | null; n: number }
    return { value: o.v, count: Number(o.n) }
  })
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
  // Text-like columns (VARCHAR, ENUM, JSON) are cleaned in Excel-safe mode; everything keeps its own name.
  const cols = result.columns
    .map((c) => {
      const ref = colRef(c)
      const out = quoteIdent(c.name)
      if (format === 'csv' && opts.excelSafe && /^(VARCHAR|ENUM|JSON)/i.test(c.type)) {
        return `CASE WHEN regexp_matches(${ref}::VARCHAR, ${FORMULA_START}) THEN '''' || ${ref}::VARCHAR ELSE ${ref}::VARCHAR END AS ${out}`
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
  return new Blob([buf as Uint8Array<ArrayBuffer>], { type: format === 'csv' ? 'text/csv' : 'application/vnd.apache.parquet' })
}
