import { commentText, isNumericType, quoteIdent, sqlName } from './sql'

/*
 * Unpivot: a report laid out one column per month (Jan, Feb, … Dec) becomes one row per month, so it
 * can be filtered, charted and pivoted like any other data. DuckDB's UNPIVOT does the work; this
 * module finds the columns that form such a series and writes the SQL.
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

type SeriesKind = 'month' | 'quarter' | 'year'

const MONTH = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?([\s\-_'’/]*\d{2,4})?$/
/** 2024-01, 2024/1, and Excel's month headers read as dates (2024-01-01). */
const YEAR_MONTH = /^(19|20)\d{2}([-/_ ](0?[1-9]|1[0-2])|-(0[1-9]|1[0-2])-01)$/
const QUARTER = /^(q[1-4]([\s\-_'’/]*(fy)?\d{2,4})?|(fy\s*\d{2,4}|(19|20)\d{2})[\s\-_/]*q[1-4])$/
const YEAR = /^(fy[\s\-_']*)?(19|20)\d{2}([-/](\d{2}|\d{4}))?$/
/** Indian financial years: 2023-24, 2008-09 (not September 2008). */
const FINANCIAL_YEAR = /^(fy[\s\-_']*)?((19|20)\d{2})[-/](\d{2})$/

function kindOf(name: string): SeriesKind | null {
  const n = name.trim().toLowerCase()
  const fy = FINANCIAL_YEAR.exec(n)
  if (fy && Number(fy[4]) === (Number(fy[2]) + 1) % 100) return 'year'
  if (MONTH.test(n) || YEAR_MONTH.test(n)) return 'month'
  if (QUARTER.test(n)) return 'quarter'
  if (YEAR.test(n)) return 'year'
  return null
}

/** Columns that are a series of months, quarters or years (three or more of the same kind), if any. */
export function seriesColumns(columns: { name: string; type: string }[]): { kind: SeriesKind; columns: string[] } | null {
  const by = new Map<SeriesKind, string[]>()
  for (const c of columns) {
    const k = kindOf(c.name)
    if (k) by.set(k, [...(by.get(k) ?? []), c.name])
  }
  // Q1 … Q20 of a survey are questions, not quarters.
  if (columns.some((c) => /^q([5-9]|\d{2,})\b/i.test(c.name.trim()))) by.delete('quarter')
  let best: { kind: SeriesKind; columns: string[] } | null = null
  for (const [kind, cols] of by) if (cols.length >= 3 && (!best || cols.length > best.columns.length)) best = { kind, columns: cols }
  return best
}

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
