import { cleanExpr, cleanSql, type Clean, type DropRows } from './clean'
import { lookupSql, type Lookup } from './lookup'
import { LOCALE, quoteIdent, quoteLiteral, splitStatements, sqlName } from './sql'

/**
 * Point-and-click actions (sort, filter, add column) don't mutate data: they compose plain,
 * readable SQL around the user's last query. The composed SQL is shown in the editor so
 * people can learn from it and keep editing.
 */
export type FilterOp =
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'is_null'
  | 'not_null'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'

export interface Filter {
  column: string
  op: FilterOp
  value?: string
  /** Second bound for 'between'. */
  value2?: string
  /** Values for 'in' (null means "empty"). */
  values?: (string | null)[]
  numeric?: boolean
  /** The column's SQL type, so text columns aren't cast needlessly. */
  type?: string
  /** Match case exactly (values picked from the data, rather than typed). */
  exact?: boolean
  /** The values are fractions of a percentage column: described as 18%, not 0.18. */
  percent?: boolean
}

export interface Ops {
  sort?: { column: string; dir: 'asc' | 'desc' }
  filters: Filter[]
  /** Added columns: a name and its formula (and, for one Sheetah wrote, what it is in words). */
  computed: { name: string; expr: string; note?: string }[]
  /** Find: rows where any column contains this text. */
  search?: string
  /** Duplicates by a column: show only repeated values, or keep the first row of each. */
  dedupe?: { column: string; mode: 'show' | 'remove' }
  /** Columns converted or tidied in place (numbers stored as text, dates, spaces): applied first. */
  clean?: Clean[]
  /** Columns brought in from other tables by a matching key (VLOOKUP): after cleaning, before the rest. */
  lookups?: Lookup[]
  /** Columns left out of the result (still usable by filters and sorting, which run first). */
  hidden?: string[]
  /** Rows that aren't data (total lines, empty rows), left out like a filter. */
  drop?: DropRows[]
}

export const emptyOps = (): Ops => ({ filters: [], computed: [] })
export const hasOps = (o: Ops) =>
  !!o.sort || o.filters.length > 0 || o.computed.length > 0 || !!o.search || !!o.dedupe || !!o.clean?.length || !!o.lookups?.length || !!o.hidden?.length || !!o.drop?.length

/**
 * Reads a number the way people type it: "1,234.50", "₹ 12,34,567", "(250)" for −250, "1e6".
 * Returns the canonical digits (kept as text, so 64-bit IDs and decimals stay exact) or null.
 */
export function parseNumber(input: string): string | null {
  let s = input.trim().replace(/[\s_,₹$€£¥]/g, '')
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null
  s = s.replace(/^\+/, '')
  if (negative) s = s.startsWith('-') ? s.slice(1) : `-${s}`
  return s.replace(/^(-?)\./, '$10.')
}

const isTextType = (t?: string) => !t || /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)/i.test(t)
const isTimestamp = (t?: string) => !!t && /^TIMESTAMP/i.test(t)
const isDateType = (t?: string) => !!t && /^DATE$/i.test(t)
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** One filter as SQL (a WHERE condition). */
export function filterSql(f: Filter): string {
  const c = sqlName(f.column)
  const text = isTextType(f.type) ? c : `${c}::VARCHAR`
  const num = (v?: string) => (v === undefined ? null : parseNumber(v))
  const lit = (v: string) => (f.numeric && num(v) !== null ? num(v)! : quoteLiteral(v))
  // Dates typed into a date-and-time column mean the whole day: "is 2024-01-31" is any time that day,
  // and "between … and 2024-01-31" includes all of the 31st.
  if (isTimestamp(f.type) || isDateType(f.type)) {
    const day = (v?: string) => !!v && DATE_ONLY.test(v.trim()) && isTimestamp(f.type)
    if (f.op === 'equals' && f.value !== undefined)
      return day(f.value) ? `${c}::DATE = DATE ${quoteLiteral(f.value.trim())}` : `${c} = ${quoteLiteral(f.value.trim())}`
    if (f.op === 'not_equals' && f.value !== undefined)
      return day(f.value) ? `${c}::DATE IS DISTINCT FROM DATE ${quoteLiteral(f.value.trim())}` : `${c} IS DISTINCT FROM ${quoteLiteral(f.value.trim())}`
    if (f.op === 'between' && day(f.value2))
      return `${c} >= ${quoteLiteral((f.value ?? '').trim())} AND ${c} < DATE ${quoteLiteral((f.value2 ?? '').trim())} + INTERVAL 1 DAY`
    if (f.op === 'lte' && day(f.value)) return `${c} < DATE ${quoteLiteral((f.value ?? '').trim())} + INTERVAL 1 DAY`
    if (f.op === 'gt' && day(f.value)) return `${c} >= DATE ${quoteLiteral((f.value ?? '').trim())} + INTERVAL 1 DAY`
  }
  switch (f.op) {
    case 'contains':
      return `contains(lower(${text}), lower(${quoteLiteral(f.value ?? '')}))`
    case 'not_contains':
      return `NOT contains(lower(coalesce(${text}, '')), lower(${quoteLiteral(f.value ?? '')}))`
    case 'starts_with':
      return `starts_with(lower(${text}), lower(${quoteLiteral(f.value ?? '')}))`
    case 'equals':
      if (f.value === undefined) return `${c} IS NULL`
      if (f.numeric) return `${c} = ${lit(f.value)}`
      return f.exact ? `${text} = ${quoteLiteral(f.value)}` : `lower(${text}) = lower(${quoteLiteral(f.value)})`
    case 'not_equals':
      if (f.value === undefined) return `${c} IS NOT NULL`
      if (f.numeric) return `${c} IS DISTINCT FROM ${lit(f.value)}`
      return f.exact ? `${text} IS DISTINCT FROM ${quoteLiteral(f.value)}` : `lower(${text}) IS DISTINCT FROM lower(${quoteLiteral(f.value)})`
    case 'in': {
      const vals = (f.values ?? []).filter((v): v is string => v !== null)
      const list = vals.map((v) => (f.numeric ? lit(v) : quoteLiteral(v))).join(', ')
      const inList = vals.length ? `${f.numeric ? c : text} IN (${list})` : ''
      const withNull = (f.values ?? []).includes(null)
      return withNull ? (inList ? `(${inList} OR ${c} IS NULL)` : `${c} IS NULL`) : inList || 'false'
    }
    case 'is_null':
      return `${c} IS NULL`
    case 'not_null':
      return `${c} IS NOT NULL`
    case 'gt':
      return `${c} > ${lit(f.value ?? '')}`
    case 'gte':
      return `${c} >= ${lit(f.value ?? '')}`
    case 'lt':
      return `${c} < ${lit(f.value ?? '')}`
    case 'lte':
      return `${c} <= ${lit(f.value ?? '')}`
    case 'between':
      return `${c} BETWEEN ${lit(f.value ?? '')} AND ${lit(f.value2 ?? '')}`
  }
}

/** Internal row-number column (named so it can't collide with a real column). */
export const ROW = '__sheetah_row'

/** Find: literal, case-insensitive, any column you can see. "1,234" also finds the stored 1234. */
function searchSql(q: string, hidden: string[] = []): string {
  const cols = hidden.length ? `COLUMNS(c -> c NOT IN (${hidden.map(quoteLiteral).join(', ')}))` : 'COLUMNS(*)'
  const hay = `lower(concat_ws(' ', *${cols}))`
  const n = parseNumber(q)
  const alt = n !== null && n !== q.trim() ? ` OR contains(${hay}, ${quoteLiteral(n)})` : ''
  const one = `contains(${hay}, lower(${quoteLiteral(q)}))`
  return alt ? `(${one}${alt})` : one
}

/** "SELECT * FROM orders" (one table, nothing else): filters can go straight onto it. */
const PLAIN_TABLE = /^SELECT\s+\*\s+FROM\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)$/i

/** Adds a filter, merging a picked value into an existing pick on the same column (city = 'Delhi' → city IN ('Delhi', 'Pune')). */
export function addFilter(filters: Filter[], f: Filter): Filter[] {
  const picked = (x: Filter) => x.column === f.column && x.exact && (x.op === 'in' || x.op === 'equals')
  const i = filters.findIndex(picked)
  if (!f.exact || f.op !== 'equals' || i < 0) return [...filters.filter((x) => JSON.stringify(x) !== JSON.stringify(f)), f]
  const prev = filters[i]
  const values = prev.op === 'in' ? [...(prev.values ?? [])] : [prev.value ?? null]
  const v = f.value ?? null
  if (!values.includes(v)) values.push(v)
  const merged: Filter = { ...prev, op: 'in', values, value: undefined }
  return filters.map((x, j) => (j === i ? merged : x))
}

/** Values picked for a column from its list (the IN filter), or [] if none. */
export function pickedValues(filters: Filter[], column: string): (string | null)[] {
  const f = filters.find((x) => x.column === column && x.exact && (x.op === 'in' || x.op === 'equals'))
  if (!f) return []
  return f.op === 'in' ? (f.values ?? []) : [f.value ?? null]
}

/** Un-picks one value: the IN list shrinks, becomes a plain equals with one value, or goes away. */
export function removePick(filters: Filter[], column: string, value: string | null): Filter[] {
  return filters.flatMap((f) => {
    if (f.column !== column || !f.exact || !(f.op === 'in' || f.op === 'equals')) return [f]
    const values = (f.op === 'in' ? (f.values ?? []) : [f.value ?? null]).filter((v) => v !== value)
    if (!values.length) return []
    if (values.length === 1) return [{ ...f, op: 'equals', value: values[0] ?? undefined, values: undefined } as Filter]
    return [{ ...f, op: 'in', values, value: undefined }]
  })
}

/** All filters except the picked-values one on `column`. */
export const removePickAll = (filters: Filter[], column: string) =>
  filters.filter((f) => !(f.column === column && f.exact && (f.op === 'in' || f.op === 'equals')))

export function compose(base: string, ops: Ops): string {
  const sql = composeRows(base, ops)
  if (!ops.hidden?.length) return sql
  const core = (splitStatements(base).at(-1) ?? base).trim().replace(/;+\s*$/, '')
  const plain = PLAIN_TABLE.exec(core)
  // Hiding is the last step: filters and sorting can still use the hidden columns.
  const from = sql === core && plain ? sqlName(unquote(plain[1])) : `(\n${sql}\n)`
  return `SELECT * EXCLUDE (${ops.hidden.map(sqlName).join(', ')})\nFROM ${from}`
}

function composeRows(base: string, ops: Ops): string {
  // Only the last statement is a query; anything before it has already run.
  const core = (splitStatements(base).at(-1) ?? base).trim().replace(/;+\s*$/, '')
  if (!hasOps(ops)) return core
  let sql = core
  // A plain "SELECT * FROM t" isn't wrapped again: the result reads like SQL a person would write.
  const plain = PLAIN_TABLE.exec(core)
  const from = (inner: string) => (PLAIN_TABLE.test(inner) && plain && inner === core ? sqlName(unquote(plain[1])) : `(\n${inner}\n)`)
  // Rows that aren't data go first, before anything (filling down, say) can make them look like data.
  if (ops.drop?.length) sql = `SELECT *\nFROM ${from(sql)}\nWHERE ${ops.drop.map((d) => d.keep).join('\n  AND ')}`
  // Cleaning comes next, so filters, sorting and new columns see the converted values.
  if (ops.clean?.length) sql = cleanSql(from(sql), ops.clean)
  for (const l of ops.lookups ?? []) sql = lookupSql(from(sql), l)
  if (ops.computed.length) {
    const extra = ops.computed.map((c) => `${c.expr} AS ${quoteIdent(c.name)}`).join(',\n  ')
    sql = `SELECT *,\n  ${extra}\nFROM ${from(sql)}`
  }
  const where = [
    ...ops.filters.map(filterSql),
    // Find: any column, as text, case-insensitively (a literal match: % and _ are just characters).
    ...(ops.search ? [searchSql(ops.search, ops.hidden)] : []),
  ]
  if (ops.dedupe) {
    const c = sqlName(ops.dedupe.column)
    const inner = where.length ? `SELECT *\nFROM ${from(sql)}\nWHERE ${where.join('\n  AND ')}` : sql
    const src = where.length ? `(\n${inner}\n)` : from(inner)
    // Empty values aren't duplicates of each other: they're never shown as repeats, and always kept.
    sql =
      ops.dedupe.mode === 'show'
        ? `SELECT *\nFROM ${src}\nQUALIFY ${c} IS NOT NULL AND count(*) OVER (PARTITION BY ${c}) > 1\nORDER BY ${c}`
        : // Keep the first row of each value, in the original order (a window would reorder rows otherwise).
          `SELECT * EXCLUDE (${ROW})\nFROM (SELECT *, row_number() OVER () AS ${ROW} FROM ${src})\nQUALIFY ${c} IS NULL OR row_number() OVER (PARTITION BY ${c} ORDER BY ${ROW}) = 1\nORDER BY ${ROW}`
    if (ops.sort) sql = `SELECT *\nFROM (\n${sql}\n)\nORDER BY ${sqlName(ops.sort.column)} ${ops.sort.dir.toUpperCase()} NULLS LAST`
    return sql
  }
  if (where.length || ops.sort) {
    let outer = `SELECT *\nFROM ${from(sql)}`
    if (where.length) outer += `\nWHERE ${where.join('\n  AND ')}`
    if (ops.sort) outer += `\nORDER BY ${sqlName(ops.sort.column)} ${ops.sort.dir.toUpperCase()} NULLS LAST`
    sql = outer
  }
  return sql
}

const unquote = (n: string) => (n.startsWith('"') ? n.slice(1, -1).replace(/""/g, '"') : n)

/** The table a plain "SELECT * FROM t" reads, or null for any other query. */
export function plainTable(sql: string): string | null {
  const m = PLAIN_TABLE.exec(sql.trim().replace(/;+\s*$/, ''))
  return m ? unquote(m[1]) : null
}

const show = (v: string | null | undefined) => (v === null || v === undefined ? 'empty' : v === '' ? '(blank)' : v)

const asPercent = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 4 })

export function describeFilter(f: Filter): string {
  if (f.percent) {
    const pct = (v: string | null | undefined) => (v === null || v === undefined || !Number.isFinite(Number(v)) || v.trim() === '' ? v : asPercent.format(Number(v)))
    return describeFilter({ ...f, percent: false, value: pct(f.value) ?? undefined, value2: pct(f.value2) ?? undefined, values: f.values?.map((v) => pct(v) ?? null) })
  }
  switch (f.op) {
    case 'contains':
      return `${f.column} contains “${f.value}”`
    case 'not_contains':
      return `${f.column} doesn’t contain “${f.value}”`
    case 'starts_with':
      return `${f.column} starts with “${f.value}”`
    case 'equals':
      return f.value === undefined ? `${f.column} is empty` : `${f.column} = ${show(f.value)}`
    case 'not_equals':
      return f.value === undefined ? `${f.column} is not empty` : `${f.column} ≠ ${show(f.value)}`
    case 'in': {
      const vals = (f.values ?? []).map(show)
      return vals.length > 3 ? `${f.column} is ${vals.slice(0, 2).join(', ')} or ${vals.length - 2} more` : `${f.column} is ${vals.join(' or ')}`
    }
    case 'is_null':
      return `${f.column} is empty`
    case 'not_null':
      return `${f.column} is not empty`
    case 'gt':
      return `${f.column} > ${f.value}`
    case 'gte':
      return `${f.column} ≥ ${f.value}`
    case 'lt':
      return `${f.column} < ${f.value}`
    case 'lte':
      return `${f.column} ≤ ${f.value}`
    case 'between':
      return `${f.column} between ${f.value} and ${f.value2}`
  }
}

/** The steps that tidy a table (rows left out, columns cleaned, looked up or added): not the ones that only narrow the view. */
export function tidySteps(o: Ops): { ops: Ops; count: number } {
  const ops: Ops = { ...emptyOps(), drop: o.drop, clean: o.clean, lookups: o.lookups, computed: o.computed, dedupe: o.dedupe?.mode === 'remove' ? o.dedupe : undefined }
  const count = (o.drop?.length ?? 0) + (o.clean?.length ?? 0) + (o.lookups?.length ?? 0) + o.computed.length + (ops.dedupe ? 1 : 0)
  return { ops, count }
}

/** How many steps (chips) there are: each filter, clean-up, look-up, added or hidden column, and the rest. */
export const stepCount = (o: Ops) =>
  (o.drop?.length ?? 0) + (o.clean?.length ?? 0) + (o.lookups?.length ?? 0) + o.computed.length + o.filters.length + (o.hidden?.length ?? 0) + (o.sort ? 1 : 0) + (o.search ? 1 : 0) + (o.dedupe ? 1 : 0)

/** Text only these steps write (each clean-up's expression, added columns, rows left out): to tell their SQL from a query of one's own. */
export function stepMarks(o: Ops): string[] {
  return [...(o.clean ?? []).map(cleanExpr), ...o.computed.map((c) => c.expr), ...(o.drop ?? []).map((d) => d.keep)].filter((m) => m.length >= 6)
}

/** SQL written against the table, made to read its tidied rows: a CTE of the same name, which shadows it. */
export function onTidiedRows(sql: string, table: string, tidied: string, steps: number): string {
  // Comments above the query stay on top; a query with its own WITH gets one more entry in it.
  const lead = /^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/.exec(sql)?.[0] ?? ''
  const body = sql.slice(lead.length)
  const cte = `${sqlName(table)} AS (\n${tidied}\n)`
  const note = `-- ${table} with its ${steps} tidy-up ${steps === 1 ? 'step' : 'steps'}\n`
  const own = /^WITH(\s+RECURSIVE)?\s+/i.exec(body)
  return own ? `${lead}${note}${own[0]}${cte},\n${body.slice(own[0].length)}` : `${lead}${note}WITH ${cte}\n${body}`
}
