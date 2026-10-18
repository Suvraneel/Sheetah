import { getEngine, quoteIdent, quoteLiteral } from './db'
import { commentText, isIdLike, LOCALE } from './sql'
import { AGGS, isTemporal, sourceCte, timeExpr, type Agg } from './chart'
import type { ColumnInfo } from './result'

/*
 * Pivot tables as plain SQL. A pivot is a GROUP BY over the row fields, one conditional aggregate
 * (`sum(x) FILTER (WHERE col = 'value')`) per value of the column field, a Total column, and an
 * optional grand-total row (GROUPING SETS). The result is an ordinary query: it lands in the editor,
 * and can be sorted, charted, saved, shared and exported like any other.
 */
export type Grain = 'none' | 'year' | 'fy' | 'quarter' | 'fquarter' | 'month' | 'week' | 'day'
export const GRAINS: { id: Grain; label: string }[] = [
  { id: 'year', label: 'Year' },
  // India's (and others'): April to March, FY 2024-25. Its quarters start in April.
  { id: 'fy', label: 'Financial year (Apr–Mar)' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'fquarter', label: 'Financial quarter' },
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'none', label: 'Exact value' },
]

export interface Field {
  column: string
  grain: Grain
}
export interface ValueField {
  agg: Agg
  column: string | null
}
export interface PivotSpec {
  rows: Field[]
  columns: Field | null
  values: ValueField[]
  totals: boolean
  sort: 'label' | 'value'
}

/** A pivot needs a column per distinct value; past this it stops being readable. */
export const MAX_PIVOT_COLUMNS = 60

export class TooManyColumnsError extends Error {
  readonly column: string
  readonly count: number
  constructor(column: string, count: number) {
    super(`${column} has ${count.toLocaleString(LOCALE)} different values, more than the ${MAX_PIVOT_COLUMNS} columns a pivot can show.`)
    this.column = column
    this.count = count
  }
}

export const fieldFor = (column: ColumnInfo): Field => ({ column: column.name, grain: isTemporal(column) ? 'month' : 'none' })

const byName = (cols: ColumnInfo[], name: string) => cols.find((c) => c.name === name)

function fieldExpr(f: Field, cols: ColumnInfo[]) {
  const col = byName(cols, f.column)
  const q = quoteIdent(f.column)
  if (!col || !isTemporal(col) || f.grain === 'none') return q
  const t = timeExpr(col)
  // A financial year from its 1 April; a financial quarter is a calendar one, named from April.
  if (f.grain === 'fy') return `(date_trunc('year', ${t} - INTERVAL 3 MONTH) + INTERVAL 3 MONTH)::DATE`
  return `date_trunc('${f.grain === 'fquarter' ? 'quarter' : f.grain}', ${t})::DATE`
}
const GRAIN_NAME: Partial<Record<Grain, string>> = { fy: 'financial year', fquarter: 'financial quarter' }
const fieldAlias = (f: Field) => (f.grain === 'none' ? f.column : `${f.column} (${GRAIN_NAME[f.grain] ?? f.grain})`)

/**
 * A field grouped into periods (a month, a quarter…): labelled as the period, written so that sorting the
 * labels sorts the periods (2024-04 before 2024-11, 2024-Q4 before 2025-Q1), with the Total row after them.
 */
const isPeriod = (f: Field, cols: ColumnInfo[]) => {
  const col = byName(cols, f.column)
  return !!col && isTemporal(col) && f.grain !== 'none' && f.grain !== 'day'
}

/**
 * A period's label in SQL, from its first day: 2024, 2024-Q2, 2024-04, and a week by its Monday (2024-04-08).
 * A financial year FY 2024-25, its quarters FY 2024-25 Q1 (April to June).
 */
function periodSql(e: string, grain: Grain): string {
  const fy = (d: string) => `'FY ' || year(${d}) || '-' || right((year(${d}) + 1)::VARCHAR, 2)`
  if (grain === 'fy') return fy(e)
  if (grain === 'fquarter') return `${fy(`(${e} - INTERVAL 3 MONTH)`)} || ' Q' || ((quarter(${e}) + 2) % 4 + 1)`
  if (grain === 'year') return `strftime(${e}, '%Y')`
  if (grain === 'quarter') return `year(${e}) || '-Q' || quarter(${e})`
  if (grain === 'month') return `strftime(${e}, '%Y-%m')`
  return `strftime(${e}, '%Y-%m-%d')`
}

/** The same label, for a column heading (from the period's first day, as YYYY-MM-DD). */
export function periodLabel(iso: string, grain: Grain): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const [y, mo] = [Number(m[1]), Number(m[2])]
  const fy = (start: number) => `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`
  if (grain === 'fy') return fy(mo >= 4 ? y : y - 1)
  if (grain === 'fquarter') return `${fy(mo >= 4 ? y : y - 1)} Q${((Math.floor((mo - 1) / 3) + 1 + 2) % 4) + 1}`
  if (grain === 'year') return m[1]
  if (grain === 'quarter') return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`
  if (grain === 'month') return `${m[1]}-${m[2]}`
  return m[0]
}

export function valueLabel(v: ValueField) {
  if (v.agg === 'count' || !v.column) return 'Rows'
  return `${AGGS.find((a) => a.id === v.agg)!.label} of ${v.column}`
}

function aggregate(v: ValueField, i: number, filter?: string) {
  const f = filter ? ` FILTER (WHERE ${filter})` : ''
  if (v.agg === 'count' || !v.column) return `count(*)${f}`
  // Exact (compensated) float sums: no rounding in SQL, so rates like 0.0012 survive; the grid formats for display.
  if (v.agg === 'sum') return `fsum(__v${i}::DOUBLE)${f}`
  if (v.agg === 'avg') return `favg(__v${i}::DOUBLE)${f}`
  return `${v.agg}(__v${i})${f}`
}

/** Distinct values of the column field, in natural order (dates by date, numbers by number). */
export async function columnValues(sourceSql: string, spec: PivotSpec, cols: ColumnInfo[]): Promise<(string | null)[]> {
  if (!spec.columns) return []
  const { conn } = await getEngine()
  const expr = fieldExpr(spec.columns, cols)
  const res = await conn.query(
    `${sourceCte({ sql: sourceSql })}SELECT v::VARCHAR AS s FROM (SELECT DISTINCT ${expr} AS v FROM q) ORDER BY v NULLS LAST LIMIT ${MAX_PIVOT_COLUMNS + 1}`,
  )
  const values = res.toArray().map((r) => (r.toJSON() as { s: string | null }).s)
  if (values.length > MAX_PIVOT_COLUMNS) {
    const n = await conn.query(`${sourceCte({ sql: sourceSql })}SELECT count(DISTINCT ${expr})::DOUBLE AS n FROM q`)
    throw new TooManyColumnsError(fieldAlias(spec.columns), Number(n.toArray()[0]?.toJSON().n ?? values.length))
  }
  return values
}

export function pivotSql(sourceSql: string, spec: PivotSpec, cols: ColumnInfo[], colValues: (string | null)[]): string {
  const values = spec.values.length ? spec.values : [{ agg: 'count' as Agg, column: null }]
  const used = new Set<string>()
  const unique = (name: string) => {
    let n = name
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${name} ${i}`
    used.add(n.toLowerCase())
    return n
  }

  // k: just the fields the pivot needs, with date grains applied once.
  const keys = spec.rows.map((f) => ({ expr: fieldExpr(f, cols), alias: unique(fieldAlias(f)), period: isPeriod(f, cols) ? f.grain : null }))
  const kCols = [
    ...keys.map((k) => (k.expr === quoteIdent(k.alias) ? k.expr : `${k.expr} AS ${quoteIdent(k.alias)}`)),
    ...(spec.columns ? [`(${fieldExpr(spec.columns, cols)})::VARCHAR AS __pivot`] : []),
    ...values.map((v, i) => (v.column && v.agg !== 'count' ? `${quoteIdent(v.column)} AS __v${i}` : null)).filter(Boolean),
  ]
  if (!kCols.length) kCols.push('1 AS __one')

  const k = (alias: string) => `k.${quoteIdent(alias)}`
  const grand = spec.totals && keys.length > 0
  // Months, quarters… read as the period (2024-04), sorted by date (the ORDER BY is on k's dates; the labels sort the same way).
  const shown = (key: (typeof keys)[number]) => (key.period ? periodSql(k(key.alias), key.period) : k(key.alias))
  const select: string[] = keys.map((key, i) =>
    i === 0 && grand
      ? `CASE WHEN grouping(${k(key.alias)}) = 1 THEN 'Total' ELSE (${shown(key)})::VARCHAR END AS ${quoteIdent(key.alias)}`
      : `${shown(key)} AS ${quoteIdent(key.alias)}`,
  )

  let sortAlias = ''
  if (spec.columns) {
    for (const cv of colValues) {
      const filter = cv === null ? '__pivot IS NULL' : `__pivot = ${quoteLiteral(cv)}`
      const head = cv === null ? '(empty)' : cv.trim() === '' ? '(blank)' : spec.columns && isPeriod(spec.columns, cols) ? periodLabel(cv, spec.columns.grain) : cv
      values.forEach((v, i) => select.push(`${aggregate(v, i, filter)} AS ${quoteIdent(unique(values.length > 1 ? `${head} · ${valueLabel(v)}` : head))}`))
    }
    values.forEach((v, i) => {
      const alias = unique(values.length > 1 ? `Total · ${valueLabel(v)}` : 'Total')
      sortAlias ||= alias
      select.push(`${aggregate(v, i)} AS ${quoteIdent(alias)}`)
    })
  } else {
    values.forEach((v, i) => {
      const alias = unique(valueLabel(v))
      sortAlias ||= alias
      select.push(`${aggregate(v, i)} AS ${quoteIdent(alias)}`)
    })
  }

  const keyList = keys.map((key) => k(key.alias)).join(', ')
  const order = [
    ...(grand ? [`grouping(${keyList})`] : []),
    ...(spec.sort === 'value' ? [`${quoteIdent(sortAlias)} DESC NULLS LAST`] : []),
    ...keys.map((key) => `${k(key.alias)} NULLS LAST`),
  ]
  const describe = [
    spec.rows.length ? `rows ${spec.rows.map(fieldAlias).join(', ')}` : null,
    spec.columns ? `columns ${fieldAlias(spec.columns)}` : null,
    `values ${values.map(valueLabel).join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return [
    commentText(`-- Pivot: ${describe}`),
    `${sourceCte({ sql: sourceSql }).trimEnd()},`,
    `k AS (\n  SELECT ${kCols.join(', ')} FROM q\n)`,
    `SELECT\n  ${select.join(',\n  ')}`,
    'FROM k',
    keys.length ? (grand ? `GROUP BY GROUPING SETS ((${keyList}), ())` : `GROUP BY ${keyList}`) : null,
    order.length ? `ORDER BY ${order.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

export const groupable = (cols: ColumnInfo[]) => cols.filter((c) => !/\[\]$|^(STRUCT|MAP|BLOB|UNION)/i.test(c.type))

/** Approximate distinct counts per column, so the picker can show sizes and pick sensible defaults. */
export async function cardinalities(sourceSql: string, cols: ColumnInfo[]): Promise<Record<string, number>> {
  const list = groupable(cols)
  if (!list.length) return {}
  const { conn } = await getEngine()
  const res = await conn.query(
    `${sourceCte({ sql: sourceSql })}SELECT ${list.map((c, i) => `least(approx_count_distinct(${quoteIdent(c.name)}), count(*))::DOUBLE AS c${i}`).join(', ')} FROM q`,
  )
  const row = (res.toArray()[0]?.toJSON() ?? {}) as Record<string, number>
  return Object.fromEntries(list.map((c, i) => [c.name, Number(row[`c${i}`] ?? 0)]))
}

/** A first pivot: the smallest category across, the next one down the side, money in the cells. */
export function defaultPivot(cols: ColumnInfo[], counts: Record<string, number>): PivotSpec {
  const cats = groupable(cols)
    .filter((c) => !c.numeric && !isTemporal(c) && (counts[c.name] ?? 0) >= 2)
    .sort((a, b) => (counts[a.name] ?? 0) - (counts[b.name] ?? 0))
  const time = cols.find(isTemporal)
  const measures = cols.filter((c) => c.numeric && !isIdLike(c.name))
  const money =
    ['total', 'amount', 'revenue', 'sales', 'value', 'price', 'cost'].map((w) => measures.find((c) => c.name.toLowerCase().includes(w))).find(Boolean) ??
    measures[0]
  const across = cats[0] && (counts[cats[0].name] ?? 0) <= 12 ? cats[0] : null
  const down = cats.find((c) => c !== across && (counts[c.name] ?? 0) <= 500) ?? time ?? null
  return {
    rows: down ? [fieldFor(down)] : [],
    columns: across ? fieldFor(across) : null,
    values: [money ? { agg: 'sum', column: money.name } : { agg: 'count', column: null }],
    totals: true,
    sort: 'label',
  }
}
