/*
 * Ageing: what's outstanding, by party, in buckets of how long it has been due (not yet due, up to 30 days,
 * 31 to 60…). From a list of open bills (Tally's Bills Receivable or Payable, an outstanding invoices
 * export): one row per party, the oldest money easy to see. Loaded only when asked for.
 */
import { commentText, quoteIdent, quoteLiteral, sqlName } from './sql'
import type { AgeingColumns } from './statement'

const BUCKETS: [string, string][] = [
  ['0–30 days', 'age BETWEEN 0 AND 30'],
  ['31–60 days', 'age BETWEEN 31 AND 60'],
  ['61–90 days', 'age BETWEEN 61 AND 90'],
  ['91–180 days', 'age BETWEEN 91 AND 180'],
  ['Over 180 days', 'age > 180'],
]

/**
 * One row per party, biggest first, and a total: each bucket's sum. `asOf` is the day the ages are counted
 * to (YYYY-MM-DD, today usually). Counted from the due date, money not due yet has its own column.
 */
export function ageingSql(rows: string, a: AgeingColumns, asOf: string, numeric: (name: string) => boolean): string {
  const amount = numeric(a.amount) ? `${sqlName(a.amount)}::DOUBLE` : `number_from_cr_dr(${sqlName(a.amount)}::VARCHAR)`
  // What's owed, by its age; an advance (the other way round) on account, whatever its date.
  const buckets: [string, string][] = [
    ...(a.by === 'due' ? ([['Not yet due', 'age < 0']] as [string, string][]) : []),
    ...BUCKETS,
    ['No date', 'age IS NULL'],
  ].map(([name, when]) => [name, `amount > 0 AND ${when}`] as [string, string])
  buckets.push(['On account', 'amount < 0'])
  const sums = buckets.map(([name, when]) => `coalesce(sum(amount) FILTER (WHERE ${when}), 0) AS ${quoteIdent(name)}`).join(',\n  ')
  const cols = [...buckets.map(([name]) => quoteIdent(name)), 'Total']
  const P = quoteIdent(a.party)
  return `${commentText(`-- Ageing of ${a.amount} by ${a.party}, as of ${asOf}: days since ${a.by === 'due' ? `it fell due (${a.date})` : `the bill (${a.date})`}`)}
WITH r AS (
  SELECT coalesce(nullif(trim(${sqlName(a.party)}::VARCHAR), ''), '(none)') AS party, ${amount} AS amount,
    date_diff('day', ${sqlName(a.date)}::DATE, ${quoteLiteral(asOf)}::DATE) AS age
  FROM (
${rows}
  )
),
-- What's owed counts as plus, whichever way it's written ("12,000.00 Dr" owed to us, "Cr" owed by us):
-- an advance the other way round counts against it.
t AS (SELECT party, amount * CASE WHEN sum(amount) FILTER (WHERE NOT is_total_label(party)) OVER () < 0 THEN -1 ELSE 1 END AS amount, age FROM r),
p AS (
  SELECT party,
  ${sums},
  coalesce(sum(amount), 0) AS Total
  -- A total line the steps didn't leave out isn't a party.
  FROM t WHERE amount IS NOT NULL AND amount <> 0 AND NOT is_total_label(party)
  GROUP BY party
)
SELECT ${P}, ${cols.map((c) => `round(${c}, 2) AS ${c}`).join(', ')} FROM (
  SELECT 0 AS o, party AS ${P}, ${cols.join(', ')} FROM p
  UNION ALL
  SELECT 1, 'Total', ${cols.map((c) => `sum(${c})`).join(', ')} FROM p
)
ORDER BY o, Total DESC, ${P}`
}
