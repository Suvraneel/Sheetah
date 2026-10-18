import { expect, test } from '@playwright/test'
import { ageingSql } from '../../src/engine/ageing'
import { ageingColumns } from '../../src/engine/statement'
import { q } from './duck'

const col = (name: string, type = 'VARCHAR') => ({ name, type })

test('a list of open bills is known by its pending amount, its party and its dates; a statement is not', () => {
  const bills = [col('Date', 'DATE'), col('Ref. No.'), col("Party's Name"), col('Pending Amount'), col('Due on', 'DATE'), col('Overdue by days', 'BIGINT')]
  expect(ageingColumns(bills)).toEqual({ party: "Party's Name", amount: 'Pending Amount', date: 'Due on', by: 'due' })
  expect(ageingColumns([col('Invoice Date', 'DATE'), col('Customer'), col('Balance Due', 'DOUBLE')])).toEqual({ party: 'Customer', amount: 'Balance Due', date: 'Invoice Date', by: 'bill' })
  expect(ageingColumns([col('Date', 'DATE'), col('Narration'), col('Withdrawal Amt.'), col('Deposit Amt.'), col('Closing Balance')])).toBe(null)
  expect(ageingColumns([col('Date', 'DATE'), col('Customer'), col('Amount', 'DOUBLE')])).toBe(null)
})

test('each party’s open bills by how long they’ve been due, biggest first, and a total', async () => {
  // As Tally writes Bills Receivable: amounts owed as Dr, an advance as Cr.
  await q(`CREATE OR REPLACE TABLE bills AS SELECT * FROM (VALUES
    ('Acme Ltd', '11,800.00 Dr', DATE '2024-04-10'), ('Acme Ltd', '5,000.00 Dr', DATE '2024-01-20'), ('Beta', '2,000.00 Dr', DATE '2024-05-15'),
    ('Beta', '500.00 Cr', DATE '2024-04-25'), ('Gamma', '9,000.00 Dr', DATE '2023-09-30'), ('Gamma', '1,000.00 Dr', NULL)
  ) t("Party's Name", "Pending Amount", "Due on")`)
  const a = { party: "Party's Name", amount: 'Pending Amount', date: 'Due on', by: 'due' as const }
  const rows = await q(ageingSql('SELECT * FROM bills', a, '2024-04-30', () => false))
  expect(Object.keys(rows[0])).toEqual(["Party's Name", 'Not yet due', '0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days', 'No date', 'Total'])
  expect(rows.map((r) => Object.values(r))).toEqual([
    ['Acme Ltd', 0, 11800, 0, 0, 5000, 0, 0, 16800],
    ['Gamma', 0, 0, 0, 0, 0, 9000, 1000, 10000],
    ['Beta', 2000, -500, 0, 0, 0, 0, 0, 1500],
    ['Total', 2000, 11300, 0, 0, 5000, 9000, 1000, 28300],
  ])
})
