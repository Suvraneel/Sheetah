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
  return { credit: credit.name, debit: debit.name, ...(balance ? { balance: balance.name } : {}) }
}

/** A column's values as numbers, whether they're numbers already or "1,200.00" text. */
const num = (name: string, numeric: boolean) => (numeric ? `${sqlName(name)}::DOUBLE` : `number_from_text(${sqlName(name)})`)

/** The signed amount, as a formula column: money in less money out (an empty cell counts as nothing). */
export function signedAmount(s: StatementColumns, numeric: (name: string) => boolean): string {
  return `coalesce(${num(s.credit, numeric(s.credit))}, 0) - coalesce(${num(s.debit, numeric(s.debit))}, 0)`
}
