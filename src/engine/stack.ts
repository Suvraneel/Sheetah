import { numberText, textOf } from './clean'
import { commentText, isNumericType, quoteIdent, quoteLiteral, sqlName } from './sql'
import type { TableColumns } from './compare-sql'

/*
 * Stack tables: twelve monthly exports become one table. Columns are matched by name (UNION ALL BY
 * NAME), so a column missing from one file is simply empty for its rows, and an optional column says
 * which table each row came from. A column that is numbers in some tables and text in others (one month's
 * "N/A", a quoted "1,234.50") is read as numbers, and what isn't one is counted before stacking; any
 * other mix (a date in one file, text in another) is stacked as text; numbers stay numbers.
 */
export interface StackSpec {
  tables: string[]
  /** Name of the column saying which table a row came from (null: no such column). */
  source: string | null
}

/** Every column name across the tables (first spelling wins), with the types it has. */
function columnTypes(tables: TableColumns[]): Map<string, { name: string; types: Set<string> }> {
  const all = new Map<string, { name: string; types: Set<string> }>()
  for (const t of tables) {
    for (const c of t.columns) {
      const key = c.name.toLowerCase()
      const entry = all.get(key) ?? { name: c.name, types: new Set<string>() }
      entry.types.add(c.type)
      all.set(key, entry)
    }
  }
  return all
}

/**
 * Columns that are not in every table (empty for the others' rows), columns stacked as text, and columns
 * read as numbers (with the tables they're text in).
 */
export function stackReport(tables: TableColumns[]): { partial: string[]; asText: string[]; asNumbers: { column: string; tables: string[] }[]; columns: number } {
  const all = columnTypes(tables)
  const partial = [...all.values()].filter((c) => tables.some((t) => !t.columns.some((x) => x.name.toLowerCase() === c.name.toLowerCase()))).map((c) => c.name)
  const asText = [...all.values()].filter((c) => needsText(c.types)).map((c) => c.name)
  const asNumbers = [...all.values()]
    .filter((c) => readAsNumbers(c.types))
    .map((c) => ({ column: c.name, tables: tables.filter((t) => t.columns.some((x) => x.name.toLowerCase() === c.name.toLowerCase() && isText(x.type))).map((t) => t.name) }))
  return { partial, asText, asNumbers, columns: all.size }
}

const isTime = (t: string) => /^(DATE|TIMESTAMP)/i.test(t)
const isText = (t: string) => /^VARCHAR/i.test(t)
/** Numbers in some tables, text in others: the text read as numbers. */
const readAsNumbers = (types: Set<string>) => [...types].some(isText) && [...types].some(isNumericType) && [...types].every((t) => isText(t) || isNumericType(t))
/** Numbers stack with numbers and dates with timestamps; any other mix (but numbers and text) is stacked as text. */
const needsText = (types: Set<string>) => types.size > 1 && ![...types].every(isNumericType) && ![...types].every(isTime) && !readAsNumbers(types)
/** A text value read as a number, the way people write them (1,234.50, (250), ₹99): empty if it isn't one. */
const asNumber = (ref: string) => `TRY_CAST(${numberText(textOf(ref), false)} AS DOUBLE)`

/** A name for the source column that no table already uses: "source", then "source_table", … */
export function sourceName(tables: TableColumns[]): string {
  const taken = new Set(tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())))
  for (const name of ['source', 'source_table', 'source_file']) if (!taken.has(name)) return name
  let i = 2
  while (taken.has(`source_${i}`)) i++
  return `source_${i}`
}

export function stackSql(spec: StackSpec, tables: TableColumns[]): string {
  const chosen = spec.tables.map((n) => tables.find((t) => t.name === n)).filter((t): t is TableColumns => !!t)
  const all = columnTypes(chosen)
  const parts = chosen.map((t) => {
    const casts = t.columns.flatMap((c) => {
      const types = all.get(c.name.toLowerCase())!.types
      if (needsText(types)) return [`${sqlName(c.name)}::VARCHAR AS ${sqlName(c.name)}`]
      if (readAsNumbers(types) && isText(c.type)) return [`${asNumber(sqlName(c.name))} AS ${sqlName(c.name)}`]
      return []
    })
    const star = casts.length ? `* REPLACE (${casts.join(', ')})` : '*'
    return `SELECT ${spec.source ? `${quoteLiteral(t.name)} AS ${sqlName(spec.source)}, ` : ''}${star} FROM ${sqlName(t.name)}`
  })
  return [commentText(`-- Stack ${chosen.length} tables: ${chosen.map((t) => t.name).join(', ')}`), parts.join('\nUNION ALL BY NAME\n')].join('\n')
}

/**
 * What reading text as numbers would leave empty: one row per table and column with values that aren't
 * numbers (`lost`), and one of them (`example`). Run before stacking, so the dialog can say so.
 */
export function stackLossSql(tables: TableColumns[]): string | null {
  const all = columnTypes(tables)
  const parts = tables.flatMap((t) =>
    t.columns
      .filter((c) => isText(c.type) && readAsNumbers(all.get(c.name.toLowerCase())!.types))
      .map((c) => {
        const ref = sqlName(c.name)
        return `SELECT ${quoteLiteral(t.name)} AS tbl, ${quoteLiteral(c.name)} AS col, count(*)::DOUBLE AS lost, any_value(${textOf(ref)}) AS example FROM ${sqlName(t.name)} WHERE ${textOf(ref)} <> '' AND ${asNumber(ref)} IS NULL`
      }),
  )
  return parts.length ? `SELECT * FROM (\n${parts.join('\nUNION ALL\n')}\n) WHERE lost > 0` : null
}

/**
 * Rows that are in more than one of the tables (every column the same): a month and its revision both
 * picked, say, would count those rows twice. The pairs of tables with how many rows they share, most first.
 */
export function stackOverlapSql(spec: StackSpec, tables: TableColumns[]): string {
  const src = quoteIdent('__stack_source')
  const stacked = stackSql({ tables: spec.tables, source: '__stack_source' }, tables).replace(/^--.*\n/, '')
  // Each row's columns but the source, as one value to group by.
  return `SELECT list_sort(tables) AS tables, count(*)::DOUBLE AS n FROM (
  SELECT list(DISTINCT ${src}) AS tables FROM (
    SELECT ${src}, struct_pack(*COLUMNS(* EXCLUDE (${src}))) AS __row FROM (
${stacked}
    )
  ) GROUP BY __row HAVING count(DISTINCT ${src}) > 1
) GROUP BY 1 ORDER BY 2 DESC LIMIT 3`
}

/** Tables that look like the same export as `name` (most columns shared), including itself, in the sidebar's (name) order. */
export function stackCandidates(name: string, tables: TableColumns[]): string[] {
  const me = tables.find((t) => t.name === name)
  if (!me) return []
  const mine = new Set(me.columns.map((c) => c.name.toLowerCase()))
  return tables
    .filter((t) => {
      const shared = t.columns.filter((c) => mine.has(c.name.toLowerCase())).length
      return shared / Math.max(mine.size, t.columns.length) >= 0.6
    })
    .map((t) => t.name)
}
