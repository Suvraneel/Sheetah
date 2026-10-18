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

test('from the bank’s closing balance to the books’: each kind of line left over, and what the books should show', async () => {
  const spec: MatchSpec = { a: bankSide, b: booksSide('rbooks'), days: 3, flip: false }
  const rows = await q(brsSql({ match: matchSql(spec, types), spec, bank: 'a', closing: 58924, asOf: '2024-04-30' }))
  expect(rows.map((r) => [r.Item, r.Lines === null ? null : Number(r.Lines), r.Amount])).toEqual([
    ['Balance as per rbank on 2024-04-30', null, 58924],
    ['Add: money in, in rbooks only (deposits not yet credited)', 1, 2500],
    ['Less: money out, in rbooks only (cheques not yet presented)', 1, -3000],
    ['Less: money in, in rbank only (interest, direct receipts)', 1, -42],
    ['Add: money out, in rbank only (charges, direct debits)', 2, 618],
    ['Balance as per rbooks, worked out: compare with its own', null, 59000],
  ])
})

test('books first, written the other way round: the same statement; without a closing balance, the difference', async () => {
  const spec: MatchSpec = { a: booksSide('rcash'), b: bankSide, days: 3, flip: true }
  const rows = await q(brsSql({ match: matchSql(spec, types), spec, bank: 'b', closing: null }))
  expect(rows.map((r) => [r.Item, r.Amount])).toEqual([
    ['Add: money in, in rcash only (deposits not yet credited)', 2500],
    ['Less: money out, in rcash only (cheques not yet presented)', -3000],
    ['Less: money in, in rbank only (interest, direct receipts)', -42],
    ['Add: money out, in rbank only (charges, direct debits)', 618],
    ['rcash less rbank: the lines above, net', 76],
  ])
})
