import { commentText, isNumericType, quoteLiteral, sqlName } from './sql'

/*
 * Compare two tables (two monthly exports, two sheets): which rows were added, removed or changed,
 * and in which columns. Like every other action it compiles to readable SQL that lands in the editor:
 *   - by key: a FULL JOIN on the key columns, one IS DISTINCT FROM test per compared column
 *   - whole rows (no key): EXCEPT ALL in both directions
 * The result has a `change` column (added / removed / changed / same) the grid colours by, and for
 * changed rows `changed_columns` plus <column>_before / <column>_after pairs.
 */
export interface TableColumns {
  name: string
  columns: { name: string; type: string }[]
  /** The table's rows as tidied by its steps (total lines left out, text converted), when it has them. */
  source?: string
}

export interface CompareSpec {
  before: string
  after: string
  mode: 'key' | 'row'
  keys: string[]
  /** Shared non-key columns to compare. */
  columns: string[]
  /** Text compares ignoring spaces at the ends and doubled spaces inside. */
  trimSpaces: boolean
  /** Text compares ignoring upper / lower case. */
  ignoreCase: boolean
  /** Numbers with decimals closer than this count as equal (null: exact). Whole numbers are always exact. */
  tolerance: number | null
  /** Also list rows that didn't change. */
  includeSame: boolean
}

export interface SchemaDiff {
  shared: string[]
  onlyBefore: string[]
  onlyAfter: string[]
  /** Shared columns whose type differs (compared as text). */
  typeChanged: { name: string; before: string; after: string }[]
}

const lower = (s: string) => s.toLowerCase()
export const find = (t: TableColumns, name: string) => t.columns.find((c) => lower(c.name) === lower(name))

export function schemaDiff(before: TableColumns, after: TableColumns): SchemaDiff {
  const shared = before.columns.filter((c) => find(after, c.name)).map((c) => c.name)
  return {
    shared,
    onlyBefore: before.columns.filter((c) => !find(after, c.name)).map((c) => c.name),
    onlyAfter: after.columns.filter((c) => !find(before, c.name)).map((c) => c.name),
    typeChanged: shared
      .map((name) => ({ name, before: find(before, name)!.type, after: find(after, name)!.type }))
      .filter((c) => c.before !== c.after),
  }
}

const typeOf = (t: TableColumns, name: string) => find(t, name)?.type ?? 'VARCHAR'
const isText = (type: string) => /^(VARCHAR|TEXT|STRING|CHAR)/i.test(type)
/** Numbers that can have decimals: floating point and DECIMAL(p, s>0). */
const hasDecimals = (type: string) => /^(DOUBLE|FLOAT|REAL)$/i.test(type) || /^(DECIMAL|NUMERIC)\s*\(\s*\d+\s*,\s*[1-9]\d*\s*\)$/i.test(type)

/**
 * How a column is compared when its type differs between the tables: numbers as numbers (100 = 100.0),
 * anything else as text.
 */
function common(name: string, before: TableColumns, after: TableColumns): 'same' | 'number' | 'text' {
  const ta = typeOf(before, name)
  const tb = typeOf(after, name)
  if (ta === tb) return 'same'
  return isNumericType(ta) && isNumericType(tb) ? 'number' : 'text'
}

/** Where everything goes in a compare result: the marker column, the changed-columns list, the before/after pairs. */
export interface CompareLayout {
  change: string
  /** Keyed comparisons only. */
  changed: string | null
  /** Keyed comparisons only: "status: Pending → Paid; city: Pune → Mumbai". */
  what: string | null
  pairs: { column: string; before: string; after: string }[]
}

/**
 * Output names that can't collide with the data's own columns: "change" (or row_change, row_change_2…
 * when taken), "changed_columns", and <column>_before / _after (with a further suffix when taken).
 */
export function compareLayout(spec: Pick<CompareSpec, 'keys' | 'columns' | 'mode'>): CompareLayout {
  const taken = new Set([...spec.keys, ...spec.columns].map(lower))
  const claim = (...options: string[]) => {
    for (let i = 0; ; i++) {
      const name = i < options.length ? options[i] : `${options[options.length - 1]}_${i - options.length + 2}`
      if (!taken.has(lower(name))) {
        taken.add(lower(name))
        return name
      }
    }
  }
  const change = claim('change', 'row_change')
  const keyed = spec.mode === 'key' && spec.keys.length > 0
  if (!keyed) return { change, changed: null, what: null, pairs: [] }
  const changed = claim('changed_columns')
  const what = claim('what_changed')
  return { change, changed, what, pairs: spec.columns.map((column) => ({ column, before: claim(`${column}_before`), after: claim(`${column}_after`) })) }
}

/** The output column holding added / removed / changed. */
export const changeColumn = (spec: Pick<CompareSpec, 'keys' | 'columns' | 'mode'>) => compareLayout(spec).change

/** The test for "this column changed" between a and b, honouring the options and type differences. */
function changedTest(name: string, spec: CompareSpec, before: TableColumns, after: TableColumns): string {
  const c = sqlName(name)
  const ta = typeOf(before, name)
  const tb = typeOf(after, name)
  const a = `a.${c}`
  const b = `b.${c}`
  if (ta !== tb && !(isNumericType(ta) && isNumericType(tb))) return `${a}::VARCHAR IS DISTINCT FROM ${b}::VARCHAR`
  // Tolerance is for rounding noise in numbers with decimals: whole numbers always compare exactly.
  // Computed in DOUBLE, so unsigned or huge values can't overflow the subtraction.
  if (spec.tolerance !== null && (hasDecimals(ta) || hasDecimals(tb))) {
    return `coalesce(abs(${a}::DOUBLE - ${b}::DOUBLE) > ${spec.tolerance}, ${a} IS DISTINCT FROM ${b})`
  }
  if (isText(ta) && (spec.trimSpaces || spec.ignoreCase)) {
    const norm = (x: string) => {
      const t = spec.trimSpaces ? `regexp_replace(trim(${x}), '\\s+', ' ', 'g')` : x
      return spec.ignoreCase ? `lower(${t})` : t
    }
    return `${norm(a)} IS DISTINCT FROM ${norm(b)}`
  }
  return `${a} IS DISTINCT FROM ${b}`
}

export function compareSql(spec: CompareSpec, before: TableColumns, after: TableColumns): string {
  const A = sqlName(spec.before)
  const B = sqlName(spec.after)
  const cols = spec.columns
  const layout = compareLayout(spec)
  const out = sqlName(layout.change)
  if (spec.mode === 'row' || !spec.keys.length) {
    // No key: a row is "the same" only if every compared column matches; duplicates count (EXCEPT ALL).
    const pick = cols
      .map((n) => {
        const kind = common(n, before, after)
        return kind === 'same' ? sqlName(n) : `${sqlName(n)}::${kind === 'number' ? 'DOUBLE' : 'VARCHAR'} AS ${sqlName(n)}`
      })
      .join(', ')
    return [
      commentText(`-- Compare whole rows: ${spec.before} (before) → ${spec.after} (after)`),
      `SELECT 'removed' AS ${out}, * FROM (`,
      `  SELECT ${pick} FROM ${A}`,
      `  EXCEPT ALL`,
      `  SELECT ${pick} FROM ${B}`,
      `)`,
      `UNION ALL`,
      `SELECT 'added' AS ${out}, * FROM (`,
      `  SELECT ${pick} FROM ${B}`,
      `  EXCEPT ALL`,
      `  SELECT ${pick} FROM ${A}`,
      `)`,
      `ORDER BY 1`,
    ].join('\n')
  }

  const keyName = spec.keys.map(sqlName)
  // A key stored as a number in one file and as text in the other is matched as text.
  const side = (t: 'a' | 'b', k: string) => `${t}.${sqlName(k)}${common(k, before, after) === 'text' ? '::VARCHAR' : ''}`
  // Working columns get a __sheetah_ prefix, so they can't meet the data's own names.
  const flag = (i: number) => `__sheetah_changed_${i}`
  const ADDED = '__sheetah_added'
  const REMOVED = '__sheetah_removed'
  const inner = [
    ...spec.keys.map((k, i) => `coalesce(${side('a', k)}, ${side('b', k)}) AS ${keyName[i]}`),
    `a.__sheetah_in IS NULL AS ${ADDED}`,
    `b.__sheetah_in IS NULL AS ${REMOVED}`,
    ...cols.map((n, i) => `${changedTest(n, spec, before, after)} AS ${flag(i)}`),
    ...layout.pairs.flatMap((p) => [`a.${sqlName(p.column)} AS ${sqlName(p.before)}`, `b.${sqlName(p.column)} AS ${sqlName(p.after)}`]),
  ]
  const anyChange = cols.map((_, i) => flag(i)).join(' OR ') || 'false'
  const kind = `CASE WHEN ${ADDED} THEN 'added' WHEN ${REMOVED} THEN 'removed' WHEN ${anyChange} THEN 'changed' ELSE 'same' END`
  // The change itself, readable without scrolling to the before/after columns.
  // Whole numbers read as typed (3169, not the 3169.0 a DOUBLE prints as); text "2.0" stays "2.0".
  const shown = (x: string) =>
    `coalesce(left(CASE WHEN typeof(${x}) IN ('DOUBLE', 'FLOAT') THEN regexp_replace(${x}::VARCHAR, '^(-?[0-9]+)\\.0$', '\\1') ELSE ${x}::VARCHAR END, 40), '(empty)')`
  const whatChanged = cols.length
    ? `concat_ws('; ', ${layout.pairs.map((p, i) => `CASE WHEN ${flag(i)} THEN ${quoteLiteral(`${p.column}: `)} || ${shown(sqlName(p.before))} || ' → ' || ${shown(sqlName(p.after))} END`).join(', ')})`
    : `''`
  const listChanged = cols.length ? `concat_ws(', ', ${cols.map((n, i) => `CASE WHEN ${flag(i)} THEN ${quoteLiteral(n)} END`).join(', ')})` : `''`
  const outer = [
    ...keyName,
    `${kind} AS ${out}`,
    `CASE WHEN NOT (${ADDED} OR ${REMOVED}) THEN ${listChanged} END AS ${sqlName(layout.changed!)}`,
    `CASE WHEN NOT (${ADDED} OR ${REMOVED}) THEN ${whatChanged} END AS ${sqlName(layout.what!)}`,
    ...layout.pairs.flatMap((p) => [sqlName(p.before), sqlName(p.after)]),
  ]
  return [
    commentText(`-- Compare: ${spec.before} (before) → ${spec.after} (after), matched by ${spec.keys.join(', ')}`),
    `WITH j AS (`,
    `  SELECT`,
    `    ${inner.join(',\n    ')}`,
    `  FROM (SELECT *, true AS __sheetah_in FROM ${A}) AS a`,
    `  FULL JOIN (SELECT *, true AS __sheetah_in FROM ${B}) AS b ON ${spec.keys.map((k) => `${side('a', k)} = ${side('b', k)}`).join(' AND ')}`,
    `)`,
    `SELECT`,
    `  ${outer.join(',\n  ')}`,
    `FROM j`,
    spec.includeSame ? null : `WHERE ${ADDED} OR ${REMOVED} OR ${anyChange}`,
    `ORDER BY CASE WHEN ${REMOVED} THEN 1 WHEN ${ADDED} THEN 2 WHEN ${anyChange} THEN 3 ELSE 4 END, ${keyName.join(', ')}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

/**
 * The two tables most worth comparing, before → after: the open one and its other version if it has
 * one, else the pair sharing the most columns (the later-listed as "after"). None when nothing's shared.
 */
export function likelyPair(tables: TableColumns[], open?: string | null): { before: string; after: string } | null {
  const current = open ? tables.find((t) => t.name.toLowerCase() === open.toLowerCase()) : undefined
  const twin = current ? similarTable(current.name, tables) : null
  if (current && twin) return inOrder(twin, current.name)
  let best: { before: string; after: string } | null = null
  let top = 0
  for (const [i, a] of tables.entries()) {
    for (const b of tables.slice(i + 1)) {
      const score = schemaDiff(a, b).shared.length / Math.max(1, a.columns.length, b.columns.length)
      if (score > top) [top, best] = [score, inOrder(a.name, b.name)]
    }
  }
  return best
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * The period a table's name says (customers_sep, sales_2024_03, report-202403, Q1 FY25…), as months counted
 * from year 0 (or within the year, when no year is written), or null.
 */
export function periodOf(name: string): { months: number; year: boolean } | null {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).flatMap((w) => w.match(/[a-z]+|[0-9]+/g) ?? [])
  let year: number | null = null
  let month: number | null = null
  for (const [i, w] of words.entries()) {
    const m = MONTHS.findIndex((x) => w.startsWith(x) && (w.length === 3 || 'january february march april may june july august september october november december sept'.split(' ').some((full) => full === w)))
    if (m >= 0 && month === null) {
      month = m
      // A year after the month: sep_2024, sep24.
      const next = words[i + 1]
      if (next && /^\d{4}$/.test(next) && year === null) year = Number(next)
      else if (next && /^\d{2}$/.test(next) && year === null) year = 2000 + Number(next)
    } else if (/^(19|20)\d{2}(0[1-9]|1[0-2])$/.test(w) && month === null) {
      // 202403
      year = Number(w.slice(0, 4))
      month = Number(w.slice(4)) - 1
    } else if (/^(19|20)\d{2}$/.test(w) && year === null) {
      year = Number(w)
      const next = words[i + 1]
      if (next && /^(0?[1-9]|1[0-2])$/.test(next) && month === null) month = Number(next) - 1
    }
  }
  if (month === null && year === null) return null
  return { months: (year ?? 0) * 12 + (month ?? 0), year: year !== null }
}

/** Two versions of an export, the earlier first when their names say which (customers_sep before customers_oct). */
export function inOrder(a: string, b: string): { before: string; after: string } {
  const [p, q] = [periodOf(a), periodOf(b)]
  if (!p || !q || p.months === q.months || p.year !== q.year) return { before: a, after: b }
  // Months alone: December before January, as one year turns into the next.
  const diff = q.months - p.months
  const later = p.year ? diff > 0 : (diff > 0 && diff <= 6) || diff < -6
  return later ? { before: a, after: b } : { before: b, after: a }
}

/** Pairs of tables with mostly the same columns: likely two versions of one export. */
export function similarTable(name: string, tables: TableColumns[]): string | null {
  const me = tables.find((t) => t.name === name)
  if (!me || !me.columns.length) return null
  let best: { name: string; score: number } | null = null
  for (const t of tables) {
    if (t.name === name || !t.columns.length) continue
    const d = schemaDiff(me, t)
    const score = d.shared.length / Math.max(me.columns.length, t.columns.length)
    if (score >= 0.8 && (!best || score > best.score)) best = { name: t.name, score }
  }
  return best?.name ?? null
}
