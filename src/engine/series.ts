/*
 * A report laid out one column per month, quarter or year (Jan, Feb, … Dec; Q1…Q4; 2023-24): which of its
 * columns form the series, from their names alone. Small, so the suggestion to unpivot costs nothing until
 * it's taken (the unpivot itself is in unpivot.ts).
 */

export type SeriesKind = 'month' | 'quarter' | 'year'

const MONTH = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?([\s\-_'’/]*\d{2,4})?$/
/** 2024-01, 2024/1, and Excel's month headers read as dates (2024-01-01). */
const YEAR_MONTH = /^(19|20)\d{2}([-/_ ](0?[1-9]|1[0-2])|-(0[1-9]|1[0-2])-01)$/
const QUARTER = /^(q[1-4]([\s\-_'’/]*(fy)?\d{2,4})?|(fy\s*\d{2,4}|(19|20)\d{2})[\s\-_/]*q[1-4])$/
const YEAR = /^(fy[\s\-_']*)?(19|20)\d{2}([-/](\d{2}|\d{4}))?$/
/** Indian financial years: 2023-24, 2008-09 (not September 2008). */
const FINANCIAL_YEAR = /^(fy[\s\-_']*)?((19|20)\d{2})[-/](\d{2})$/

/** A period's column name without a statistics office's marks: "2023 [note 3]", "2022 (p)", "2021*" → 2023, 2022, 2021. */
export const periodName = (name: string) =>
  name.replace(/\s*(\[[^\]]{1,30}\]|\((p|r|e|f|est|prov|provisional|revised|estimated?)\)|\*+)\s*/gi, ' ').trim()

function kindOf(name: string): SeriesKind | null {
  const n = periodName(name).toLowerCase()
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
