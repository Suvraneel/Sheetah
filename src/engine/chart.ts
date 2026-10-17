import { getEngine, quoteIdent } from './db'
import { LOCALE, isTemporal } from './sql'
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

/** Columns that make a sensible x-axis: anything that isn't a plain number. */
export const xCandidates = (cols: ColumnInfo[]) => cols.filter((c) => !c.numeric && !/\[\]$|^(STRUCT|MAP|BLOB|UNION)/i.test(c.type))

/** A reasonable first chart for a result, or null if nothing is chartable. */
export function defaultSpec(cols: ColumnInfo[]): ChartSpec | null {
  const xs = xCandidates(cols)
  const measures = cols.filter((c) => c.numeric && !/^(id|.*_id|year|month|day)$/i.test(c.name))
  const y =
    ['total', 'amount', 'revenue', 'sales', 'value', 'price', 'cost'].map((w) => measures.find((c) => c.name.toLowerCase().includes(w))).find(Boolean) ??
    measures.find((c) => /^(DOUBLE|FLOAT|REAL|DECIMAL)/i.test(c.type)) ??
    measures[0] ??
    cols.find((c) => c.numeric)
  const x = xs.find(isTemporal) ?? xs[0]
  if (x) return { x: x.name, y: y?.name ?? null, agg: y ? 'sum' : 'count' }
  if (y) return { x: y.name, y: null, agg: 'count' } // all numeric: show a distribution
  return null
}

/** The measure as SQL; `ref` maps a column name to how it's referenced (the result table may rename one). */
const measure = (spec: ChartSpec, ref: (name: string) => string = quoteIdent) =>
  spec.agg === 'count' || !spec.y ? 'count(*)' : `${spec.agg}(${ref(spec.y)}::DOUBLE)`
const measureLabel = (spec: ChartSpec) => (spec.agg === 'count' || !spec.y ? 'Rows' : `${AGGS.find((a) => a.id === spec.agg)!.label} of ${spec.y}`)

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

const GRAINS = ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const
type Grain = (typeof GRAINS)[number]

/**
 * Bucket by the span, but never finer than the data already is: values that are all first-of-month
 * (e.g. a query that already grouped by month) stay monthly instead of being shifted to the Monday
 * of their week.
 */
function pickBucket(spanSeconds: number, isDate: boolean, dataGrain: Grain | null): Grain {
  const day = 86_400
  const bySpan: Grain =
    spanSeconds > 20 * 365 * day ? 'year' : spanSeconds > 3 * 365 * day ? 'month' : spanSeconds > 120 * day ? 'week' : spanSeconds > 2 * day || isDate ? 'day' : 'hour'
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
    const bucket = pickBucket(Number(span?.s ?? 0), /^DATE$/i.test(col.type), grain)
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
  const sql = `SELECT ${x}::VARCHAR AS ${x}, ${value}::DOUBLE AS ${valueAlias} FROM q${notTotal(false)} GROUP BY 1 ORDER BY 2 DESC NULLS LAST, 1`
  const [data, [count]] = await Promise.all([
    rows(`SELECT ${xr}::VARCHAR AS __x, ${vr}::DOUBLE AS __v FROM ${result.table}${notTotal(true)} GROUP BY 1 ORDER BY 2 DESC NULLS LAST, 1 LIMIT ${TOP_N}`),
    rows(`SELECT count(DISTINCT ${xr})::DOUBLE + max(CASE WHEN ${xr} IS NULL THEN 1 ELSE 0 END) AS n FROM ${result.table}${notTotal(true)}`),
  ])
  return {
    kind: 'bar',
    points: data.map((r) => ({ label: r.__x === null ? '(empty)' : r.__x === '' ? '(blank)' : String(r.__x), value: Number(r.__v ?? 0) })),
    groups: Number(count?.n ?? data.length),
    title: `${measureLabel(spec)} by ${col.name}`,
    sql: `${sourceCte(result)}${sql}`,
  }
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
