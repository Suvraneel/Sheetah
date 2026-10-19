/*
 * The bank reconciliation statement, from a match of the bank statement against the books: the bank's
 * closing balance, and each kind of line found on one side only, taking it to the balance the books
 * should show. What an accountant writes up at each month's end, made from the lines the match left over
 * (loaded only when one is asked for).
 */
import type { MatchSide, MatchSpec } from './match'
import { matchColumns, statusLabels } from './match'
import { commentText, LOCALE, quoteLiteral, sqlName } from './sql'
import { statementColumns, type StatementColumns } from './statement'

interface Col {
  name: string
  type: string
}

/** Which side of the match is the bank (a statement with a running balance, not the books), and its columns. */
export function bankOf(columns: { a: Col[]; b: Col[] }): { bank: 'a' | 'b'; statement: (StatementColumns & { balance: string }) | null } {
  const st = { a: statementColumns(columns.a), b: statementColumns(columns.b) }
  const isBank = (k: 'a' | 'b') => !!st[k] && !st[k]!.books
  const withBalance = (k: 'a' | 'b') => isBank(k) && !!st[k]!.balance
  // A statement with its running balance, else a statement, else the first table (as the match lists it).
  const bank = withBalance('a') ? 'a' : withBalance('b') ? 'b' : isBank('a') ? 'a' : isBank('b') ? 'b' : 'a'
  const s = st[bank]
  return { bank, statement: s && s.balance && !s.books ? { ...s, balance: s.balance } : null }
}

/** A side's rows numbered in their order (as `rowid`), for the balance check's queries over a tidied side. */
export const numberedRows = (s: MatchSide) => `(SELECT row_number() OVER () - 1 AS rowid, * FROM (\n${s.source ?? `SELECT * FROM ${sqlName(s.table)}`}\n))`

export interface Reconcile {
  /** The match's own query. */
  match: string
  spec: MatchSpec
  bank: 'a' | 'b'
  /** The bank statement's closing balance (its running balance where the statement ends), when it has one. */
  closing: number | null
  /** The last day the statement covers. */
  asOf?: string | null
}

/** A day as people write it ("19 Apr 2024", or "Apr 19, 2024"): in a sentence, never a date to misread. */
const day = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d)
}

/**
 * The statement as a query, laid out as one is written: Particulars, Date, Amount (each line), Total (each
 * heading). From the bank's closing balance, each kind of line found on one side only, added or taken off
 * on the way to the balance the books should show; each heading's lines under it. Without the bank's
 * closing balance, the headings and what they come to: the books less the bank. Lines with no date (a
 * balance or total line the steps didn't leave out) aren't counted, and the statement says how many.
 */
export function brsSql({ match, spec, bank, closing, asOf }: Reconcile): string {
  const st = statusLabels(spec)
  const c = matchColumns(spec)
  const [bankName, booksName] = bank === 'a' ? [spec.a.table, spec.b.table] : [spec.b.table, spec.a.table]
  const [bankOnly, booksOnly] = bank === 'a' ? [st.a, st.b] : [st.b, st.a]
  // The match's amounts are in its first table's terms (the second's turned round when it records money the
  // other way): in the bank's terms, they're turned back when the bank is the second, written the other way.
  const sign = bank === 'b' && spec.flip ? '-' : ''
  // Each heading, the lines under it (by side and way), and what it does on the way from the bank to the books.
  const heads: [number, string, string, number][] = [
    [2, 'Add: deposits not yet credited by the bank', `status = ${quoteLiteral(booksOnly)} AND amount > 0`, 1],
    [3, 'Less: cheques issued, not yet presented', `status = ${quoteLiteral(booksOnly)} AND amount < 0`, -1],
    [4, 'Less: credits by the bank, not in the books', `status = ${quoteLiteral(bankOnly)} AND amount > 0`, -1],
    [5, 'Add: debits by the bank, not in the books', `status = ${quoteLiteral(bankOnly)} AND amount < 0`, 1],
  ]
  const dated = `coalesce(${sqlName(c.aDate)}, ${sqlName(c.bDate)})`
  const money = closing === null ? null : `${closing}::DOUBLE`
  const net = `(SELECT coalesce(sum(a * s), 0) FROM g)`
  const top = money
    ? `SELECT 1 AS h, 0 AS o, ${quoteLiteral(`Balance as per bank statement${asOf ? ` on ${day(asOf)}` : ''}`)} AS p, NULL::DATE AS d, NULL::DOUBLE AS a, ${money} AS t\nUNION ALL\n`
    : ''
  const end = money
    ? `SELECT 6, 0, 'Balance as per books (should be)', NULL, NULL, ${money} + ${net}`
    : `SELECT 6, 0, ${quoteLiteral(`${booksName} less ${bankName}: the headings above, net`)}, NULL, NULL, ${net}`
  return `${commentText(`-- Bank reconciliation: ${bankName} against ${booksName}, from the payments matched`)}
WITH m AS (
${match}
),
k AS (SELECT status, ${sign}amount AS amount, ${dated} AS d, coalesce(${sqlName(c.aText)}, ${sqlName(c.bText)}) AS t, note FROM m WHERE status <> ${quoteLiteral(st.matched)} AND amount IS NOT NULL),
heads AS (SELECT * FROM (VALUES ${heads.map(([h, p, , s]) => `(${h}, ${quoteLiteral(p)}, ${s})`).join(', ')}) v(h, p, s)),
-- Each line under its heading, as a positive amount (the heading says add or less).
g AS (
  SELECT CASE ${heads.map(([h, , when]) => `WHEN ${when} THEN ${h}`).join(' ')} END AS h, d, t, note, abs(amount) AS a,
    CASE ${heads.map(([, , when, s]) => `WHEN ${when} THEN ${s}`).join(' ')} END AS s
  FROM k WHERE d IS NOT NULL
)
SELECT p AS "Particulars", d AS "Date", round(a, 2)::DECIMAL(18, 2) AS "Amount", round(t, 2)::DECIMAL(18, 2) AS "Total" FROM (
${top}SELECT h, 0 AS o, p, NULL::DATE AS d, NULL::DOUBLE AS a, (SELECT coalesce(sum(a), 0) FROM g WHERE g.h = heads.h)::DOUBLE AS t FROM heads
UNION ALL
-- Each line under its heading, marked as one of its lines (a dash: spaces in front would be stray ones to tidy).
-- With what the match noticed beside it: the same amount on the other side later on, an amount typed wrong.
SELECT h, 1, '– ' || coalesce(t, '(no description)') || coalesce(' (' || note || ')', ''), d, a, NULL FROM g
UNION ALL
${end}
UNION ALL
SELECT 7, 0, 'Not counted: ' || count(*) || CASE WHEN count(*) = 1 THEN ' line' ELSE ' lines' END || ' with no date (a balance or total line?)', NULL, NULL, NULL
FROM k WHERE d IS NULL HAVING count(*) > 0
)
ORDER BY h, o, "Date", "Particulars"`
}
