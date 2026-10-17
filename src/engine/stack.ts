import { commentText, isNumericType, quoteLiteral, sqlName } from './sql'
import type { TableColumns } from './compare-sql'

/*
 * Stack tables: twelve monthly exports become one table. Columns are matched by name (UNION ALL BY
 * NAME), so a column missing from one file is simply empty for its rows, and an optional column says
 * which table each row came from. A column whose type differs between tables (a date in one file, text
 * in another) is stacked as text; numbers stay numbers.
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

/** Columns that are not in every table (empty for the others' rows), and columns stacked as text. */
export function stackReport(tables: TableColumns[]): { partial: string[]; asText: string[]; columns: number } {
  const all = columnTypes(tables)
  const partial = [...all.values()].filter((c) => tables.some((t) => !t.columns.some((x) => x.name.toLowerCase() === c.name.toLowerCase()))).map((c) => c.name)
  const asText = [...all.values()].filter((c) => needsText(c.types)).map((c) => c.name)
  return { partial, asText, columns: all.size }
}

const isTime = (t: string) => /^(DATE|TIMESTAMP)/i.test(t)
/** Numbers stack with numbers and dates with timestamps; any other mix is stacked as text. */
const needsText = (types: Set<string>) => types.size > 1 && ![...types].every(isNumericType) && ![...types].every(isTime)

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
    const casts = t.columns.filter((c) => needsText(all.get(c.name.toLowerCase())!.types)).map((c) => `${sqlName(c.name)}::VARCHAR AS ${sqlName(c.name)}`)
    const star = casts.length ? `* REPLACE (${casts.join(', ')})` : '*'
    return `SELECT ${spec.source ? `${quoteLiteral(t.name)} AS ${sqlName(spec.source)}, ` : ''}${star} FROM ${sqlName(t.name)}`
  })
  return [commentText(`-- Stack ${chosen.length} tables: ${chosen.map((t) => t.name).join(', ')}`), parts.join('\nUNION ALL BY NAME\n')].join('\n')
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
