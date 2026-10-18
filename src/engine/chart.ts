import { getEngine, quoteIdent } from './db'
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
}

export interface Point {
  label: string
  value: number
  /** Bin edges for histograms. */
  lo?: number
  hi?: number
}

export interface ChartData {
  kind: 'bar' | 'line' | 'hist'
  points: Point[]
  /** Distinct groups before the top-N cut (bar charts). */
  groups: number
  bucket?: string
  /** Bars in the rows' own order (a pivot's: months by date), not largest first. */
  inOrder?: boolean
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

/** A reasonable first chart for a result, or null if nothing is chartable. */
export function defaultSpec(cols: ColumnInfo[]): ChartSpec | null {
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

export async function chartData(result: ResultSet, spec: ChartSpec): Promise<ChartData | null> {
  if (!result.table) return null
  const col = result.columns.find((c) => c.name === spec.x)
  if (!col) return null
  if (spec.y && !result.columns.some((c) => c.name === spec.y && c.numeric)) spec = { ...spec, y: null, agg: 'count' }
  // `x`/`value` are for the standalone SQL (original names); `xr`/`vr` query the result table.
  const x = quoteIdent(col.name)
  const xr = colRef(col)
  const value = measure(spec)
  const vr = measure(spec, (name) => {
    const c = result.columns.find((k) => k.name === name)
    return c ? colRef(c) : quoteIdent(name)
  })

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
    const data = await rows(`SELECT ${label(xr)} AS __x, ${vr}::DOUBLE AS __v FROM ${result.table} WHERE ${nonEmpty(xr)} GROUP BY 1 ORDER BY 1 LIMIT 5000`)
    return {
      kind: 'line',
      bucket: 'year',
      points: data.map((r) => ({ label: String(r.__x), value: Number(r.__v) })),
      groups: data.length,
      title: `${measureLabel(spec)} by ${col.name}`,
      sql: `${sourceCte(result)}SELECT trim(${x}::VARCHAR)::INTEGER AS ${x}, ${value}::DOUBLE AS value FROM q WHERE ${nonEmpty(x)} GROUP BY 1 ORDER BY 1`,
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
    const sql = `SELECT ${label(timeExpr(col))} AS ${quoteIdent(bucket)}, ${value}::DOUBLE AS value FROM q WHERE ${x} IS NOT NULL GROUP BY 1 ORDER BY 1`
    // Internal aliases: a column called "value" must not collide with the measure.
    const data = await rows(
      `SELECT ${label(t)} AS __x, ${vr}::DOUBLE AS __v FROM ${result.table} WHERE ${xr} IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 5000`,
    )
    return {
      kind: 'line',
      bucket,
      points: data.map((r) => ({ label: String(r.__x), value: Number(r.__v) })),
      groups: data.length,
      title: `${measureLabel(spec)} by ${bucket}${isZoned(col) ? ' (UTC)' : ''}`,
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
  const sql = inOrder
    ? `SELECT ${x}::VARCHAR AS ${x}, ${value}::DOUBLE AS ${valueAlias} FROM (SELECT *, row_number() OVER () AS __row FROM q)${notTotal(false)} GROUP BY 1 ORDER BY min(__row)`
    : `SELECT ${x}::VARCHAR AS ${x}, ${value}::DOUBLE AS ${valueAlias} FROM q${notTotal(false)} GROUP BY 1 ORDER BY 2 DESC NULLS LAST, 1`
  const [data, [count]] = await Promise.all([
    rows(`SELECT ${xr}::VARCHAR AS __x, ${vr}::DOUBLE AS __v FROM ${result.table}${notTotal(true)} GROUP BY 1 ORDER BY ${inOrder ? 'min(rowid)' : '2 DESC NULLS LAST, 1'} LIMIT ${TOP_N}`),
    rows(`SELECT count(DISTINCT ${xr})::DOUBLE + max(CASE WHEN ${xr} IS NULL THEN 1 ELSE 0 END) AS n FROM ${result.table}${notTotal(true)}`),
  ])
  return {
    kind: 'bar',
    points: data.map((r) => ({ label: r.__x === null ? '(empty)' : r.__x === '' ? '(blank)' : periodText(String(r.__x)), value: Number(r.__v ?? 0) })),
    groups: Number(count?.n ?? data.length),
    inOrder,
    title: `${measureLabel(spec)} by ${col.name}`,
    sql: `${sourceCte(result)}${sql}`,
  }
}

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
