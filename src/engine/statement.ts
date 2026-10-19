/*
 * Bank statements and ledgers: money in and money out in two columns (Deposit / Withdrawal, Credit /
 * Debit), and a running balance. Sheetah offers the signed amount (in − out) that sums, charts and
 * pivots, and checks that each balance follows from the one before: a missing or doubled line shows.
 */
import { isIdLike, isNumericType, isTemporal, nameKey, sqlName } from './sql'

export interface StatementColumns {
  /** Money in, money out, and the running balance (if there is one). */
  credit: string
  debit: string
  balance?: string
  /** A column right after the balance saying which side it's on (Kotak's second "Dr / Cr"): overdrawn when Dr. */
  balanceSide?: string
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
  const next = balance ? columns[columns.indexOf(balance) + 1] : undefined
  // (Named for Dr and Cr only: a Type or a Txn Type after it is each line's own, not the balance's.)
  const side = next && /^VARCHAR/i.test(next.type) && DR_CR.test(nameKey(next.name)) ? { balanceSide: next.name } : {}
  // A ledger from the books (Tally's has Vch Type and Vch No.): its Debit and Credit are the bank's other way round.
  const books = /^(debits?|dr)$/.test(nameKey(debit.name)) && /^(credits?|cr)$/.test(nameKey(credit.name)) && columns.some((c) => /(^|_)(vch|voucher)(_|$)/.test(nameKey(c.name)))
  if (books) return { credit: debit.name, debit: credit.name, books: true, ...(balance ? { balance: balance.name, ...side } : {}) }
  return { credit: credit.name, debit: debit.name, ...(balance ? { balance: balance.name, ...side } : {}) }
}

/** A column named for Dr and Cr ("Dr / Cr", Kotak's second one read as "Dr / Cr_1", "D/C", "Debit/Credit"). */
const DR_CR = /^(dr_?cr|cr_?dr|d_?c|c_?d|debit_?credit|credit_?debit)(_\d+)?$/

/** A column saying which side each amount is on: "Dr / Cr", "Debit/Credit", "Txn Type", "D/C". */
const SIDE = /^(dr_?cr|cr_?dr|d_?c|c_?d|debit_?credit|credit_?debit|dr_?cr_?indicator|txn_?type|transaction_?type|type|indicator)$/

/**
 * A statement written with one Amount column and a column saying Dr or Cr for each line (Kotak's, many card
 * statements): its amount and side, by their names. Whether the side column really holds Dr and Cr is
 * checked on its values (sideValuesSql) before anything is offered.
 */
export function sidedAmount(columns: { name: string; type: string }[]): { amount: string; side: string } | null {
  if (statementColumns(columns)) return null
  const amount = columns.find(
    (c) =>
      !isIdLike(c.name) &&
      !BALANCE.test(nameKey(c.name)) &&
      !/date|day/i.test(c.name) &&
      (isNumericType(c.type) || /^VARCHAR/i.test(c.type)) &&
      /(^|_)(amount|amt|transaction_amount|txn_amount|txn_amt|value)(_|$)/.test(nameKey(c.name)),
  )
  const side = columns.find((c) => /^VARCHAR/i.test(c.type) && SIDE.test(nameKey(c.name)))
  return amount && side ? { amount: amount.name, side: side.name } : null
}

/** SQL whose one row says whether the side column holds Dr and Cr (true when nearly all its values do). */
export function sideValuesSql(table: string, side: string): string {
  const v = `upper(trim(${sqlName(side)}::VARCHAR))`
  return `SELECT (count(*) FILTER (WHERE regexp_full_match(${v}, '(DR|CR|D|C|DEBIT|CREDIT)\\.?')) >= 0.9 * count(nullif(${v}, '')) AND count(nullif(${v}, '')) > 0) AS ok FROM ${table}`
}

/** Money in (Cr) and money out (Dr) as two formula columns, from the amount and its side. */
export function splitBySide(s: { amount: string; side: string }, numeric: boolean): { name: string; expr: string; note: string }[] {
  const amt = num(s.amount, numeric)
  const side = `upper(trim(${sqlName(s.side)}::VARCHAR))`
  return [
    { name: 'money_in', expr: `CASE WHEN regexp_full_match(${side}, '(CR|C|CREDIT)\\.?') THEN abs(${amt}) END`, note: `${s.amount} where ${s.side} is Cr` },
    { name: 'money_out', expr: `CASE WHEN regexp_full_match(${side}, '(DR|D|DEBIT)\\.?') THEN abs(${amt}) END`, note: `${s.amount} where ${s.side} is Dr` },
  ]
}

/**
 * The books' ledger column (a day book: each voucher's lines, each to its ledger): text named for the
 * account a line goes to. A single ledger's own export names the other account "Particulars": not this.
 */
export function ledgerColumn(columns: { name: string; type: string }[]): string | null {
  return columns.find((c) => /^VARCHAR/i.test(c.type) && /^(ledger|account)(_(name|head))?$|^ledger_account$/.test(nameKey(c.name)))?.name ?? null
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

/** "Opening Balance", "Closing Balance", "Balance b/f", "Brought forward" (a US bank's "Beginning Balance", "Ending Balance"): a statement's lines about its balance. */
const BALANCE_LINE = `'^\\s*((opening|closing|beginning|starting|ending)\\s+bal|bal(ance)?\\s+(b/?f|c/?f|brought|carried)|(brought|carried)\\s+(forward|fwd|over)\\b)'`

/** A cell that says only that its line is a balance ("Opening Balance", "Balance b/f:"), however its amounts are written. */
const BALANCE_ONLY = `'^\\s*((opening|closing|beginning|starting|ending)\\s+balance|bal(ance)?\\s+(b/?f|c/?f|brought\\s+forward|carried\\s+forward)|(brought|carried)\\s+(forward|fwd|over))\\s*:?\\s*$'`

/**
 * A statement's balance lines, as SQL true for them: a label (in one of the text columns) saying it's the
 * opening or closing balance, with nothing in or out; or a cell that says only that, whatever its amounts
 * (the books write the opening balance in their Debit or Credit column). They aren't transactions: an
 * empty month in a pivot, a line the books "don't have" in a match.
 */
export function balanceLineSql(s: StatementColumns, text: string[], numeric: (name: string) => boolean, ref: (name: string) => string = sqlName): string | null {
  const labels = text.filter((c) => c !== s.credit && c !== s.debit && c !== s.balance)
  if (!labels.length) return null
  const none = (c: string) => `coalesce(${num(c, numeric(c), ref)}, 0) = 0`
  const says = (re: string) => labels.map((c) => `regexp_matches(coalesce(${ref(c)}::VARCHAR, ''), ${re}, 'i')`).join(' OR ')
  return `((${none(s.credit)} AND ${none(s.debit)} AND (${says(BALANCE_LINE)})) OR ${says(BALANCE_ONLY)})`
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
  // The books' ledger says it in its own words: a debtor's Debit is what was billed, not money in.
  const [inName, outName, netName] = s.books ? ['debit', 'credit', 'net_dr'] : ['money_in', 'money_out', 'net']
  return `SELECT date_trunc('month', ${sqlName(date)})::DATE AS month,
  sum(${v(s.credit)}) AS ${inName},
  sum(${v(s.debit)}) AS ${outName},
  sum(${v(s.credit)}) - sum(${v(s.debit)}) AS ${netName},
  count(*) AS lines
FROM (
${rows}
)
WHERE ${sqlName(date)} IS NOT NULL
GROUP BY 1
ORDER BY 1`
}

/* Open bills (what's still owed, by party): their ageing is in ageing.ts, loaded when asked for. */

export interface AgeingColumns {
  party: string
  amount: string
  /** The date the age is counted from: when it fell due, else the bill's date. */
  date: string
  by: 'due' | 'bill'
  /** The bill's own date (raised after the day asked about, a bill isn't open on it yet). */
  bill?: string
}

const OPEN = /(^|_)(pending|outstanding|unpaid|overdue|due|balance|receivable|payable|open)(_|$)/
const PARTY = /(^|_)(party|customer|debtor|client|vendor|supplier|creditor|ledger|account|name|buyer)(_|$)/

/**
 * A list of open bills, by its columns: an amount still open ("Pending Amount", "Balance Due"), a party,
 * and a date (a due date by preference). Not a bank statement (its balance is a running one). A plain
 * Amount counts when the bills have a due date and nothing says some are paid (a Status, a Paid column):
 * an open items list.
 */
export function ageingColumns(columns: { name: string; type: string }[]): AgeingColumns | null {
  // (A bank statement, either way it's written, is no list of bills: its Balance isn't what's open. One with an
  // Amount and a Dr / Cr column by that name: a bills list's Type of Invoice or Credit Note doesn't count.)
  if (statementColumns(columns)) return null
  const money = (c: { name: string; type: string }) => !isTemporal(c) && (isNumericType(c.type) || /^VARCHAR/i.test(c.type)) && !/(^|_)(days?|date|on|by)$/.test(nameKey(c.name))
  const party = columns.find((c) => /^VARCHAR/i.test(c.type) && PARTY.test(nameKey(c.name)))
  const dates = columns.filter(isTemporal)
  const due = dates.find((c) => /(^|_)due(_|$)/.test(nameKey(c.name)))
  // (Payment Terms says when, not whether: it doesn't count.)
  const settled = columns.some((c) => /(^|_)(status|paid|received|cleared|settled)(_|$)|(^|_)payment_(status|date|on|received|ref)(_|$)/.test(nameKey(c.name)))
  const amount =
    columns.find((c) => money(c) && OPEN.test(nameKey(c.name))) ??
    (due && !settled ? columns.find((c) => money(c) && /^(amount|amt|invoice_amount|bill_amount|total|value)$/.test(nameKey(c.name))) : undefined)
  // The bill's own date: not the day it was paid or received.
  const bill = dates.find((c) => c !== due && !/(^|_)(paid|payment|receipt|received|cleared|realised|realized)(_|$)/.test(nameKey(c.name)))
  const date = due ?? dates[0]
  // A bank statement with one Amount and a Dr / Cr column (Kotak's) has no bills: its running Balance isn't
  // what's open. (A bills list with a Dr / Cr column and its due dates is one.)
  const sided = sidedAmount(columns)
  if (sided && DR_CR.test(nameKey(sided.side)) && !due && amount && BALANCE.test(nameKey(amount.name))) return null
  if (!amount || !party || !date) return null
  return { party: party.name, amount: amount.name, date: date.name, by: due ? 'due' : 'bill', ...(bill ? { bill: bill.name } : {}) }
}
