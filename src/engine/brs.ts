/*
 * The bank reconciliation statement, from a match of the bank statement against the books: the bank's
 * closing balance, and each kind of line found on one side only, taking it to the balance the books
 * should show. What an accountant writes up at each month's end, made from the lines the match left over
 * (loaded only when one is asked for).
 */
import type { MatchSide, MatchSpec } from './match'
import { statusLabels } from './match'
import { commentText, quoteLiteral, sqlName } from './sql'
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

/**
 * The statement as a query: Item, Lines, Amount. Each amount is what that kind of line does on the way from
 * the bank's balance to the books' (money in the books only is added; money in the bank only is taken off).
 * Without the bank's closing balance, the lines and what they come to: the books less the bank.
 */
export function brsSql({ match, spec, bank, closing, asOf }: Reconcile): string {
  const st = statusLabels(spec)
  const [bankName, booksName] = bank === 'a' ? [spec.a.table, spec.b.table] : [spec.b.table, spec.a.table]
  const [bankOnly, booksOnly] = bank === 'a' ? [st.a, st.b] : [st.b, st.a]
  // The match's amounts are in its first table's terms (the second's turned round when it records money the
  // other way): in the bank's terms, they're turned back when the bank is the second, written the other way.
  const sign = bank === 'b' && spec.flip ? '-' : ''
  const kinds: [string, string, string][] = [
    [`Add: money in, in ${booksName} only (deposits not yet credited)`, booksOnly, 'amount > 0'],
    [`Less: money out, in ${booksName} only (cheques not yet presented)`, booksOnly, 'amount < 0'],
    [`Less: money in, in ${bankName} only (interest, direct receipts)`, bankOnly, 'amount > 0'],
    [`Add: money out, in ${bankName} only (charges, direct debits)`, bankOnly, 'amount < 0'],
  ]
  // Lines in the books add as they are; lines in the bank come off.
  const line = ([item, status, which]: [string, string, string], i: number) =>
    `SELECT ${i + 2} AS o, ${quoteLiteral(item)} AS item, count(*) AS lines, ${status === bankOnly ? '-' : ''}coalesce(sum(amount), 0)::DOUBLE AS amount FROM k WHERE status = ${quoteLiteral(status)} AND ${which}`
  const money = closing === null ? null : `${closing}::DOUBLE`
  const opening = money
    ? `SELECT 1 AS o, ${quoteLiteral(`Balance as per ${bankName}${asOf ? ` on ${asOf}` : ''}`)} AS item, NULL::BIGINT AS lines, ${money} AS amount\nUNION ALL\n`
    : ''
  const end = money
    ? `SELECT 6, ${quoteLiteral(`Balance as per ${booksName}, worked out: compare with its own`)}, NULL, ${money} + (SELECT sum(amount) FROM items)`
    : `SELECT 6, ${quoteLiteral(`${booksName} less ${bankName}: the lines above, net`)}, NULL, (SELECT sum(amount) FROM items)`
  return `${commentText(`-- Bank reconciliation: ${bankName} against ${booksName}, from the payments matched`)}
WITH m AS (
${match}
),
k AS (SELECT status, ${sign}amount AS amount FROM m WHERE status <> ${quoteLiteral(st.matched)} AND amount IS NOT NULL),
items AS (
${kinds.map(line).join('\nUNION ALL\n')}
)
SELECT item AS "Item", lines AS "Lines", round(amount, 2) AS "Amount" FROM (
${opening}SELECT * FROM items
UNION ALL
${end}
)
ORDER BY o`
}
