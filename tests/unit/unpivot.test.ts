import { expect, test } from '@playwright/test'
import { seriesColumns, unpivotNames, unpivotSql } from '../../src/engine/unpivot'
import { q } from './duck'

const cols = (...names: string[]) => names.map((name) => ({ name, type: 'BIGINT' }))

test('series of months, quarters and years are recognised; other columns are not', () => {
  expect(seriesColumns(cols('region', 'Jan', 'Feb', 'Mar', 'total'))).toEqual({ kind: 'month', columns: ['Jan', 'Feb', 'Mar'] })
  expect(seriesColumns(cols('Apr-24', 'May-24', 'June 2024', 'Jul 24'))?.kind).toBe('month')
  expect(seriesColumns(cols('2024-01', '2024-02', '2024-03'))?.kind).toBe('month')
  expect(seriesColumns(cols('Q1', 'Q2', 'Q3', 'Q4'))?.columns).toHaveLength(4)
  expect(seriesColumns(cols('FY2022', 'FY2023', '2024-25'))?.kind).toBe('year')
  expect(seriesColumns(cols('city', 'march_sales', 'amount'))).toBeNull()
  expect(seriesColumns(cols('Jan', 'Feb'))).toBeNull() // two is a coincidence, not a series
  expect(seriesColumns(cols('mayor', 'decimal', 'octane'))).toBeNull()
})

test('new column names never clash with the ones left', () => {
  expect(unpivotNames('month', ['region', 'value'])).toEqual({ name: 'month', value: 'value_2' })
  expect(unpivotNames(null, ['column'])).toEqual({ name: 'column_2', value: 'value' })
})

test('the SQL turns columns into rows on DuckDB, numbers staying numbers', async () => {
  await q(`CREATE OR REPLACE TABLE wide AS SELECT * FROM (VALUES ('North', 10, 12.5, NULL), ('South', 7, 8.0, 9.25)) t(region, "Jan", "Feb", "Mar")`)
  const types = await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = 'wide'`)
  const sql = unpivotSql('wide', { columns: ['Jan', 'Feb', 'Mar'], name: 'month', value: 'amount' }, types as { name: string; type: string }[])
  const rows = await q(`SELECT region, month, amount::DOUBLE AS amount, typeof(amount) AS t FROM (${sql})`)
  expect(rows.map((r) => [r.region, r.month, r.amount])).toEqual([
    ['North', 'Jan', 10],
    ['North', 'Feb', 12.5],
    ['South', 'Jan', 7],
    ['South', 'Feb', 8],
    ['South', 'Mar', 9.25],
  ])
  expect(rows[0].t).toMatch(/DECIMAL|DOUBLE/)
})

test('numbers mixed with text are unpivoted as text instead of failing', async () => {
  await q(`CREATE OR REPLACE TABLE mixed AS SELECT * FROM (VALUES ('a', 1, '₹2,000', DATE '2024-01-01')) t(k, "Q1", "Q2", "Q3")`)
  const types = await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = 'mixed'`)
  const rows = await q(unpivotSql('mixed', { columns: ['Q1', 'Q2', 'Q3'], name: 'quarter', value: 'value' }, types as { name: string; type: string }[]))
  expect(rows.map((r) => r.value)).toEqual(['1', '₹2,000', '2024-01-01'])
})

test('financial years, survey questions and stray numbers aren’t mistaken for a series', () => {
  expect(seriesColumns(cols('2008-09', '2009-10', '2010-11', '2011-12', '2012-13'))).toEqual({ kind: 'year', columns: ['2008-09', '2009-10', '2010-11', '2011-12', '2012-13'] })
  expect(seriesColumns(cols(...Array.from({ length: 20 }, (_, i) => `Q${i + 1}`)))).toBeNull()
  expect(seriesColumns(cols('50 q2', '60 q3', '70 q4'))).toBeNull()
  expect(seriesColumns(cols('2024 Q1', '2024 Q2', '2024 Q3'))?.kind).toBe('quarter')
  // Excel month headers come through as dates.
  expect(seriesColumns(cols('2024-01-01', '2024-02-01', '2024-03-01'))?.kind).toBe('month')
})

test('a month not reached yet (an empty column, read as text) doesn’t turn the numbers into text', async () => {
  await q(`CREATE OR REPLACE TABLE ytd AS SELECT * FROM (VALUES ('North', 10, 1.5, NULL::VARCHAR), ('South', NULL, 2.0, NULL)) t(region, "Jan", "Feb", "Mar")`)
  const types = (await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = 'ytd'`)) as { name: string; type: string }[]
  const spec = { columns: ['Jan', 'Feb', 'Mar'], name: 'month', value: 'amount' }
  const rows = await q(`SELECT month, amount::DOUBLE AS amount, typeof(amount) AS t FROM (${unpivotSql('ytd', spec, types, ['Mar'])})`)
  expect(rows.map((r) => [r.month, r.amount])).toEqual([
    ['Jan', 10],
    ['Feb', 1.5],
    ['Feb', 2],
  ])
  expect(rows[0].t).not.toBe('VARCHAR')
  // Kept as rows with an empty value, on request: every region keeps every month.
  const kept = await q(`SELECT count(*)::INT AS n FROM (${unpivotSql('ytd', { ...spec, keepEmpty: true }, types, ['Mar'])})`)
  expect(kept[0].n).toBe(6)
  // Dates and timestamps share a type without becoming text.
  await q(`CREATE OR REPLACE TABLE times AS SELECT DATE '2024-01-01' AS "Q1", TIMESTAMP '2024-04-01 10:00' AS "Q2", DATE '2024-07-01' AS "Q3"`)
  const t2 = (await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = 'times'`)) as { name: string; type: string }[]
  const [first] = await q(`SELECT typeof(value) AS t FROM (${unpivotSql('times', { columns: ['Q1', 'Q2', 'Q3'], name: 'quarter', value: 'value' }, t2)})`)
  expect(first.t).toMatch(/^TIMESTAMP/)
})
