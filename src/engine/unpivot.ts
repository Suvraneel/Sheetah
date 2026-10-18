import { commentText, isNumericType, quoteIdent, sqlName } from './sql'
import { seriesColumns, type SeriesKind } from './series'

/*
 * Unpivot: a report laid out one column per month (Jan, Feb, … Dec) becomes one row per month, so it
 * can be filtered, charted and pivoted like any other data. DuckDB's UNPIVOT does the work; this
 * module writes the SQL (series.ts finds the columns that form such a series).
 */
export interface UnpivotSpec {
  columns: string[]
  /** Name of the new column holding the old column names ("month"). */
  name: string
  /** Name of the new column holding the values ("amount"). */
  value: string
  /** Keep empty cells as rows with an empty value (otherwise they're left out). */
  keepEmpty?: boolean
}

export { seriesColumns }

/** A name for the new name and value columns that no remaining column already uses. */
export function unpivotNames(kind: SeriesKind | null, remaining: string[]): { name: string; value: string } {
  const taken = new Set(remaining.map((c) => c.toLowerCase()))
  const free = (base: string) => {
    let n = base
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base}_${i}`
    taken.add(n.toLowerCase())
    return n
  }
  return { name: free(kind ?? 'column'), value: free('value') }
}

const family = (type: string) => (isNumericType(type) ? 'number' : /^(DATE|TIMESTAMP)/i.test(type.trim()) ? 'time' : type.trim().toUpperCase())

/**
 * SELECT * FROM src UNPIVOT (value FOR name IN (the columns)). Numbers of different widths share a type on their
 * own, and so do dates and timestamps. Columns with nothing in them (read as text, a month not reached
 * yet) take the others' type. Only when real text meets numbers is every column read as text, so
 * nothing fails to convert.
 */
export function unpivotSql(src: string, spec: UnpivotSpec, types: { name: string; type: string }[], empty: string[] = []): string {
  const typeOf = (c: string) => types.find((t) => t.name === c)?.type ?? 'VARCHAR'
  const filled = spec.columns.filter((c) => !empty.includes(c))
  const kinds = new Set(filled.map((c) => family(typeOf(c))))
  const mixed = kinds.size > 1
  const target = mixed ? 'VARCHAR' : filled.length ? typeOf(filled[0]) : null
  const casts = [
    ...(mixed ? filled.map((c) => `${sqlName(c)}::VARCHAR AS ${sqlName(c)}`) : []),
    ...(target ? spec.columns.filter((c) => empty.includes(c) && typeOf(c) !== target).map((c) => `NULL::${target} AS ${sqlName(c)}`) : []),
  ]
  const from = casts.length ? `(\n  SELECT * REPLACE (${casts.join(', ')})\n  FROM ${src}\n)` : src
  // The standard form (FROM … UNPIVOT (value FOR name IN …)): a SELECT that nests, and the only one
  // that takes INCLUDE NULLS on a subquery.
  return [
    commentText(`-- Turn ${spec.columns.length} columns into rows: one per ${spec.name}`),
    'SELECT *',
    `FROM ${from}`,
    `UNPIVOT${spec.keepEmpty ? ' INCLUDE NULLS' : ''} (${quoteIdent(spec.value)} FOR ${quoteIdent(spec.name)} IN (${spec.columns.map(sqlName).join(', ')}))`,
  ].join('\n')
}
