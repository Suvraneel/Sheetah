/*
 * Matching payments: the bank statement against the books (or a supplier's statement against the purchase
 * register). Each line is matched to one line of the other table with the same amount, on a date up to a
 * few days apart (a cheque clears days after it's written). What's left over is what to look into: in the
 * bank and not in the books, or the other way round. The whole match is one readable query.
 */
import { commentText, isNumericType, quoteLiteral, sqlName } from './sql'
import { statementColumns } from './statement'

export interface MatchSide {
  table: string
  /** The rows matched: the table as tidied by its steps (total lines left out, text converted), or the table. */
  source?: string
  /** The date matched on (a DATE or TIMESTAMP column). */
  date: string
  /** The amount: one signed column, or money in less money out. */
  amount: { column: string } | { credit: string; debit: string }
  /** Words to show beside each line (a narration, a party's name). */
  text?: string
}

export interface MatchSpec {
  a: MatchSide
  b: MatchSide
  /** How many days apart two lines' dates can be. */
  days: number
  /** The other table records money the other way round (its receipts as minus, its payments as plus). */
  flip: boolean
}

interface Col {
  name: string
  type: string
}

const isTime = (c: Col) => /^(DATE|TIMESTAMP)/i.test(c.type)
const isText = (c: Col) => /CHAR|TEXT|STRING/i.test(c.type)
const AMOUNT = /(^|[^a-z])(amount|amt|value|total|net|sum)([^a-z]|$)/i
const TEXT = /narration|description|particulars|details|remarks|memo|party|payee|name|ledger|account/i
/** Rounds of pairing: each pairs every line with the line that is nearest to it, if that one pairs back. */
const ROUNDS = 4

/** A table's side of the match, guessed from its columns: null when it has no date or no amount. */
export function sideFor(table: { name: string; columns: Col[] }): MatchSide | null {
  const cols = table.columns
  const date = cols.filter(isTime).sort((x, y) => Number(/date/i.test(y.name)) - Number(/date/i.test(x.name)))[0]
  if (!date) return null
  const st = statementColumns(cols)
  // Never a date ("Value Date" says value), an ID or a balance.
  const money = (c: Col) => !/date|balance|(^|[^a-z])(id|no|number|code)$/i.test(c.name)
  const one = cols.find((c) => money(c) && AMOUNT.test(c.name) && (isNumericType(c.type) || isText(c))) ?? cols.find((c) => money(c) && isNumericType(c.type))
  const amount = st ? { credit: st.credit, debit: st.debit } : one ? { column: one.name } : null
  if (!amount) return null
  const text = cols.find((c) => isText(c) && TEXT.test(c.name)) ?? cols.find(isText)
  return { table: table.name, date: date.name, amount, ...(text ? { text: text.name } : {}) }
}

/** The rows a side reads, as SQL. */
const from = (s: MatchSide) => (s.source ? `(\n${s.source}\n)` : sqlName(s.table))

/**
 * A side's amount, signed and to the paisa. Text reads as a clean-up would read it, Cr and Dr included;
 * what can't be read stays empty (so the line is listed, not lost).
 */
function amountSql(s: MatchSide, numeric: (side: MatchSide, column: string) => boolean): { value: string; written: string } {
  const n = (c: string) => (numeric(s, c) ? `${sqlName(c)}::DOUBLE` : `number_from_cr_dr(${sqlName(c)}::VARCHAR)`)
  const has = (c: string) => `nullif(trim(${sqlName(c)}::VARCHAR), '') IS NOT NULL`
  if ('column' in s.amount) return { value: `round(${n(s.amount.column)}, 2)`, written: has(s.amount.column) }
  const { credit, debit } = s.amount
  // Money in less money out: an empty side counts as nothing, but both unreadable is no amount.
  return {
    value: `CASE WHEN ${n(credit)} IS NOT NULL OR ${n(debit)} IS NOT NULL THEN round(coalesce(${n(credit)}, 0) - coalesce(${n(debit)}, 0), 2) END`,
    written: `(${has(credit)} OR ${has(debit)})`,
  }
}

/**
 * The two tables' lines as the match reads them: a number for each line, its date, amount and words.
 * Lines whose amount is nothing at all (0, or both sides empty: an opening balance line) are left out;
 * one written but not readable as a number ("Rs. 500/-") is kept, with no amount, to be looked at.
 */
function sides(spec: MatchSpec, numeric: (side: MatchSide, column: string) => boolean): string {
  const side = (k: 'a' | 'b', s: MatchSide, sign: string) => {
    const amt = amountSql(s, numeric)
    return `${k} AS MATERIALIZED (
  SELECT * FROM (
    SELECT row_number() OVER () AS ${k}_row, ${sqlName(s.date)}::DATE AS ${k}_date, ${sign}${amt.value} AS amount, ${amt.written} AS written,
      ${s.text ? `${sqlName(s.text)}::VARCHAR` : 'NULL'} AS ${k}_text
    FROM ${from(s)}
  )
  WHERE amount <> 0 OR (amount IS NULL AND written)
)`
  }
  return `WITH ${side('a', spec.a, '')},\n${side('b', spec.b, spec.flip ? '-' : '')}`
}

const days = (n: number) => Math.max(0, Math.min(366, Math.floor(n)))

/**
 * First, lines on the same day for the same amount, the first with the first, the second with the second
 * (five payments of 500 on one day pair up at once); then every other possible pair among the rest: the
 * same amount, dated up to `days` apart (found day by day, so repeated amounts stay cheap).
 */
const candidates = (n: number) => `round0 AS (
  SELECT a_row, b_row
  FROM (SELECT a_row, amount, a_date, row_number() OVER (PARTITION BY amount, a_date ORDER BY a_row) AS o FROM a WHERE amount IS NOT NULL) AS x
  JOIN (SELECT b_row, amount, b_date, row_number() OVER (PARTITION BY amount, b_date ORDER BY b_row) AS o FROM b WHERE amount IS NOT NULL) AS y
    ON x.amount = y.amount AND x.a_date = y.b_date AND x.o = y.o
),
done0 AS (SELECT * FROM round0),
pairs0 AS MATERIALIZED (
  SELECT a_row, b_row, abs(k) AS gap, a.amount
  FROM (SELECT * FROM a WHERE a_row NOT IN (SELECT a_row FROM done0)) AS a CROSS JOIN range(${-days(n)}, ${days(n) + 1}) AS r(k)
  JOIN (SELECT * FROM b WHERE b_row NOT IN (SELECT b_row FROM done0)) AS b ON b.amount = a.amount AND b.b_date = a.a_date + k::INTEGER
)`

/**
 * One round of pairing, among the lines not yet paired: each line takes the nearest line by date; a tie
 * goes to the line in the same place among that amount's lines (the third 500 with the third 500), so
 * repeats pair up in one round. A pair is kept when both lines chose each other.
 */
function round(i: number): string {
  const done = `done${i - 1}`
  const left = (k: 'a' | 'b') =>
    `(SELECT ${k}_row, row_number() OVER (PARTITION BY amount ORDER BY ${k}_date, ${k}_row) AS ${k}_rank FROM ${k} WHERE ${k}_row NOT IN (SELECT ${k}_row FROM ${done})) AS left_${k}`
  return `round${i} AS (
  SELECT a_row, b_row FROM pairs0 JOIN ${left('a')} USING (a_row) JOIN ${left('b')} USING (b_row)
  QUALIFY row_number() OVER (PARTITION BY a_row ORDER BY gap, abs(a_rank - b_rank), b_row) = 1
    AND row_number() OVER (PARTITION BY b_row ORDER BY gap, abs(a_rank - b_rank), a_row) = 1
),
done${i} AS (SELECT * FROM ${done} UNION ALL SELECT * FROM round${i})`
}

/** The status of each line: matched, or only in one of the two tables. */
export const statusLabels = (spec: MatchSpec) => ({ matched: 'matched', a: `only in ${spec.a.table}`, b: `only in ${spec.b.table}` })

/** The output's column names: each table's date, and its words (named after their column). */
export function matchColumns(spec: MatchSpec) {
  return {
    aDate: `${spec.a.table} date`,
    bDate: `${spec.b.table} date`,
    aText: `${spec.a.table}: ${spec.a.text ?? 'text'}`,
    bText: `${spec.b.table}: ${spec.b.text ?? 'text'}`,
  }
}

/**
 * The match as a query: every line of both tables once, matched lines side by side. Pairing goes in
 * rounds of "each other's nearest", so a line missing on one side doesn't pull its neighbours apart.
 */
export function matchSql(spec: MatchSpec, numeric: (side: MatchSide, column: string) => boolean): string {
  const st = statusLabels(spec)
  const c = matchColumns(spec)
  const [aDate, bDate, aText, bText] = [c.aDate, c.bDate, c.aText, c.bText].map(sqlName)
  const n = days(spec.days)
  const rounds = Array.from({ length: ROUNDS }, (_, i) => round(i + 1)).join(',\n')
  return `${commentText(`-- Match: ${spec.a.table} against ${spec.b.table}, by amount, dates up to ${n} ${n === 1 ? 'day' : 'days'} apart${spec.flip ? ` (${spec.b.table}'s amounts the other way round)` : ''}`)}
${sides(spec, numeric)},
${candidates(n)},
${rounds},
pairs AS (SELECT * FROM done${ROUNDS})
SELECT * FROM (
  SELECT ${quoteLiteral(st.matched)} AS status, a_date AS ${aDate}, b_date AS ${bDate}, a.amount, a_text AS ${aText}, b_text AS ${bText}, date_diff('day', a_date, b_date) AS days_apart
  FROM pairs JOIN a USING (a_row) JOIN b USING (b_row)
  UNION ALL
  SELECT ${quoteLiteral(st.a)}, a_date, NULL, amount, a_text, NULL, NULL FROM a WHERE a_row NOT IN (SELECT a_row FROM pairs)
  UNION ALL
  SELECT ${quoteLiteral(st.b)}, NULL, b_date, amount, NULL, b_text, NULL FROM b WHERE b_row NOT IN (SELECT b_row FROM pairs)
)
ORDER BY coalesce(${aDate}, ${bDate}), status`
}

/** How many lines, and how much, each status gets: for the dialog's preview. */
export const matchCountsSql = (sql: string) => `SELECT status, count(*)::DOUBLE AS n, sum(amount)::DOUBLE AS total FROM (\n${sql}\n) GROUP BY status`

/**
 * Which way round the other table records money: how many lines of the first have a line of the same
 * amount within the days allowed, as the other's amounts are and turned round. A cash book often writes a
 * receipt the way the bank writes a payment.
 */
export function directionSql(spec: MatchSpec, numeric: (side: MatchSide, column: string) => boolean): string {
  const n = days(spec.days)
  // The other's amounts and days once each: a line of the first has a partner if its amount is there within the days.
  const near = (sign: string) =>
    `(SELECT count(DISTINCT a_row) FROM a CROSS JOIN range(${-n}, ${n + 1}) AS r(k) JOIN bd ON bd.amount = ${sign}a.amount AND bd.b_date = a.a_date + k::INTEGER)`
  return `${sides({ ...spec, flip: false }, numeric)},
bd AS (SELECT DISTINCT amount, b_date FROM b WHERE amount IS NOT NULL)
SELECT ${near('')}::DOUBLE AS same, ${near('-')}::DOUBLE AS flipped`
}
