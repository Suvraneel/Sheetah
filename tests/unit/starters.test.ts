import { expect, test } from '@playwright/test'
import { startersFor, type StarterColumn } from '../../src/components/starters'
import { q } from './duck'

async function columnsOf(table: string): Promise<StarterColumn[]> {
  const cols = await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`)
  const counts = (await q(`SELECT ${cols.map((c) => `approx_count_distinct("${c.name}")::DOUBLE AS "${c.name}"`).join(', ')} FROM "${table}"`))[0]
  return cols.map((c) => ({ name: String(c.name), type: String(c.type), distinct: Number(counts[String(c.name)]) }))
}

test.describe('starter queries for any table (run on DuckDB)', () => {
  test('totals by a category, a monthly trend, the largest rows and a summary — all runnable', async () => {
    await q(`CREATE OR REPLACE TABLE "Sales 2024" AS SELECT
        i AS order_id, ['North', 'South', 'East'][1 + i % 3] AS region, 'cust' || i AS customer,
        DATE '2024-01-01' + INTERVAL (i) DAY AS sold_on, (i * 7.5)::DOUBLE AS amount, 110001 + i AS pin
      FROM range(200) t(i)`)
    const starters = startersFor('Sales 2024', await columnsOf('Sales 2024'))
    expect(starters.map((s) => s.label)).toEqual(['amount by region', 'amount per month', 'Top 10 by amount', 'Summary of every column'])
    for (const s of starters) expect((await q(s.sql)).length, s.label).toBeGreaterThan(0)
    const [first] = await q(starters[0].sql)
    expect(Object.keys(first)).toEqual(['region', 'row_count', 'total_amount'])
  })

  test('without amounts or dates it still offers something useful', async () => {
    await q(`CREATE OR REPLACE TABLE people AS SELECT 'p' || i AS name, ['a', 'b'][1 + i % 2] AS "group", 2000 + i % 5 AS year FROM range(20) t(i)`)
    const starters = startersFor('people', await columnsOf('people'))
    // "year" is a label, not an amount; "group" is a reserved word and gets quoted.
    expect(starters.map((s) => s.label)).toEqual(['Rows by group', 'Summary of every column'])
    expect(starters[0].sql).toContain('"group"')
    for (const s of starters) expect((await q(s.sql)).length).toBeGreaterThan(0)
  })
})

test('a number that differs on every row is an ID, not something to total', async () => {
  await q(`CREATE OR REPLACE TABLE inv AS SELECT 1000 + i AS invoice_no2, i * 3 AS seq, ['a', 'b'][1 + i % 2] AS kind FROM range(50) t(i)`)
  const starters = startersFor('inv', await columnsOf('inv'), 50)
  expect(starters.map((s) => s.label)).toEqual(['Rows by kind', 'Summary of every column'])
})

test('a table with its own "month" column, and list columns, still gets runnable starters', async () => {
  await q(`CREATE OR REPLACE TABLE m AS SELECT ['Jan', 'Feb'][1 + i % 2] AS month, DATE '2024-01-01' + INTERVAL (i * 10) DAY AS order_date,
      (i * 2.5)::DOUBLE AS amount, [i, i + 1] AS tags, ['a', 'b', 'c'][1 + i % 3] AS segment FROM range(30) t(i)`)
  const starters = startersFor('m', await columnsOf('m'), 30)
  expect(starters.map((s) => s.label)).toEqual(['amount by segment', 'amount per month', 'Top 10 by amount', 'Summary of every column'])
  for (const s of starters) expect((await q(s.sql)).length, s.label).toBeGreaterThan(0)
})

test('an amount stored as text is no category; a category named like one still is', () => {
  const cols = [
    { name: 'Country', type: 'VARCHAR', distinct: 12 },
    { name: 'Unit Rate', type: 'VARCHAR', distinct: 8 },
    { name: 'Qty', type: 'BIGINT', distinct: 40 },
  ]
  expect(startersFor('sales', cols, 1000)[0].label).toBe('Qty by Country')
  expect(startersFor('sales', [cols[1], cols[2]], 1000).some((s) => s.label.includes('by Unit Rate'))).toBe(false)
  expect(startersFor('costs', [{ name: 'Cost Centre', type: 'VARCHAR', distinct: 6 }, cols[2]], 1000)[0].label).toBe('Qty by Cost Centre')
})

test('a statement’s amounts stored as text are no categories, however they are written', () => {
  const statement = ['Narration', 'Withdrawal Amt.', 'Deposit Amt.', 'Amount (INR)', 'Dr/Cr'].map((name, i) => ({ name, type: 'VARCHAR', distinct: 3 + i }))
  const labels = startersFor('stmt', statement, 500).map((s) => s.label)
  expect(labels.filter((l) => /^Rows by (Withdrawal|Deposit|Amount)/.test(l))).toEqual([])
})
