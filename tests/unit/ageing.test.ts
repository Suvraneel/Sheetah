import { expect, test } from '@playwright/test'
import { ageingSql } from '../../src/engine/ageing'
import { ageingColumns } from '../../src/engine/statement'
import { q } from './duck'

const col = (name: string, type = 'VARCHAR') => ({ name, type })
// Amounts are DECIMAL(18, 2): Arrow hands them back unscaled (1180000 is 11,800.00). Names stay as they are.
const paise = (v: unknown) => (typeof v === 'string' ? v : Number(v) / 100)

test('a list of open bills is known by its pending amount, its party and its dates; a statement is not', () => {
  const bills = [col('Date', 'DATE'), col('Ref. No.'), col("Party's Name"), col('Pending Amount'), col('Due on', 'DATE'), col('Overdue by days', 'BIGINT')]
  expect(ageingColumns(bills)).toEqual({ party: "Party's Name", amount: 'Pending Amount', date: 'Due on', by: 'due', bill: 'Date' })
  expect(ageingColumns([col('Invoice Date', 'DATE'), col('Customer'), col('Balance Due', 'DOUBLE')])).toEqual({ party: 'Customer', amount: 'Balance Due', date: 'Invoice Date', by: 'bill', bill: 'Invoice Date' })
  // A Kotak statement (one Amount, Dr / Cr, a running Balance) is no list of bills; a bills list with a Type is.
  expect(ageingColumns([col('Txn Date', 'DATE'), col('Party'), col('Amount'), col('Dr / Cr'), col('Balance')])).toBeNull()
  expect(ageingColumns([col('Invoice Date', 'DATE'), col('Customer'), col('Type'), col('Amount'), col('Balance Due', 'DOUBLE')])).toMatchObject({ amount: 'Balance Due' })
  // Tally's bills with their Dr / Cr and due dates are bills.
  expect(ageingColumns([col('Date', 'DATE'), col("Party's Name"), col('Pending Amount'), col('Dr/Cr'), col('Due on', 'DATE')])).toMatchObject({ amount: 'Pending Amount', by: 'due' })
  expect(ageingColumns([col('Date', 'DATE'), col('Narration'), col('Withdrawal Amt.'), col('Deposit Amt.'), col('Closing Balance')])).toBe(null)
  expect(ageingColumns([col('Date', 'DATE'), col('Customer'), col('Amount', 'DOUBLE')])).toBe(null)
  // An open items list: a due date, a plain Amount, nothing saying some are paid.
  expect(ageingColumns([col('Party'), col('Bill Date', 'DATE'), col('Due Date', 'DATE'), col('Amount', 'DOUBLE')])).toEqual({ party: 'Party', amount: 'Amount', date: 'Due Date', by: 'due', bill: 'Bill Date' })
  expect(ageingColumns([col('Party'), col('Bill Date', 'DATE'), col('Due Date', 'DATE'), col('Amount', 'DOUBLE'), col('Status')])).toBe(null)
  expect(ageingColumns([col('Party'), col('Due Date', 'DATE'), col('Amount', 'DOUBLE'), col('Payment Terms')])).toMatchObject({ amount: 'Amount' })
})

test('each party’s open bills by how long they’ve been due, biggest first, and a total', async () => {
  // As Tally writes Bills Receivable: amounts owed as Dr, an advance as Cr.
  await q(`CREATE OR REPLACE TABLE bills AS SELECT * FROM (VALUES
    ('Acme Ltd', '11,800.00 Dr', DATE '2024-04-10'), ('Acme Ltd', '5,000.00 Dr', DATE '2024-01-20'), ('Beta', '2,000.00 Dr', DATE '2024-05-15'),
    ('Beta', '500.00 Cr', DATE '2024-04-25'), ('Gamma', '9,000.00 Dr', DATE '2023-09-30'), ('Gamma', '1,000.00 Dr', NULL),
    ('Total', '28,300.00 Dr', NULL)
  ) t("Party's Name", "Pending Amount", "Due on")`)
  const a = { party: "Party's Name", amount: 'Pending Amount', date: 'Due on', by: 'due' as const }
  const rows = await q(ageingSql('SELECT * FROM bills', a, '2024-04-30', () => false))
  expect(Object.keys(rows[0])).toEqual(["Party's Name", 'Not yet due', '0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days', 'No date', 'On account', 'Total'])
  // Beta's advance is on account, not in a bucket; the export's own Total line isn't a party.
  expect(rows.map((r) => Object.values(r).map(paise))).toEqual([
    ['Acme Ltd', 0, 11800, 0, 0, 5000, 0, 0, 0, 16800],
    ['Gamma', 0, 0, 0, 0, 0, 9000, 1000, 0, 10000],
    ['Beta', 2000, 0, 0, 0, 0, 0, 0, -500, 1500],
    ['Total', 2000, 11800, 0, 0, 5000, 9000, 1000, -500, 28300],
  ])
})

test('as on a day in the past, bills raised after it aren’t counted', async () => {
  await q(`CREATE OR REPLACE TABLE later AS SELECT * FROM (VALUES
    ('Deccan', '2,36,000.00 Dr', DATE '2026-10-10', DATE '2026-11-09'), ('Deccan', '23,600.00 Dr', DATE '2026-08-01', DATE '2026-08-31')
  ) t("Party's Name", "Pending Amount", "Date", "Due on")`)
  const a = { party: "Party's Name", amount: 'Pending Amount', date: 'Due on', by: 'due' as const, bill: 'Date' }
  const rows = await q(ageingSql('SELECT * FROM later', a, '2026-09-30', () => false))
  expect(rows.map((r) => [r["Party's Name"], ...[r['Not yet due'], r['0–30 days'], r.Total].map(paise)])).toEqual([
    ['Deccan', 0, 23600, 23600],
    ['Total', 0, 23600, 23600],
  ])
})
