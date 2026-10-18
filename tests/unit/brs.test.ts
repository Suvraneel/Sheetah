import { expect, test } from '@playwright/test'
import { bankOf, brsSql } from '../../src/engine/brs'
import { matchSql, type MatchSide, type MatchSpec } from '../../src/engine/match'
import { q } from './duck'

const numeric = (types: Record<string, string[]>) => (s: MatchSide, c: string) => (types[s.table] ?? []).includes(c)
const col = (name: string, type = 'VARCHAR') => ({ name, type })

test.beforeAll(async () => {
  // April: Ravi paid twice (the first not in the books), Acme's receipt, the bank's charges and interest.
  await q(`CREATE OR REPLACE TABLE rbank AS SELECT * FROM (VALUES
    (DATE '2024-04-01', 'UPI Ravi', '500.00', NULL, '9,500.00'), (DATE '2024-04-05', 'NEFT Acme', NULL, '50,000.00', '59,500.00'),
    (DATE '2024-04-09', 'Bank charges', '118.00', NULL, '59,382.00'), (DATE '2024-04-20', 'UPI Ravi', '500.00', NULL, '58,882.00'),
    (DATE '2024-04-30', 'Interest', NULL, '42.00', '58,924.00')
  ) t("Date", "Narration", "Withdrawal", "Deposit", "Closing Balance")`)
  // The books: a receipt and a cheque the bank hasn't seen yet. They close at 59,000.00 (from 10,000.00).
  await q(`CREATE OR REPLACE TABLE rbooks AS SELECT * FROM (VALUES
    (DATE '2024-04-19', 'Ravi', -500.0), (DATE '2024-04-04', 'Acme Ltd', 50000.0), (DATE '2024-04-28', 'Kiran', 2500.0), (DATE '2024-04-29', 'Cheque to Mohan', -3000.0)
  ) t("Posted", "Party", "Amount")`)
  await q(`CREATE OR REPLACE TABLE rcash AS SELECT "Posted", "Party", -"Amount" AS "Amount" FROM rbooks`)
})

const bankSide: MatchSide = { table: 'rbank', date: 'Date', amount: { credit: 'Deposit', debit: 'Withdrawal' }, text: 'Narration' }
const booksSide = (table: string): MatchSide => ({ table, date: 'Posted', amount: { column: 'Amount' }, text: 'Party' })
const types = numeric({ rbooks: ['Amount'], rcash: ['Amount'] })

test('the bank is the statement with a running balance, whichever side it is on', () => {
  const bank = [col('Date', 'DATE'), col('Narration'), col('Withdrawal'), col('Deposit'), col('Closing Balance')]
  const books = [col('Posted', 'DATE'), col('Party'), col('Amount', 'DOUBLE')]
  expect(bankOf({ a: bank, b: books })).toEqual({ bank: 'a', statement: { credit: 'Deposit', debit: 'Withdrawal', balance: 'Closing Balance' } })
  expect(bankOf({ a: books, b: bank }).bank).toBe('b')
  // Books kept as Debit and Credit with a voucher number aren't the bank.
  const ledger = [col('Date', 'DATE'), col('Vch No'), col('Debit'), col('Credit'), col('Balance')]
  expect(bankOf({ a: ledger, b: bank }).bank).toBe('b')
})

const iso = (d: unknown) => (d === null || d === undefined ? null : new Date(d instanceof Date ? d.getTime() : Number(d)).toISOString().slice(0, 10))
// DECIMAL(18, 2) comes back from Arrow unscaled (5892400 is 58,924.00): the grid and the export scale it.
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v) / 100)
const laid = (rows: Record<string, unknown>[]) => rows.map((r) => [r.Particulars, iso(r.Date), num(r.Amount), num(r.Total)])

test('from the bank’s closing balance to the books’: each heading, the lines under it, and what the books should show', async () => {
  const spec: MatchSpec = { a: bankSide, b: booksSide('rbooks'), days: 3, flip: false }
  const rows = await q(brsSql({ match: matchSql(spec, types), spec, bank: 'a', closing: 58924, asOf: '2024-04-30' }))
  expect(Object.keys(rows[0])).toEqual(['Particulars', 'Date', 'Amount', 'Total'])
  expect(laid(rows)).toEqual([
    ['Balance as per bank statement on Apr 30, 2024', null, null, 58924],
    ['Add: deposits not yet credited by the bank', null, null, 2500],
    ['– Kiran', '2024-04-28', 2500, null],
    ['Less: cheques issued, not yet presented', null, null, 3000],
    ['– Cheque to Mohan', '2024-04-29', 3000, null],
    ['Less: credits by the bank, not in the books', null, null, 42],
    ['– Interest', '2024-04-30', 42, null],
    ['Add: debits by the bank, not in the books', null, null, 618],
    ['– UPI Ravi', '2024-04-01', 500, null],
    ['– Bank charges', '2024-04-09', 118, null],
    ['Balance as per books (should be)', null, null, 59000],
  ])
})

test('books first, written the other way round: the same statement; without a closing balance, the difference', async () => {
  const spec: MatchSpec = { a: booksSide('rcash'), b: bankSide, days: 3, flip: true }
  const rows = await q(brsSql({ match: matchSql(spec, types), spec, bank: 'b', closing: null }))
  expect(laid(rows).filter((r) => r[1] === null)).toEqual([
    ['Add: deposits not yet credited by the bank', null, null, 2500],
    ['Less: cheques issued, not yet presented', null, null, 3000],
    ['Less: credits by the bank, not in the books', null, null, 42],
    ['Add: debits by the bank, not in the books', null, null, 618],
    ['rcash less rbank: the headings above, net', null, null, 76],
  ])
})

test('a line with no date (an opening balance the steps didn’t leave out) isn’t counted, and the statement says so', async () => {
  await q(`CREATE OR REPLACE TABLE rledger AS SELECT * FROM rbooks UNION ALL SELECT NULL, 'Opening Balance', 10000.0`)
  const spec: MatchSpec = { a: bankSide, b: booksSide('rledger'), days: 3, flip: false }
  const rows = laid(await q(brsSql({ match: matchSql(spec, types), spec, bank: 'a', closing: 58924, asOf: '2024-04-30' })))
  expect(rows.at(-2)).toEqual(['Balance as per books (should be)', null, null, 59000])
  expect(rows.at(-1)).toEqual(['Not counted: 1 line with no date (a balance or total line?)', null, null, null])
})
