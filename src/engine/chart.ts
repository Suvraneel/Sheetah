import { getEngine, quoteIdent, quoteLiteral } from './db'
import { LOCALE, isTemporal, nameKey } from './sql'
import { colRef, splitStatements, type ColumnInfo, type ResultSet } from './result'

/*
 * Quick charts. Every number is computed by DuckDB over the full result (not a sample), so a chart of
 * 10M rows costs one GROUP BY. The chart reads one measure on one axis; "Open as query" gives the
 * table-view twin of any chart as plain SQL.
 */
export type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max'
export const AGGS: { id: Agg; label: string }[] = [
  { id: 'count', label: 'Count of rows' },
  { id: 'sum', label: 'Sum' },
  { id: 'avg', label: 'Average' },
  { id: 'min', label: 'Minimum' },
  { id: 'max', label: 'Maximum' },
]

export interface ChartSpec {
  x: string
  y: string | null
  agg: Agg
  /** For a time axis: the period each point covers (picked from the span when not given). */
  grain?: TimeGrain
  /** A column whose values each get a line, or a part of each bar (Region, Status). */
  split?: string | null
  /** Each number column summed as a series of its own (a pivot's columns: Food, Rent, Travel). */
  each?: boolean
}

export interface Point {
  label: string
  value: number
  /** Bin edges for histograms. */
  lo?: number
  hi?: number
  /** Split: the measure for each series, in the order of ChartData.series (null where it has no rows). */
  values?: (number | null)[]
}

/** Series shown when a chart is split: the largest five and the rest as one, or six when there are six. */
export const MAX_SERIES = 6

export interface ChartData {
  kind: 'bar' | 'line' | 'hist'
  points: Point[]
  /** Distinct groups before the top-N cut (bar charts). */
  groups: number
  bucket?: string
  /** Bars in the rows' own order (a pivot's: months by date), not largest first. */
  inOrder?: boolean
  /** Split: each series' name (largest first), the last one the rest put together when `other`. */
  series?: string[]
  other?: boolean
  /** Values the split column has in all (more than are shown when `other`). */
  seriesGroups?: number
  /** Bars split into parts that add up to the bar (sums and counts, none below zero); side by side otherwise. */
  stacked?: boolean
  /** SQL that produces the same numbers, runnable on its own (the table view). */
  sql: string
  title: string
}

export { isTemporal } from './sql'
/** TIMESTAMP WITH TIME ZONE. */
export const isZoned = (c: ColumnInfo) => /WITH TIME ZONE|TIMESTAMPTZ/i.test(c.type)
/**
 * A time column as an expression date math can use. Time-zone-aware values are read as UTC wall
 * time: date_trunc, epoch and friends on TIMESTAMPTZ need DuckDB's ICU extension (6.4 MB), which
 * the sealed engine doesn't ship, while the cast to TIMESTAMP is core. The grid already shows UTC.
 */
export const timeExpr = (c: ColumnInfo, ref = quoteIdent(c.name)) => (isZoned(c) ? `${ref}::TIMESTAMP` : ref)
export const TOP_N = 20
const BINS = 20

/** A column of years by its name (year, FY, Year of sale): a time axis, whether it holds numbers or text. */
export const yearName = (c: { name: string }) => /(^|_)(year|years|yr|yyyy|fy|fiscal_year|financial_year)(_|$)/.test(nameKey(c.name))
/** Columns that make a sensible x-axis: anything that isn't a plain number (a year is one). */
export const xCandidates = (cols: ColumnInfo[]) => cols.filter((c) => (!c.numeric || yearName(c)) && !/\[\]$|^(STRUCT|MAP|BLOB|UNION)/i.test(c.type))

/** A pivot's column of totals (Total, Total · Sum of amount): what its other columns add up to, not one of them. */
/** A pivot with a field across, as its own first line says: its row fields, the field across, and its values. */
function pivotShape(sql: string): { rows: string[]; across: string; values: string[] } | null {
  const m = /^-- Pivot: (?:rows (.+?) · )?columns (.+?) · values (.+)$/m.exec(sql)
  return m ? { rows: m[1] ? m[1].split(', ') : [], across: m[2], values: m[3].split(', ') } : null
}

/** A pivot's value that adds up across its columns: a sum or a count (not an average, a minimum…). */
const addsUp = (label: string) => /^(Sum of |Rows$)/.test(label)

/**
 * The number columns charted side by side as series. A pivot's are its columns across, found by place (after
 * its row fields, before its totals, whatever a value across is called: Total, FY 2024-25), for one of its
 * values (the one `y` is a column of, or the first); any other result's, each but the axis and codes.
 */
export function eachColumns(cols: ColumnInfo[], x: string, sql = '', y?: string | null): ColumnInfo[] {
  const shape = pivotShape(sql)
  if (!shape) return cols.filter((c) => c.numeric && c.name !== x && !/^(id|.*_id)$/i.test(c.name) && !yearName(c))
  let lead = 0
  while (lead < cols.length && shape.rows.includes(cols[lead].name)) lead++
  const label = eachValue(shape, y)
  return cols
    .slice(lead, cols.length - shape.values.length)
    .filter((c) => c.numeric && c.name !== x && (shape.values.length === 1 || c.name.endsWith(` · ${label}`)))
}

/** Which of a pivot's values is charted for each column: the one `y` is a column of, or the first. */
const eachValue = (shape: { values: string[] }, y?: string | null) => shape.values.find((v) => y?.endsWith(` · ${v}`)) ?? shape.values[0]

/** A reasonable first chart for a result, or null if nothing is chartable. */
export function defaultSpec(cols: ColumnInfo[], sql = ''): ChartSpec | null {
  const xs = xCandidates(cols)
  const measures = cols.filter((c) => c.numeric && !/^(id|.*_id|year|month|day)$/i.test(c.name) && !yearName(c))
  // A rate or a share summed means nothing (a sum of rates per 1,000): the amounts first.
  const rate = (c: ColumnInfo) => /%|(^|_)(rate|ratio|pct|percent|percentage|share|per|avg|average|mean|median)(_|$)/i.test(`${c.name.includes('%') ? '%' : ''}${nameKey(c.name)}`)
  const sums = measures.filter((c) => !rate(c))
  const y =
    ['total', 'amount', 'revenue', 'sales', 'value', 'price', 'cost'].map((w) => sums.find((c) => c.name.toLowerCase().includes(w))).find(Boolean) ??
    sums.find((c) => /^(DOUBLE|FLOAT|REAL|DECIMAL)/i.test(c.type)) ??
    sums[0] ??
    measures[0] ??
    cols.find((c) => c.numeric && !yearName(c))
  const x = xs.find(isTemporal) ?? xs.find(yearName) ?? xs[0]
  // A pivot with a field across: its columns are the series (Food, Rent… in each month's bar), as a pivot chart.
  // (Only one value that adds up: averages side by side are better read in the pivot.)
  const shape = pivotShape(sql)
  if (x && y && shape?.values.length === 1 && addsUp(shape.values[0]) && eachColumns(cols, x.name, sql).length >= 2) return { x: x.name, y: y.name, agg: 'sum', each: true }
  if (x) return { x: x.name, y: y?.name ?? null, agg: y ? 'sum' : 'count' }
  if (y) return { x: y.name, y: null, agg: 'count' } // all numeric: show a distribution
  return null
}

/** The measure as SQL; `ref` maps a column name to how it's referenced (the result table may rename one). */
const measure = (spec: ChartSpec, ref: (name: string) => string = quoteIdent) =>
  spec.agg === 'count' || !spec.y ? 'count(*)' : `${spec.agg}(${ref(spec.y)}::DOUBLE)`
const measureLabel = (spec: ChartSpec) => {
  if (spec.agg === 'count' || !spec.y) return 'Rows'
  // A column that is a total already (a pivot's "Sum of amount"): summed, it's still that, said once.
  if (spec.agg === 'sum' && /^(Sum of |Rows$|Total$)/.test(spec.y)) return spec.y
  return `${AGGS.find((a) => a.id === spec.agg)!.label} of ${spec.y}`
}

/**
 * The result's own SQL as a CTE, so table-view queries don't depend on the result table. Not
 * re-indented: that would change string literals that span lines.
 */
export function sourceCte(result: Pick<ResultSet, 'sql'>) {
  const last = splitStatements(result.sql).at(-1) ?? ''
  return `WITH q AS (\n${last}\n)\n`
}

async function rows(sql: string) {
  const { conn } = await getEngine()
  return (await conn.query(sql)).toArray().map((r) => r.toJSON() as Record<string, unknown>)
}

export const TIME_GRAINS = ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const
export type TimeGrain = (typeof TIME_GRAINS)[number]
const GRAINS = TIME_GRAINS
type Grain = TimeGrain

/**
 * Bucket by the span, but never finer than the data already is: values that are all first-of-month
 * (e.g. a query that already grouped by month) stay monthly instead of being shifted to the Monday
 * of their week.
 */
function pickBucket(spanSeconds: number, isDate: boolean, dataGrain: Grain | null): Grain {
  const day = 86_400
  const bySpan: Grain =
    spanSeconds > 20 * 365 * day ? 'year' : spanSeconds > 3 * 365 * day ? 'month' : spanSeconds > 60 * day ? 'week' : spanSeconds > 2 * day || isDate ? 'day' : 'hour'
  return dataGrain && GRAINS.indexOf(dataGrain) > GRAINS.indexOf(bySpan) ? dataGrain : bySpan
}

/** A split column's values as series names: empty ones named, as the bars name them. */
const seriesExpr = (ref: string) => `CASE WHEN ${ref} IS NULL THEN '(empty)' WHEN ${ref}::VARCHAR = '' THEN '(blank)' ELSE ${ref}::VARCHAR END`

interface Split {
  names: string[]
  other: boolean
  groups: number
  /** The measure for each series as SELECT items (aliased __s0…), for the result table or the standalone SQL. */
  items: (inTable: boolean) => string[]
  /** The same, aliased by series name for the standalone SQL. */
  named: string[]
}

/** The series a split shows: its values with the largest measure, the rest as one ("Other"). */
async function splitBy(result: ResultSet, spec: ChartSpec, where: (inTable: boolean) => string, taken: string[]): Promise<Split | null> {
  const sc = spec.split ? result.columns.find((c) => c.name === spec.split) : null
  if (!sc || sc.name === spec.x || !result.table) return null
  const inTable = seriesExpr(colRef(sc))
  const vr = measure(spec, (name) => {
    const c = result.columns.find((k) => k.name === name)
    return c ? colRef(c) : quoteIdent(name)
  })
  const top = await rows(
    `SELECT __s, count(*) OVER ()::DOUBLE AS __n FROM (SELECT ${inTable} AS __s, ${vr}::DOUBLE AS __v FROM ${result.table}${where(true)} GROUP BY 1) ORDER BY abs(__v) DESC NULLS LAST, __s LIMIT ${MAX_SERIES + 1}`,
  )
  if (!top.length) return null
  const groups = Number(top[0].__n)
  const other = groups > MAX_SERIES
  const shown = top.slice(0, other ? MAX_SERIES - 1 : MAX_SERIES).map((r) => String(r.__s))
  const otherName = shown.some((n) => n.toLowerCase() === 'other') ? 'All others' : 'Other'
  const names = other ? [...shown, otherName] : shown
  const lits = shown.map(quoteLiteral)
  const filter = (i: number, ref: string) => (other && i === shown.length ? `${ref} NOT IN (${lits.join(', ')})` : `${ref} = ${lits[i]}`)
  const one = (i: number, table: boolean) => {
    const ref = table ? inTable : seriesExpr(quoteIdent(sc.name))
    const m = table ? vr : measure(spec)
    return `(${m} FILTER (WHERE ${filter(i, ref)}))`
  }
  // Output names never collide with the axis, the total, or each other.
  const used = new Set(taken.map((n) => n.toLowerCase()))
  const named = names.map((n, i) => {
    let alias = n
    while (used.has(alias.toLowerCase())) alias = `${alias} (${sc.name})`
    used.add(alias.toLowerCase())
    return `${one(i, false)}::DOUBLE AS ${quoteIdent(alias)}`
  })
  return { names, other, groups, items: (table) => names.map((_, i) => `${one(i, table)}::DOUBLE AS __s${i}`), named }
}

/** Each number column as a series (sums): the first five and the rest as one when there are more than six. */
function eachSplit(result: ResultSet, spec: ChartSpec): (Split & { total: (inTable: boolean) => string; additive: boolean }) | null {
  const cols = eachColumns(result.columns, spec.x, result.sql, spec.y)
  if (cols.length < 2) return null
  // A pivot's averages don't add up: the first six side by side, never the rest put together.
  const shape = pivotShape(result.sql)
  const additive = !shape || addsUp(eachValue(shape, spec.y))
  const other = additive && cols.length > MAX_SERIES
  const shown = other ? cols.slice(0, MAX_SERIES - 1) : cols.slice(0, MAX_SERIES)
  const rest = other ? cols.slice(MAX_SERIES - 1) : []
  const sum = (list: ColumnInfo[], table: boolean) => list.map((c) => `coalesce(sum(${table ? colRef(c) : quoteIdent(c.name)}::DOUBLE), 0)`).join(' + ')
  const names = other ? [...shown.map((c) => c.name), shown.some((c) => c.name.toLowerCase() === 'other') ? 'All others' : 'Other'] : shown.map((c) => c.name)
  const parts = (table: boolean) => [...shown.map((c) => `sum(${table ? colRef(c) : quoteIdent(c.name)}::DOUBLE)`), ...(other ? [`(${sum(rest, table)})`] : [])]
  const used = new Set([spec.x.toLowerCase(), 'value', 'total_value'])
  const aliases = names.map((n) => {
    let alias = n
    while (used.has(alias.toLowerCase())) alias = `${alias} (sum)`
    used.add(alias.toLowerCase())
    return alias
  })
  return {
    names,
    other,
    groups: cols.length,
    items: (table) => parts(table).map((e, i) => `${e}::DOUBLE AS __s${i}`),
    named: parts(false).map((e, i) => `${e}::DOUBLE AS ${quoteIdent(aliases[i])}`),
    total: (table) => `(${sum(cols, table)})`,
    additive,
  }
}

/** What a chart of each column is called: a pivot's own words (Sum of amount by month and category), or the columns. */
function eachTitle(result: ResultSet, spec: ChartSpec, split: Split, by: string): string {
  const shape = pivotShape(result.sql)
  if (shape) return `${eachValue(shape, spec.y)} by ${by} and ${shape.across}`
  const cols = split.other ? split.groups : split.names.length
  return cols <= 3 ? `${split.names.slice(0, -1).join(', ')} and ${split.names.at(-1)} by ${by}` : `Sum of each of ${cols} columns by ${by}`
}

const splitValues = (r: Record<string, unknown>, split: Split | null, additive: boolean) =>
  split ? split.names.map((_, i) => (r[`__s${i}`] === null || r[`__s${i}`] === undefined ? (additive ? 0 : null) : Number(r[`__s${i}`]))) : undefined

export async function chartData(result: ResultSet, spec: ChartSpec): Promise<ChartData | null> {
  if (!result.table) return null
  const col = result.columns.find((c) => c.name === spec.x)
  if (!col) return null
  if (spec.y && !result.columns.some((c) => c.name === spec.y && c.numeric)) spec = { ...spec, y: null, agg: 'count' }
  // Sums and counts add up: a month with no rows for a series is a zero, not a gap.
  // Each number column as a series (sums only): the bar or point is what they add up to.
  const each = spec.each && spec.agg === 'sum' && (!col.numeric || yearName(col)) ? eachSplit(result, spec) : null
  if (each) spec = { ...spec, split: null }
  const additive = each ? each.additive : spec.agg === 'count' || spec.agg === 'sum' || !spec.y
  // `x`/`value` are for the standalone SQL (original names); `xr`/`vr` query the result table.
  const x = quoteIdent(col.name)
  const xr = colRef(col)
  const value = each ? each.total(false) : measure(spec)
  const vr = each
    ? each.total(true)
    : measure(spec, (name) => {
        const c = result.columns.find((k) => k.name === name)
        return c ? colRef(c) : quoteIdent(name)
      })
  const titleFor = (by: string, plain: string) => (each ? eachTitle(result, spec, each, by) : plain)

  // Years (2015 … 2023, numbers or text, as an unpivot leaves them): a line over time, every year on it, not a
  // histogram of the numbers or the top 20 of them as categories.
  const yearly =
    yearName(col) &&
    !!(
      await rows(
        `SELECT bool_and(regexp_full_match(trim(${xr}::VARCHAR), '(1[89]|2[0-2])[0-9]{2}')) AS ok FROM ${result.table} WHERE ${xr} IS NOT NULL AND trim(${xr}::VARCHAR) <> ''`,
      )
    )[0]?.ok
  if (yearly) {
    const label = (e: string) => `make_date(trim(${e}::VARCHAR)::INTEGER, 1, 1)::VARCHAR`
    const nonEmpty = (e: string) => `${e} IS NOT NULL AND trim(${e}::VARCHAR) <> ''`
    const split = each ?? (await splitBy(result, spec, (t) => ` WHERE ${nonEmpty(t ? xr : x)}`, [col.name, 'value']))
    const data = await rows(`SELECT ${label(xr)} AS __x, ${vr}::DOUBLE AS __v${items(split)} FROM ${result.table} WHERE ${nonEmpty(xr)} GROUP BY 1 ORDER BY 1 LIMIT 5000`)
    return {
      kind: 'line',
      bucket: 'year',
      points: data.map((r) => ({ label: String(r.__x), value: Number(r.__v), values: splitValues(r, split, additive) })),
      groups: data.length,
      ...seriesOf(split),
      title: titleFor(col.name, `${measureLabel(spec)} by ${col.name}${split ? ` and ${spec.split}` : ''}`),
      sql: `${sourceCte(result)}SELECT trim(${x}::VARCHAR)::INTEGER AS ${x}, ${value}::DOUBLE AS value${named(split)} FROM q WHERE ${nonEmpty(x)} GROUP BY 1 ORDER BY 1`,
    }
  }

  if (col.numeric) {
    const h = await histogram(result.table, col)
    return {
      kind: 'hist',
      points: h,
      groups: h.length,
      title: `Distribution of ${col.name}`,
      sql: `${sourceCte(result)}SELECT ${x}, count(*) AS rows FROM q GROUP BY 1 ORDER BY 1`,
    }
  }

  if (isTemporal(col)) {
    const t = timeExpr(col, xr)
    // One pass: the span, and the coarsest grain every value already sits on.
    const [span] = await rows(
      `SELECT (epoch(max(${t})) - epoch(min(${t})))::DOUBLE AS s,
        bool_and(${t} = date_trunc('year', ${t})) AS y,
        bool_and(${t} = date_trunc('quarter', ${t})) AS q,
        bool_and(${t} = date_trunc('month', ${t})) AS m,
        bool_and(${t} = date_trunc('week', ${t})) AS w,
        bool_and(${t} = date_trunc('day', ${t})) AS d
      FROM ${result.table} WHERE ${xr} IS NOT NULL`,
    )
    const grain: Grain | null = span?.y ? 'year' : span?.q ? 'quarter' : span?.m ? 'month' : span?.w ? 'week' : span?.d ? 'day' : null
    // Asked for, or picked from the span (an hour of a DATE is its day).
    const bucket = spec.grain ? (spec.grain === 'hour' && /^DATE$/i.test(col.type) ? 'day' : spec.grain) : pickBucket(Number(span?.s ?? 0), /^DATE$/i.test(col.type), grain)
    const label = (e: string) => (bucket === 'hour' ? `strftime(date_trunc('hour', ${e}), '%Y-%m-%d %H:00')` : `date_trunc('${bucket}', ${e})::DATE::VARCHAR`)
    const split = each ?? (await splitBy(result, spec, (inTable) => ` WHERE ${inTable ? xr : x} IS NOT NULL`, [bucket, 'value']))
    const sql = `SELECT ${label(timeExpr(col))} AS ${quoteIdent(bucket)}, ${value}::DOUBLE AS value${named(split)} FROM q WHERE ${x} IS NOT NULL GROUP BY 1 ORDER BY 1`
    // Internal aliases: a column called "value" must not collide with the measure.
    const data = await rows(
      `SELECT ${label(t)} AS __x, ${vr}::DOUBLE AS __v${items(split)} FROM ${result.table} WHERE ${xr} IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 5000`,
    )
    return {
      kind: 'line',
      bucket,
      points: data.map((r) => ({ label: String(r.__x), value: Number(r.__v), values: splitValues(r, split, additive) })),
      groups: data.length,
      ...seriesOf(split),
      title: `${titleFor(bucket, `${measureLabel(spec)} by ${bucket}${split ? ` and ${spec.split}` : ''}`)}${isZoned(col) ? ' (UTC)' : ''}`,
      sql: `${sourceCte(result)}${sql}`,
    }
  }

  const valueAlias = col.name.toLowerCase() === 'value' ? 'total_value' : 'value'
  // A pivot's grand-total row is a sum of the others, not a category: charted, it dwarfs every bar. It's
  // the row labelled Total in the first row field (the other fields are empty on it), whichever is charted.
  const pivotTotal = /GROUPING\s+SETS/i.test(result.sql) && result.columns.length > 0
  const first = result.columns[0]
  const notTotal = (inTable: boolean) => (pivotTotal ? ` WHERE ${inTable ? colRef(first) : quoteIdent(first.name)}::VARCHAR IS DISTINCT FROM 'Total'` : '')
  // A pivot's rows are in the order it was asked for (months by date, or largest first): the bars keep it.
  const inOrder = /^-- Pivot: /m.test(result.sql)
  const split = each ?? (await splitBy(result, spec, notTotal, [col.name, valueAlias]))
  const sql = inOrder
    ? `SELECT ${x}::VARCHAR AS ${x}, ${value}::DOUBLE AS ${valueAlias}${named(split)} FROM (SELECT *, row_number() OVER () AS __row FROM q)${notTotal(false)} GROUP BY 1 ORDER BY min(__row)`
    : `SELECT ${x}::VARCHAR AS ${x}, ${value}::DOUBLE AS ${valueAlias}${named(split)} FROM q${notTotal(false)} GROUP BY 1 ORDER BY 2 DESC NULLS LAST, 1`
  const [data, [count]] = await Promise.all([
    rows(
      `SELECT ${xr}::VARCHAR AS __x, ${vr}::DOUBLE AS __v${items(split)} FROM ${result.table}${notTotal(true)} GROUP BY 1 ORDER BY ${inOrder ? 'min(rowid)' : '2 DESC NULLS LAST, 1'} LIMIT ${TOP_N}`,
    ),
    rows(`SELECT count(DISTINCT ${xr})::DOUBLE + max(CASE WHEN ${xr} IS NULL THEN 1 ELSE 0 END) AS n FROM ${result.table}${notTotal(true)}`),
  ])
  const points = data.map((r) => ({
    label: r.__x === null ? '(empty)' : r.__x === '' ? '(blank)' : periodText(String(r.__x)),
    value: Number(r.__v ?? 0),
    values: splitValues(r, split, additive),
  }))
  return {
    kind: 'bar',
    points,
    groups: Number(count?.n ?? data.length),
    inOrder,
    ...seriesOf(split),
    // Parts of a bar only when they add up to it: a sum or a count, nothing below zero.
    stacked: !!split && additive && points.every((p) => p.values!.every((v) => (v ?? 0) >= 0)),
    title: titleFor(col.name, `${measureLabel(spec)} by ${col.name}${split ? ` and ${spec.split}` : ''}`),
    sql: `${sourceCte(result)}${sql}`,
  }
}

const items = (split: Split | null) => (split ? `, ${split.items(true).join(', ')}` : '')
const named = (split: Split | null) => (split ? `, ${split.named.join(', ')}` : '')
const seriesOf = (split: Split | null): Pick<ChartData, 'series' | 'other' | 'seriesGroups'> =>
  split ? { series: split.names, other: split.other, seriesGroups: split.groups } : {}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A pivot's period as a chart says it: 2024-04 → Apr 2024, 2024-Q2 → Q2 2024 (anything else as it is). */
export function periodText(label: string): string {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label)
  if (month) return `${MONTH_NAMES[Number(month[2]) - 1]} ${month[1]}`
  const quarter = /^(\d{4})-Q([1-4])$/.exec(label)
  return quarter ? `Q${quarter[2]} ${quarter[1]}` : label
}

const INTEGER = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|U)/i

/** Equal-width histogram of a numeric column (computed in SQL, so it works on any row count). */
export async function histogram(table: string, col: ColumnInfo): Promise<Point[]> {
  const c = `${colRef(col)}::DOUBLE`
  const [range] = await rows(`SELECT min(${c}) AS lo, max(${c}) AS hi FROM ${table} WHERE isfinite(${c})`)
  const lo = range?.lo as number | null
  const hi = range?.hi as number | null
  if (lo === null || hi === null || lo === undefined || hi === undefined) return []
  // Small integer ranges get one bar per value; everything else gets equal-width bins.
  const intRange = INTEGER.test(col.type) && hi - lo < BINS
  const bins = intRange ? hi - lo + 1 : hi === lo ? 1 : BINS
  const width = intRange ? 1 : hi === lo ? 1 : (hi - lo) / bins
  if (!Number.isFinite(width) || !Number.isFinite(lo)) return [] // a range wider than doubles can hold
  const counts = await rows(
    `SELECT least(greatest(floor((${c} - (${lo})::DOUBLE) / (${width})::DOUBLE), 0), ${bins - 1})::INTEGER AS b, count(*)::DOUBLE AS n
     FROM ${table} WHERE isfinite(${c}) GROUP BY 1`,
  )
  const byBin = new Map(counts.map((r) => [Number(r.b), Number(r.n)]))
  return Array.from({ length: bins }, (_, i) => {
    const a = lo + i * width
    const b = intRange ? a : i === bins - 1 ? hi : a + width
    return { label: intRange ? fmt(a) : `${fmt(a)} – ${fmt(b)}`, value: byBin.get(i) ?? 0, lo: a, hi: b }
  })
}

const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 })
const plain = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })
export const fmt = (n: number) => (Math.abs(n) >= 10_000 ? compact.format(n) : plain.format(n))
