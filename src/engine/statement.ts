/*
 * Bank statements and ledgers: money in and money out in two columns (Deposit / Withdrawal, Credit /
 * Debit), and a running balance. Sheetah offers the signed amount (in − out) that sums, charts and
 * pivots, and checks that each balance follows from the one before: a missing or doubled line shows.
 */
import { isIdLike, isNumericType, nameKey, sqlName } from './sql'

export interface StatementColumns {
  /** Money in, money out, and the running balance (if there is one). */
  credit: string
  debit: string
  balance?: string
  /**
   * The books' side (a ledger exported from the accounts, with its voucher types): a debit to the bank
   * account is money in, so `credit` (in) is the Debit column here, and `debit` (out) the Credit column.
   */
  books?: boolean
}

const OUT = /(^|_)(withdrawals?|debits?|dr|paid_out|money_out|outflows?|payments?|spent|expenses?)(_|$)/
const IN = /(^|_)(deposits?|credits?|cr|paid_in|money_in|inflows?|receipts?|received)(_|$)/
const BALANCE = /(^|_)(balance|bal|closing_balance|running_balance)(_|$)/

/**
 * The statement's columns, by their names: one for money in and one for money out (numbers, or numbers
 * stored as text), and a balance if there is one. Codes and card numbers ("Credit Card No") don't count.
 */
export function statementColumns(columns: { name: string; type: string }[]): StatementColumns | null {
  const money = (c: { name: string; type: string }) => !isIdLike(c.name) && !/card|account|acct|date|type|mode|ref/i.test(c.name) && (isNumericType(c.type) || /^VARCHAR/i.test(c.type))
  const debit = columns.find((c) => money(c) && OUT.test(nameKey(c.name)) && !IN.test(nameKey(c.name)))
  const credit = columns.find((c) => money(c) && IN.test(nameKey(c.name)) && !OUT.test(nameKey(c.name)))
  if (!debit || !credit) return null
  const balance = columns.find((c) => money(c) && BALANCE.test(nameKey(c.name)) && c !== debit && c !== credit)
  // A ledger from the books (Tally's has Vch Type and Vch No.): its Debit and Credit are the bank's other way round.
  const books = /^(debits?|dr)$/.test(nameKey(debit.name)) && /^(credits?|cr)$/.test(nameKey(credit.name)) && columns.some((c) => /(^|_)(vch|voucher)(_|$)/.test(nameKey(c.name)))
  if (books) return { credit: debit.name, debit: credit.name, books: true, ...(balance ? { balance: balance.name } : {}) }
  return { credit: credit.name, debit: debit.name, ...(balance ? { balance: balance.name } : {}) }
}

/** What the signed amount is, in words: "Deposit − Withdrawal" (its columns, without "Amt."). */
export function signedNote(s: StatementColumns): string {
  const short = (n: string) => n.replace(/[\s_]*(amt\.?|amount)$/i, '') || n
  return `${short(s.credit)} − ${short(s.debit)}`
}

/** A running balance, by its name ("Closing Balance", "bal"): never a column that total lines add up. */
export const isBalanceName = (name: string) => BALANCE.test(nameKey(name))

/** A column's values as numbers, whether they're numbers already or "1,200.00" text. */
const num = (name: string, numeric: boolean, ref: (name: string) => string = sqlName) => (numeric ? `${ref(name)}::DOUBLE` : `number_from_text(${ref(name)})`)

/** "Opening Balance", "Closing Balance", "Balance b/f", "Brought forward": a statement's lines about its balance. */
const BALANCE_LINE = `'^\\s*((opening|closing)\\s+bal|bal(ance)?\\s+(b/?f|c/?f|brought|carried)|(brought|carried)\\s+(forward|fwd|over)\\b)'`

/**
 * A statement's balance lines, as SQL true for them: nothing in or out, and a label (in one of the text
 * columns) saying it's the opening or closing balance. They aren't transactions: an empty month in a pivot.
 */
export function balanceLineSql(s: StatementColumns, text: string[], numeric: (name: string) => boolean, ref: (name: string) => string = sqlName): string | null {
  const labels = text.filter((c) => c !== s.credit && c !== s.debit && c !== s.balance)
  if (!labels.length) return null
  const none = (c: string) => `coalesce(${num(c, numeric(c), ref)}, 0) = 0`
  return `(${none(s.credit)} AND ${none(s.debit)} AND (${labels.map((c) => `regexp_matches(coalesce(${ref(c)}::VARCHAR, ''), ${BALANCE_LINE}, 'i')`).join(' OR ')}))`
}

/** The signed amount, as a formula column: money in less money out (an empty cell counts as nothing). */
export function signedAmount(s: StatementColumns, numeric: (name: string) => boolean): string {
  return `coalesce(${num(s.credit, numeric(s.credit))}, 0) - coalesce(${num(s.debit, numeric(s.debit))}, 0)`
}

/**
 * Money in, money out and the net for each month, with how many lines: a statement's summary, from the
 * rows as tidied (`rows` is their query). Months by the date column; lines without a date are left out.
 */
export function monthlySql(rows: string, s: StatementColumns, date: string, numeric: (name: string) => boolean): string {
  const v = (name: string) => `coalesce(${num(name, numeric(name))}, 0)`
  return `SELECT date_trunc('month', ${sqlName(date)})::DATE AS month,
  sum(${v(s.credit)}) AS money_in,
  sum(${v(s.debit)}) AS money_out,
  sum(${v(s.credit)}) - sum(${v(s.debit)}) AS net,
  count(*) AS lines
FROM (
${rows}
)
WHERE ${sqlName(date)} IS NOT NULL
GROUP BY 1
ORDER BY 1`
}
