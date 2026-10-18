import { expect, test } from '@playwright/test'
import { balanceLineSql, monthlySql, signedAmount, statementColumns } from '../../src/engine/statement'
import { readTieOut } from '../../src/engine/clean-scan'
import { balanceCheckSql, balanceText, continuityText, endsSql, readBalanceCheck, readEnds, readOrder, readTieOutRow, tieOutSql, tieOutText } from '../../src/engine/checks'
import { q } from './duck'

const col = (name: string, type = 'VARCHAR') => ({ name, type })

test('a statement is known by its money-in and money-out columns', () => {
  expect(statementColumns([col('Date'), col('Narration'), col('Withdrawal Amt.'), col('Deposit Amt.'), col('Closing Balance')])).toEqual({
    credit: 'Deposit Amt.',
    debit: 'Withdrawal Amt.',
    balance: 'Closing Balance',
  })
  expect(statementColumns([col('Debit', 'DOUBLE'), col('Credit', 'DOUBLE')])).toEqual({ credit: 'Credit', debit: 'Debit' })
  // A card number or a column that only names a type isn't money.
  expect(statementColumns([col('Credit Card No'), col('Debit')])).toBeNull()
  expect(statementColumns([col('Amount', 'DOUBLE'), col('Dr/Cr')])).toBeNull()
})

test('the signed amount is money in less money out, and the balances are checked either way round', async () => {
  const s = { credit: 'deposit', debit: 'withdrawal', balance: 'balance' }
  const isNum = () => false
  // Oldest first, amounts as text (the way banks export them), one opening line without amounts.
  await q(`CREATE OR REPLACE TABLE st AS SELECT * FROM (VALUES
    (NULL, NULL, '10,000.00'), ('500.00', NULL, '9,500.00'), (NULL, '2,000.00', '11,500.00'), ('1,500.00', NULL, '10,000.00')
  ) t(withdrawal, deposit, balance)`)
  expect((await q(`SELECT ${signedAmount(s, isNum)} AS a FROM st`)).map((r) => r.a)).toEqual([0, -500, 2000, -1500])
  expect(readBalanceCheck((await q(balanceCheckSql('st', s, isNum)))[0] as Record<string, number>)).toEqual({ pairs: 3, bad: 0, order: 'oldest first' })
  // Newest first, the same statement with its 500.00 withdrawal line missing: row 2 doesn't follow.
  await q(`CREATE OR REPLACE TABLE st2 AS SELECT * FROM (VALUES
    ('1,500.00', NULL, '10,000.00'), (NULL, '2,000.00', '11,500.00'), (NULL, NULL, '10,000.00')
  ) t(withdrawal, deposit, balance)`)
  expect(readBalanceCheck((await q(balanceCheckSql('st2', s, isNum)))[0] as Record<string, number>)).toEqual({
    pairs: 2,
    bad: 1,
    order: 'newest first',
    firstBad: { row: 2, off: -500 },
  })
})

test('the tie-out is exact to a hundredth, and names the column that is short', () => {
  const t = readTieOut([
    { column: 'Withdrawal', t: 218890.84, d: 218296.92 },
    { column: 'Deposit', t: 599657.86, d: 599657.86 },
    { column: 'Balance', t: 433107.52, d: 9e6 }, // a closing balance isn't a total of balances: left alone
    { column: 'Ref', t: null, d: 12345 },
  ])
  expect(t).toEqual({ ok: [{ column: 'Deposit', sum: 599657.86 }], off: [{ column: 'Withdrawal', says: 218890.84, rows: 218296.92 }] })
  expect(tieOutText(t, (n) => n.toFixed(2))).toEqual({ kind: 'totals', ok: false, text: 'The totals say Withdrawal is 218890.84; the rows come to 218296.92: 593.92 short' })
  // Sub-totals and a grand total come to twice the rows; a total written as a whole number may be off by a half.
  expect(readTieOut([{ column: 'Amount', t: 2000, d: 1000 }])?.ok).toHaveLength(1)
  expect(readTieOut([{ column: 'Amount', t: 1000, d: 999.6 }])?.ok).toHaveLength(1)
  expect(readTieOut([{ column: 'Amount', t: 1000.4, d: 999.6 }])?.off).toHaveLength(1)
  expect(readTieOut([{ column: 'Amount', t: null, d: 5 }])).toBeNull()
})

test('the balance check in words: which row, which way, by how much', () => {
  const nf = (n: number) => String(n)
  expect(balanceText({ pairs: 3, bad: 0, order: 'oldest first' }, 'Balance', nf)?.text).toBe('Every Balance follows from the row above (3 rows checked)')
  expect(balanceText({ pairs: 9, bad: 2, order: 'newest first', firstBad: { row: 4, off: -500 } }, 'Balance', nf)).toEqual({
    kind: 'balance',
    ok: false,
    text: 'Balance on row 4 doesn’t follow from the row below: off by 500. A line missing or doubled? 2 rows don’t follow.',
  })
  expect(balanceText(null, 'Balance', nf)).toBeNull()
})

test('a statement’s opening and closing balance lines are known: no money in or out, and a label saying so', async () => {
  await q(`CREATE OR REPLACE TABLE bl AS SELECT * FROM (VALUES
    (NULL, 'Opening Balance', NULL, NULL, '10,000.00'), ('02/04/24', 'UPI to Ravi', '500.00', NULL, '9,500.00'),
    (NULL, 'BALANCE B/F', '0.00', '', '9,500.00'), ('03/04/24', 'Opening balance top-up', NULL, '100.00', '9,600.00'),
    (NULL, 'Closing Balance', NULL, NULL, '9,600.00'), (NULL, 'Carried forward', NULL, NULL, '9,600.00')
  ) t(d, narration, withdrawal, deposit, balance)`)
  const s = { credit: 'deposit', debit: 'withdrawal', balance: 'balance' }
  const sql = balanceLineSql(s, ['d', 'narration', 'withdrawal', 'deposit', 'balance'], () => false)!
  expect((await q(`SELECT narration FROM bl WHERE ${sql}`)).map((r) => r.narration)).toEqual(['Opening Balance', 'BALANCE B/F', 'Closing Balance', 'Carried forward'])
  expect(balanceLineSql(s, ['withdrawal', 'deposit', 'balance'], () => false)).toBeNull()
})

test('next month’s tie-out adds up the total lines only: not the balance lines or empty rows a view also leaves out', async () => {
  await q(`CREATE OR REPLACE TABLE nm AS SELECT * FROM (VALUES
    (NULL, 'Opening Balance', NULL, NULL), ('03/05/24', 'Salary', NULL, '50,000.00'), ('06/05/24', 'UPI', '700.00', NULL),
    (NULL, NULL, NULL, NULL), (NULL, 'Total', '700.00', '50,000.00'), (NULL, 'Closing Balance', NULL, NULL)
  ) t("Date", "Narration", "Withdrawal", "Deposit")`)
  const s = { credit: 'Deposit', debit: 'Withdrawal' }
  const bal = balanceLineSql(s, ['Date', 'Narration'], () => false)!
  const drop = [
    { label: '1 total line', keep: `"Narration" IS DISTINCT FROM 'Total'`, kind: 'totals' as const },
    { label: '2 balance lines', keep: `NOT ${bal}`, kind: 'balance' as const },
    { label: '1 empty row', keep: `"Narration" IS NOT NULL`, kind: 'empty' as const },
  ]
  const cols = ['Withdrawal', 'Deposit'].map((name) => ({ name, numeric: false }))
  const row = (await q(tieOutSql('nm', cols, drop)!))[0] as Record<string, unknown>
  expect(readTieOutRow(cols, row)).toEqual({ ok: [{ column: 'Deposit', sum: 50000 }, { column: 'Withdrawal', sum: 700 }], off: [] })
  // Steps without total lines have nothing to tie out; a view saved before steps had kinds goes by the label.
  expect(tieOutSql('nm', cols, drop.slice(1))).toBeNull()
  expect(tieOutSql('nm', cols, drop.map(({ label, keep }) => ({ label, keep })))).not.toBeNull()
})

test('a statement’s ends: where it opened and closed, either way round, and whether next month carries on from there', async () => {
  const s = { credit: 'deposit', debit: 'withdrawal', balance: 'balance' }
  await q(`CREATE OR REPLACE TABLE ends AS SELECT * FROM (VALUES
    ('500.00', NULL, '9,500.00'), (NULL, '2,000.00', '11,500.00'), ('1,500.00', NULL, '10,000.00')
  ) t(withdrawal, deposit, balance)`)
  const row = (await q(endsSql('ends', s, () => false)))[0] as Record<string, unknown>
  expect(readEnds(row, 'oldest first')).toEqual({ opening: 10000, closing: 10000 })
  // Newest first: the last row is the oldest.
  expect(readEnds(row, 'newest first')).toEqual({ opening: 10000 + 1500, closing: 9500 })
  expect(readEnds({ b0: null })).toBeNull()
  const nf = (n: number) => n.toFixed(2)
  expect(continuityText(10000, { table: 'apr', closing: 10000 }, nf)).toEqual({ kind: 'continuity', ok: true, text: 'Opens at 10000.00, where apr closed' })
  expect(continuityText(10000, { table: 'apr', closing: 9200 }, nf).text).toBe('Opens at 10000.00, but apr closed at 9200.00: 800.00 apart. A statement missing in between?')
})

test('the way round a statement runs, from one pair of balances up', async () => {
  const s = { credit: 'deposit', debit: 'withdrawal', balance: 'balance' }
  // Newest first, two lines: 1,000 + 500 = 1,500, then 1,500 − 200 = 1,300 on top.
  await q(`CREATE OR REPLACE TABLE two AS SELECT * FROM (VALUES ('200.00', NULL, '1,300.00'), (NULL, '500.00', '1,500.00')) t(withdrawal, deposit, balance)`)
  const check = (await q(balanceCheckSql('two', s, () => false)))[0] as Record<string, number | null>
  expect(readBalanceCheck(check)).toBeNull() // too few to say anything about
  expect(readOrder(check)).toBe('newest first')
  expect(readEnds((await q(endsSql('two', s, () => false)))[0] as Record<string, unknown>, readOrder(check)!)).toEqual({ opening: 1000, closing: 1300 })
  // Shuffled rows: neither way round fits, so there are no ends to speak of.
  expect(readOrder({ pairs: 4, bad_down: 3, bad_up: 3 })).toBeNull()
})

test('a statement month by month: money in, money out, the net and the lines', async () => {
  await q(`CREATE OR REPLACE TABLE mon AS SELECT * FROM (VALUES
    (DATE '2024-04-02', '500.00', NULL), (DATE '2024-04-20', NULL, '2,000.00'), (DATE '2024-05-01', '1,500.00', NULL), (NULL, NULL, NULL)
  ) t("Date", withdrawal, deposit)`)
  const sql = monthlySql('SELECT * FROM mon', { credit: 'deposit', debit: 'withdrawal' }, 'Date', () => false)
  expect((await q(sql)).map((r) => [r.money_in, r.money_out, r.net, Number(r.lines)])).toEqual([
    [2000, 500, 1500, 2],
    [0, 1500, -1500, 1],
  ])
})
