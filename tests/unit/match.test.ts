import { expect, test } from '@playwright/test'
import { directionSql, matchCountsSql, matchSql, sideFor, type MatchSide, type MatchSpec } from '../../src/engine/match'
import { q } from './duck'

const col = (name: string, type = 'VARCHAR') => ({ name, type })

test('a table’s side of a match is guessed from its columns', () => {
  expect(sideFor({ name: 'bank', columns: [col('Date', 'DATE'), col('Narration'), col('Withdrawal Amt.'), col('Deposit Amt.'), col('Closing Balance')] })).toEqual({
    table: 'bank',
    date: 'Date',
    amount: { credit: 'Deposit Amt.', debit: 'Withdrawal Amt.' },
    text: 'Narration',
  })
  expect(sideFor({ name: 'books', columns: [col('Voucher No'), col('Posted', 'TIMESTAMP'), col('Party'), col('Amount', 'DOUBLE')] })).toEqual({ table: 'books', date: 'Posted', amount: { column: 'Amount' }, text: 'Party' })
  // "Value Date" isn't an amount, however it's stored.
  expect(sideFor({ name: 'k', columns: [col('Txn Date', 'DATE'), col('Value Date'), col('Description'), col('Amount')] })?.amount).toEqual({ column: 'Amount' })
  expect(sideFor({ name: 'x', columns: [col('Amount', 'DOUBLE')] })).toBeNull() // no date to match on
})

const numeric = (types: Record<string, string[]>) => (s: MatchSide, c: string) => (types[s.table] ?? []).includes(c)
const statuses = async (spec: MatchSpec, types: Record<string, string[]>) => Object.fromEntries((await q(matchCountsSql(matchSql(spec, numeric(types))))).map((r) => [r.status, r.n]))
const simple = (a: string, b: string, days = 3): MatchSpec => ({
  a: { table: a, date: 'd', amount: { column: 'amt' } },
  b: { table: b, date: 'd', amount: { column: 'amt' } },
  days,
  flip: false,
})

test('lines match one to one by amount and nearest date; a missing line doesn’t pull its neighbours apart', async () => {
  await q(`CREATE OR REPLACE TABLE bank AS SELECT * FROM (VALUES
    (DATE '2024-04-01', 'UPI Ravi', '500.00', NULL), (DATE '2024-04-20', 'UPI Ravi', '500.00', NULL),
    (DATE '2024-04-05', 'NEFT Acme', NULL, '50,000.00 Cr'), (DATE '2024-04-09', 'Bank charges', '118.00', NULL),
    (DATE '2024-04-10', 'Cash', 'five hundred', NULL), (NULL, 'Opening balance', NULL, NULL)
  ) t("Date", "Narration", "Withdrawal", "Deposit")`)
  // The books: Ravi's second payment written a day early, the first not entered; a receipt the bank hasn't seen.
  await q(`CREATE OR REPLACE TABLE books AS SELECT * FROM (VALUES
    (DATE '2024-04-19', 'Ravi', -500.0), (DATE '2024-04-04', 'Acme Ltd', 50000.0), (DATE '2024-04-28', 'Kiran', 2500.0)
  ) t("Posted", "Party", "Amount")`)
  const types = { books: ['Amount'] }
  const spec: MatchSpec = {
    a: { table: 'bank', date: 'Date', amount: { credit: 'Deposit', debit: 'Withdrawal' }, text: 'Narration' },
    b: { table: 'books', date: 'Posted', amount: { column: 'Amount' }, text: 'Party' },
    days: 3,
    flip: false,
  }
  expect((await q(directionSql(spec, numeric(types))))[0]).toEqual({ same: 2, flipped: 0 })
  const rows = await q(matchSql(spec, numeric(types)))
  // Every line once; the unreadable "five hundred" is listed with no amount (not lost), the opening line left out.
  expect(rows.map((r) => [r.status, r.amount, r['days apart'] === null ? null : Number(r['days apart'])])).toEqual([
    ['only in bank', -500, null],
    ['matched', 50000, 1],
    ['only in bank', -118, null],
    ['only in bank', null, null],
    ['matched', -500, 1],
    ['only in books', 2500, null],
  ])
  expect(Object.keys(rows[0])).toEqual(['status', 'bank date', 'books date', 'amount', 'bank: Narration', 'books: Party', 'days apart', 'note'])
  // A line left over with the same amount on the other side within a month is said: Ravi's first payment.
  expect(rows[0].note).toBe(null)
  // Books that write money the other way round match once turned round.
  await q(`CREATE OR REPLACE TABLE cash AS SELECT "Posted", "Party", -"Amount" AS "Amount" FROM books`)
  const flipped = { ...spec, b: { ...spec.b, table: 'cash' } }
  expect((await q(directionSql(flipped, numeric({ cash: ['Amount'] }))))[0]).toEqual({ same: 0, flipped: 2 })
  expect((await statuses({ ...flipped, flip: true }, { cash: ['Amount'] })).matched).toBe(2)
})

test('repeats pair up: the same amount many times on a day, and lines a day apart either way', async () => {
  // Five payments of 500 on one day, on both sides.
  await q(`CREATE OR REPLACE TABLE fa AS SELECT DATE '2024-04-01' AS d, -500.0 AS amt FROM range(5)`)
  await q(`CREATE OR REPLACE TABLE fb AS SELECT * FROM fa`)
  expect(await statuses(simple('fa', 'fb'), { fa: ['amt'], fb: ['amt'] })).toEqual({ matched: 5 })
  // Bank on the 1st, 3rd and 5th; books a day earlier each time, written newest first.
  await q(`CREATE OR REPLACE TABLE ga AS SELECT * FROM (VALUES (DATE '2024-04-05', 100.0), (DATE '2024-04-03', 100.0), (DATE '2024-04-01', 100.0)) t(d, amt)`)
  await q(`CREATE OR REPLACE TABLE gb AS SELECT * FROM (VALUES (DATE '2024-04-04', 100.0), (DATE '2024-04-02', 100.0), (DATE '2024-03-31', 100.0)) t(d, amt)`)
  expect(await statuses(simple('ga', 'gb', 1), { ga: ['amt'], gb: ['amt'] })).toEqual({ matched: 3 })
  // A receipts register next to a bank with many payments of the same amount: direction goes by lines, not pairs.
  await q(`CREATE OR REPLACE TABLE ha AS SELECT DATE '2024-04-01' + (i % 20)::INTEGER AS d, CASE WHEN i < 100 THEN -500.0 ELSE 700.0 + i END AS amt FROM range(200) t(i)`)
  await q(`CREATE OR REPLACE TABLE hb AS SELECT d, amt FROM ha WHERE amt > 0 UNION ALL SELECT DATE '2024-04-02', 500.0 FROM range(5)`)
  expect((await q(directionSql(simple('ha', 'hb'), numeric({ ha: ['amt'], hb: ['amt'] }))))[0]).toEqual({ same: 100, flipped: 25 })
})

test('a side can be a query: the table as tidied, or a view (no rowid)', async () => {
  await q(`CREATE OR REPLACE VIEW va AS SELECT DATE '2024-04-01' AS d, 10.0 AS amt UNION ALL SELECT DATE '2024-04-02', 20.0`)
  await q(`CREATE OR REPLACE TABLE tb AS SELECT * FROM (VALUES (DATE '2024-04-01', 10.0), (DATE '2099-01-01', 999.0)) t(d, amt)`)
  const spec = simple('va', 'tb')
  expect(await statuses(spec, { va: ['amt'], tb: ['amt'] })).toEqual({ matched: 1, 'only in va': 1, 'only in tb': 1 })
  // The books as tidied: a total line left out by a step.
  const tidied = { ...spec, b: { ...spec.b, source: 'SELECT * FROM tb WHERE amt < 999' } }
  expect(await statuses(tidied, { va: ['amt'], tb: ['amt'] })).toEqual({ matched: 1, 'only in va': 1 })
})

test('a line left over says where the same amount is on the other side, up to a month away; a dateless line is listed, unmatched', async () => {
  await q(`CREATE OR REPLACE TABLE ca AS SELECT * FROM (VALUES (DATE '2024-04-09', -85000.0), (NULL, -85000.0), (DATE '2024-04-20', 10.0)) t(d, amt)`)
  await q(`CREATE OR REPLACE TABLE cb AS SELECT * FROM (VALUES (DATE '2024-04-02', -85000.0), (DATE '2024-04-30', 99.0)) t(d, amt)`)
  const rows = await q(matchSql(simple('ca', 'cb'), numeric({ ca: ['amt'], cb: ['amt'] })))
  expect(rows.map((r) => [r.status, r.note])).toEqual([
    ['only in cb', 'same amount in ca on 2024-04-09 (7 days later)'],
    ['only in ca', 'same amount in cb on 2024-04-02 (7 days earlier)'],
    ['only in ca', null],
    ['only in cb', null],
    ['only in ca', 'no date, so not matched'],
  ])
})

test('a cheque presented late pairs by its number, not with a nearer cheque of the same amount', async () => {
  // Two rent cheques of 25,000 written on the 5th and the 14th; the bank has the first, presented on the 15th.
  await q(`CREATE OR REPLACE TABLE chqbank AS SELECT * FROM (VALUES (DATE '2024-04-15', 'CHQ PAID', '000000123', -25000.0)) t(d, narration, "Chq./Ref.No.", amt)`)
  await q(`CREATE OR REPLACE TABLE chqbooks AS SELECT * FROM (VALUES (DATE '2024-04-05', 'Rent April', 123, -25000.0), (DATE '2024-04-14', 'Rent store', 124, -25000.0)) t(d, party, "Cheque No", amt)`)
  const cols = (names: [string, string][]) => names.map(([name, type]) => ({ name, type }))
  const a = sideFor({ name: 'chqbank', columns: cols([['d', 'DATE'], ['narration', 'VARCHAR'], ['Chq./Ref.No.', 'VARCHAR'], ['amt', 'DOUBLE']]) })!
  const b = sideFor({ name: 'chqbooks', columns: cols([['d', 'DATE'], ['party', 'VARCHAR'], ['Cheque No', 'BIGINT'], ['amt', 'DOUBLE']]) })!
  expect([a.ref, b.ref, a.text, b.text]).toEqual(['Chq./Ref.No.', 'Cheque No', 'narration', 'party'])
  const spec: MatchSpec = { a, b, days: 3, flip: false }
  const rows = await q(matchSql(spec, numeric({ chqbank: ['amt'], chqbooks: ['amt'] })))
  expect(rows.map((r) => [r.status, r['chqbooks: party'], r.note])).toEqual([
    ['only in chqbooks', 'Rent store', null],
    ['matched', 'Rent April', 'paired by reference 123'],
  ])
  // Without the numbers, the nearer cheque would have been taken.
  const plain = await q(matchSql({ a: { ...a, ref: undefined }, b: { ...b, ref: undefined }, days: 3, flip: false }, numeric({ chqbank: ['amt'], chqbooks: ['amt'] })))
  expect(plain.find((r) => r.status === 'matched')?.['chqbooks: party']).toBe('Rent store')
})
