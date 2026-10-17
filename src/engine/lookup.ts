import { commentText, isIdLike, isNumericType, sqlName } from './sql'

/*
 * Look up values from another table: the spreadsheet VLOOKUP / XLOOKUP, as a LEFT JOIN that can never
 * add rows. Every row of the result stays exactly once; rows without a match get empty values. If the
 * other table has the key more than once, the first row (in its own order) wins, as in a spreadsheet.
 */
export interface Lookup {
  /** The other table. */
  table: string
  /** Column in the current result to match on. */
  here: string
  /** Column in the other table to match against. */
  there: string
  /** Columns to bring over, and the name each gets in the result (renamed if the result already has it). */
  bring: { column: string; as: string }[]
  /** Match text ignoring case and spaces at the ends (spreadsheet lookups do). */
  loose: boolean
  /** The key's type on each side (decides whether keys are matched as text). */
  types: { here: string; there: string }
  /** The other table is a view (a Parquet file read in place): it has no row order to pick "the first" by. */
  view?: boolean
}

const isText = (type: string) => /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)/i.test(type.trim())
const isTime = (type: string) => /^(DATE|TIMESTAMP)/i.test(type.trim())

/**
 * The expression a key is matched by on one side, given both sides' types:
 *   - numbers with numbers (any width) as they are; dates with timestamps as timestamps
 *   - a number against text: the text read as a number ('1001' matches 1001, and 1001.0)
 *   - anything else that differs: both as text
 *   - text, when matching loosely: lower-cased and trimmed
 */
export function keyExpr(ref: string, type: string, otherType: string, loose: boolean): string {
  if (isNumericType(type) && isNumericType(otherType)) return ref
  if (isTime(type) && isTime(otherType)) return type === otherType ? ref : `${ref}::TIMESTAMP`
  if (isNumericType(type) && isText(otherType)) return `${ref}::DOUBLE`
  if (isText(type) && isNumericType(otherType)) return `TRY_CAST(trim(${ref}) AS DOUBLE)`
  const text = isText(type) && isText(otherType) ? ref : `${ref}::VARCHAR`
  return loose ? `lower(trim(${text}))` : text
}

/** Whether a key is compared as text (then a blank key matches nothing, not other blanks). */
const textKey = (type: string, otherType: string) => !(isNumericType(type) || isNumericType(otherType)) && !(isTime(type) && isTime(otherType))

/** Output names for brought columns: their own name, or name_<table> (then _2, _3…) if the result has it. */
export function lookupNames(existing: string[], table: string, columns: string[]): { column: string; as: string }[] {
  const taken = new Set(existing.map((c) => c.toLowerCase()))
  return columns.map((column) => {
    const options = [column, `${column}_${table}`]
    let as = options.find((o) => !taken.has(o.toLowerCase()))
    for (let i = 2; !as; i++) if (!taken.has(`${column}_${table}_${i}`.toLowerCase())) as = `${column}_${table}_${i}`
    taken.add(as.toLowerCase())
    return { column, as }
  })
}

/**
 * SQL for one lookup step around `src` (a table name or a parenthesised query). `types` gives the key
 * column's type on each side. The other table is reduced to one row per key first, keeping its first
 * row: the join can't multiply the result's rows.
 */
export function lookupSql(src: string, l: Lookup): string {
  const { types } = l
  const hereKey = keyExpr(`q.${sqlName(l.here)}`, types.here, types.there, l.loose)
  const thereKey = keyExpr(sqlName(l.there), types.there, types.here, l.loose)
  const picks = l.bring.map((b) => `${sqlName(b.column)} AS ${sqlName(b.as)}`)
  const blank = textKey(types.there, types.here) ? ` AND trim(${sqlName(l.there)}::VARCHAR) <> ''` : ''
  // Rows are numbered first and put back in that order: a join may hand them back in any order.
  return [
    `SELECT * EXCLUDE (${POS})`,
    `FROM (`,
    `  SELECT q.*, ${l.bring.map((b) => `l.${sqlName(b.as)}`).join(', ')}`,
    `  FROM (SELECT *, row_number() OVER () AS ${POS} FROM ${src}) AS q`,
    `  LEFT JOIN (`,
    commentText(`    -- one row per ${l.there} in ${l.table} (the first, if it repeats)`),
    `    SELECT ${thereKey} AS ${KEY}, ${picks.join(', ')}`,
    `    FROM ${sqlName(l.table)}`,
    `    WHERE ${sqlName(l.there)} IS NOT NULL${blank}`,
    `    QUALIFY row_number() OVER (PARTITION BY ${thereKey}${l.view ? '' : ' ORDER BY rowid'}) = 1`,
    `  ) AS l ON ${hereKey} = l.${KEY}`,
    `)`,
    `ORDER BY ${POS}`,
  ].join('\n')
}

/** Working names inside the lookup query (prefixed so they can't meet the data's own columns). */
const POS = '__sheetah_lookup_pos'
const KEY = '__sheetah_lookup_key'

/** How well a lookup matches: rows of the result with a match, and keys repeated in the other table. */
export function lookupStatsSql(src: string, l: Pick<Lookup, 'table' | 'here' | 'there' | 'loose' | 'types'>): string {
  const { types } = l
  const hereKey = keyExpr(`q.${sqlName(l.here)}`, types.here, types.there, l.loose)
  const thereKey = keyExpr(sqlName(l.there), types.there, types.here, l.loose)
  const blank = textKey(types.there, types.here) ? ` AND trim(${sqlName(l.there)}::VARCHAR) <> ''` : ''
  return [
    `WITH k AS (SELECT ${thereKey} AS key, count(*) AS n FROM ${sqlName(l.table)} WHERE ${sqlName(l.there)} IS NOT NULL${blank} GROUP BY 1)`,
    `SELECT`,
    `  (SELECT count(*) FROM ${src} AS q)::DOUBLE AS rows,`,
    `  (SELECT count(*) FROM ${src} AS q JOIN k ON ${hereKey} = k.key)::DOUBLE AS matched,`,
    `  (SELECT count(*) FROM k WHERE n > 1)::DOUBLE AS repeated`,
  ].join('\n')
}

/** The values that find no match, most rows first: what to fix (a code typed differently, a missing row). */
export function lookupMissesSql(src: string, l: Pick<Lookup, 'table' | 'here' | 'there' | 'loose' | 'types'>, limit = 5): string {
  const { types } = l
  const hereKey = keyExpr(`q.${sqlName(l.here)}`, types.here, types.there, l.loose)
  const thereKey = keyExpr(sqlName(l.there), types.there, types.here, l.loose)
  return [
    `WITH k AS (SELECT DISTINCT ${thereKey} AS key FROM ${sqlName(l.table)} WHERE ${sqlName(l.there)} IS NOT NULL)`,
    `SELECT q.${sqlName(l.here)}::VARCHAR AS v, count(*)::DOUBLE AS n`,
    `FROM ${src} AS q ANTI JOIN k ON ${hereKey} = k.key`,
    `WHERE q.${sqlName(l.here)} IS NOT NULL AND trim(q.${sqlName(l.here)}::VARCHAR) <> ''`,
    `GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${Math.floor(limit)}`,
  ].join('\n')
}

/** The column in the other table most likely to match `here`: same name, then a similar one. */
export function suggestMatch(here: string, columns: { name: string }[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const exact = columns.find((c) => c.name === here) ?? columns.find((c) => norm(c.name) === norm(here))
  if (exact) return exact.name
  const KEYISH = /(id|code|no|num|number|key)$/
  const stem = norm(here).replace(KEYISH, '')
  if (stem.length < 3) return null
  const similar = columns.filter((c) => norm(c.name).startsWith(stem))
  // cust_code ↔ cust_no before cust_code ↔ customer: an identifier for an identifier.
  return (similar.find((c) => KEYISH.test(norm(c.name))) ?? similar[0])?.name ?? null
}

/**
 * The likeliest look-up when nothing is picked yet: a column of the result and a table that has a
 * column of the same (or a similar) name, identifiers first (customer_id ↔ customer_id beats name ↔ name).
 */
export function bestPair(columns: { name: string }[], tables: { name: string; columns: { name: string }[] }[]): { here: string; table: string } | null {
  let best: { here: string; table: string; score: number } | null = null
  for (const t of tables) {
    for (const c of columns) {
      const m = suggestMatch(c.name, t.columns)
      if (!m) continue
      const score = (m === c.name ? 3 : m.toLowerCase().replace(/[^a-z0-9]/g, '') === c.name.toLowerCase().replace(/[^a-z0-9]/g, '') ? 2 : 1) + (isIdLike(c.name) ? 1 : 0)
      if (!best || score > best.score) best = { here: c.name, table: t.name, score }
    }
  }
  return best && { here: best.here, table: best.table }
}

export const describeLookup = (l: Lookup) => `${l.bring.map((b) => b.as).join(', ')} from ${l.table}`
