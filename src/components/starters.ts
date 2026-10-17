import { isNumericType, nameKey, sqlName } from '../engine/sql'

export interface Starter {
  label: string
  sql: string
  /** Show the result as a chart rather than a grid. */
  chart?: boolean
}

/** Starter queries for the built-in sample table (see createDemo in engine/ingest.ts). */
export const sampleStarters = (t: string): Starter[] => [
  {
    label: 'Revenue by city',
    sql: `SELECT city, round(sum(total)) AS revenue, count(*) AS orders\nFROM ${t}\nWHERE status = 'delivered'\nGROUP BY city\nORDER BY revenue DESC`,
  },
  {
    label: 'Monthly revenue',
    chart: true,
    // Complete months only: the sample's last month is partial and would read as a crash.
    sql: `SELECT date_trunc('month', ordered_at) AS month, round(sum(total)) AS revenue\nFROM ${t}\nWHERE ordered_at < (SELECT date_trunc('month', max(ordered_at)) FROM ${t})\nGROUP BY month\nORDER BY month`,
  },
  {
    label: 'Best sellers',
    sql: `SELECT product, sum(quantity) AS units, round(sum(total)) AS revenue\nFROM ${t}\nGROUP BY product\nORDER BY units DESC\nLIMIT 10`,
  },
  {
    label: 'Return rate by category',
    sql: `SELECT category,\n  round(100.0 * count(*) FILTER (WHERE status = 'returned') / count(*), 1) AS return_pct\nFROM ${t}\nGROUP BY category\nORDER BY return_pct DESC`,
  },
]

export interface StarterColumn {
  name: string
  type: string
  /** Approximate distinct values (from the table), when known. */
  distinct?: number
}

// Anchored: INTEGER[] or DATE[] (lists, from JSON or Parquet) can't be summed or bucketed by month.
const TEMPORAL = /^(DATE|TIMESTAMP|TIMESTAMP WITH TIME ZONE|TIMESTAMPTZ|TIMESTAMP_(S|MS|NS))$/i
const TEXT = /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|BOOLEAN)$|^ENUM\(/i
/** Numbers that are labels, not amounts: summing them means nothing. */
const NOT_A_MEASURE = /(^|_)(id|code|no|num|number|pin|zip|zipcode|postcode|phone|mobile|year|yr|month|day|week|lat|latitude|lng|lon|longitude|rank|index|idx|invoice|order|serial|sr|sno|ticket|ref)$/i
/** Names that usually hold the number people want totals of, best first. */
const MEASURE_WORDS = ['revenue', 'sales', 'amount', 'total', 'value', 'price', 'cost', 'salary', 'balance', 'profit', 'spend', 'quantity', 'qty', 'units', 'score', 'count']
/** Names that usually hold a category worth grouping by, best first. */
const CATEGORY_WORDS = ['category', 'type', 'status', 'segment', 'region', 'state', 'city', 'country', 'department', 'team', 'channel', 'source', 'product', 'brand', 'plan']

const rank = (name: string, words: string[]) => {
  const n = name.toLowerCase()
  const i = words.findIndex((w) => n.includes(w))
  return i < 0 ? words.length : i
}

/**
 * One-click questions for any table, from its column names, types and sizes: totals by a category,
 * a monthly trend, the largest rows, and a summary of every column. Everything is plain SQL the user
 * can read and edit; nothing is guessed that the columns don't support.
 */
export function startersFor(table: string, cols: StarterColumn[], rows?: number): Starter[] {
  const t = sqlName(table)
  const isInt = (c: StarterColumn) => /INT$/i.test(c.type)
  // A whole number that's different on (nearly) every row is a row number or an ID, not an amount, unless its
  // name says otherwise (salary). Distinct counts are estimates, off by up to ~20%: hence 0.8.
  const unique = (c: StarterColumn) =>
    isInt(c) && rows !== undefined && rows > 10 && (c.distinct ?? 0) >= rows * 0.8 && rank(c.name, MEASURE_WORDS) === MEASURE_WORDS.length
  const measure = cols
    .filter((c) => isNumericType(c.type) && !NOT_A_MEASURE.test(nameKey(c.name)) && !unique(c) && (c.distinct ?? 3) > 2)
    // Names that sound like amounts first, then decimals before whole numbers.
    .sort((a, b) => rank(a.name, MEASURE_WORDS) - rank(b.name, MEASURE_WORDS) || Number(isInt(a)) - Number(isInt(b)))[0]
  // Text that names an amount (a rate or price stored as text) is a number to convert, not a category:
  // by its last word ("Unit Rate", "GST %"), so "Cost Centre" and "Country" stay categories.
  const amountLike = (c: StarterColumn) => /(^|[^a-z])(rate|price|amount|amt|cost|tax|value|total|balance|qty|quantity)s?$|%$/i.test(c.name.trim())
  const category = cols
    .filter((c) => TEXT.test(c.type) && c.distinct !== undefined && c.distinct >= 2 && c.distinct <= 60 && !amountLike(c))
    .sort((a, b) => rank(a.name, CATEGORY_WORDS) - rank(b.name, CATEGORY_WORDS) || (a.distinct ?? 0) - (b.distinct ?? 0))[0]
  const time = cols.find((c) => TEMPORAL.test(c.type) && !/birth|dob/i.test(c.name))
  const m = measure && sqlName(measure.name)
  const total = measure && sqlName(`total_${measure.name.replace(/\W+/g, '_').toLowerCase()}`)
  const out: Starter[] = []

  if (category) {
    const c = sqlName(category.name)
    out.push(
      measure
        ? {
            label: `${measure.name} by ${category.name}`,
            sql: `SELECT ${c}, count(*) AS row_count, round(sum(${m}), 2) AS ${total}\nFROM ${t}\nGROUP BY ${c}\nORDER BY ${total} DESC NULLS LAST`,
          }
        : { label: `Rows by ${category.name}`, sql: `SELECT ${c}, count(*) AS row_count\nFROM ${t}\nGROUP BY ${c}\nORDER BY row_count DESC` },
    )
  }
  if (time) {
    const d = sqlName(time.name)
    out.push({
      label: measure ? `${measure.name} per month` : 'Rows per month',
      chart: true,
      // GROUP BY 1: a table with its own "month" column would otherwise group by that instead.
      sql: `SELECT date_trunc('month', ${d}) AS month, ${measure ? `round(sum(${m}), 2) AS ${total}` : 'count(*) AS row_count'}\nFROM ${t}\nWHERE ${d} IS NOT NULL\nGROUP BY 1\nORDER BY 1`,
    })
  }
  if (measure) out.push({ label: `Top 10 by ${measure.name}`, sql: `SELECT *\nFROM ${t}\nORDER BY ${m} DESC NULLS LAST\nLIMIT 10` })
  out.push({ label: 'Summary of every column', sql: `SUMMARIZE ${t}` })
  return out
}
