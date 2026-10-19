import { expect, test } from '@playwright/test'
import type { TableColumns } from '../../src/engine/compare-sql'
import { sourceName, stackCandidates, stackLossSql, stackOverlapSql, stackReport, stackSql, textColumns } from '../../src/engine/stack'
import { q } from './duck'

async function table(name: string, sql: string): Promise<TableColumns> {
  await q(`CREATE OR REPLACE TABLE "${name}" AS ${sql}`)
  const cols = await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = '${name}' ORDER BY ordinal_position`)
  return { name, columns: cols.map((c) => ({ name: String(c.name), type: String(c.type) })) }
}

test.describe('stack tables (run on DuckDB)', () => {
  test('rows from every table, matched by column name, with where each came from', async () => {
    const jan = await table('sales jan', `SELECT * FROM (VALUES (1, 'Pune', 10.5::DOUBLE)) t(id, city, amount)`)
    const feb = await table('sales feb', `SELECT * FROM (VALUES ('Goa', 2, 7)) t(city, id, amount)`) // other order, int amount
    const mar = await table('sales mar', `SELECT * FROM (VALUES (3, 'Agra', 1::DOUBLE, 'web')) t(id, city, amount, channel)`) // extra column
    const all = [jan, feb, mar]
    const sql = stackSql({ tables: ['sales jan', 'sales feb', 'sales mar'], source: sourceName(all) }, all)
    expect(sql).toContain('UNION ALL BY NAME')
    const rows = await q(`${sql}\nORDER BY id`)
    expect(rows).toEqual([
      { source: 'sales jan', id: 1, city: 'Pune', amount: 10.5, channel: null },
      { source: 'sales feb', id: 2, city: 'Goa', amount: 7, channel: null },
      { source: 'sales mar', id: 3, city: 'Agra', amount: 1, channel: 'web' },
    ])
    expect(stackReport(all)).toEqual({ partial: ['channel'], asText: [], asNumbers: [], columns: 4 })
  })

  test('a column that is a date in one file and text in another is stacked as text', async () => {
    const a = await table('a1', `SELECT DATE '2024-01-05' AS day, 1 AS n`)
    const b = await table('b1', `SELECT '05/02/2024' AS day, 2 AS n`)
    const rows = await q(stackSql({ tables: ['a1', 'b1'], source: null }, [a, b]))
    expect(rows.map((r) => r.day)).toEqual(['2024-01-05', '05/02/2024'])
    expect(stackReport([a, b]).asText).toEqual(['day'])
  })

  test('the source column never takes a name the data uses; similar tables are found', async () => {
    const t1 = await table('t1', `SELECT 1 AS source, 2 AS x`)
    const t2 = await table('t2', `SELECT 1 AS source_table, 2 AS x`)
    expect(sourceName([t1, t2])).toBe('source_file')
    const other = await table('t3', `SELECT 1 AS y, 2 AS z`)
    expect(stackCandidates('t1', [t1, t2, other])).toEqual(['t1'])
    expect(stackCandidates('t1', [t1, { name: 't4', columns: [{ name: 'X', type: 'INTEGER' }, { name: 'source', type: 'INTEGER' }] }, other])).toEqual(['t1', 't4'])
  })
})

test('a month whose amounts were read as text (an "N/A" among them) stacks as numbers, counting what isn’t one', async () => {
  const jan = await table('m1', `SELECT * FROM (VALUES (1, 10.5::DOUBLE), (2, 20::DOUBLE)) t(id, amount)`)
  const feb = await table('m2', `SELECT * FROM (VALUES (3, '1,234.50'), (4, 'N/A'), (5, '')) t(id, amount)`)
  expect(stackReport([jan, feb])).toMatchObject({ asText: [], asNumbers: [{ column: 'amount', tables: ['m2'] }] })
  const rows = await q(`${stackSql({ tables: ['m1', 'm2'], source: null }, [jan, feb])}\nORDER BY id`)
  expect(rows.map((r) => r.amount)).toEqual([10.5, 20, 1234.5, null, null])
  expect(await q(stackLossSql([jan, feb])!)).toEqual([{ tbl: 'm2', col: 'amount', filled: 2, lost: 1, example: 'N/A' }])
  expect(stackLossSql([jan, jan])).toBe(null)
})

test('an identifier, or a column mostly of text, stacks as text: nothing is emptied', async () => {
  const jan = await table('i1', `SELECT * FROM (VALUES (1001, 98765, 10.0::DOUBLE), (1002, 98766, 20.0::DOUBLE)) t("Invoice No", phone, amount)`)
  const feb = await table('i2', `SELECT * FROM (VALUES ('INV/24/1003', '+91 98765 11111', 'N/A'), ('INV/24/1004', '+91 98765 22222', 'tbc')) t("Invoice No", phone, amount)`)
  expect(stackReport([jan, feb])).toMatchObject({ asText: ['Invoice No', 'phone'], asNumbers: [{ column: 'amount', tables: ['i2'] }] })
  const losses = (await q(stackLossSql([jan, feb])!)).map((r) => ({ table: String(r.tbl), column: String(r.col), filled: Number(r.filled), lost: Number(r.lost), example: String(r.example) }))
  expect(textColumns(losses)).toEqual(['amount'])
  expect(stackReport([jan, feb], ['amount']).asText).toEqual(['Invoice No', 'phone', 'amount'])
  const rows = await q(`${stackSql({ tables: ['i1', 'i2'], source: null, text: ['amount'] }, [jan, feb])}\nORDER BY 1`)
  expect(rows.map((r) => [r['Invoice No'], r.amount])).toEqual([['1001', '10.0'], ['1002', '20.0'], ['INV/24/1003', 'N/A'], ['INV/24/1004', 'tbc']])
})

test('rows in two of the tables (a month and its revision) are found before they count twice', async () => {
  const dec = await table('dec', `SELECT * FROM (VALUES (1, 'Pune', 10), (2, 'Goa', 20), (3, 'Agra', 30)) t(id, city, amount)`)
  const rev = await table('dec_rev', `SELECT * FROM (VALUES (1, 'Pune', 10), (2, 'Goa', 25), (3, 'Agra', 30)) t(id, city, amount)`)
  const nov = await table('nov', `SELECT * FROM (VALUES (4, 'Pune', 10)) t(id, city, amount)`)
  const rows = await q(stackOverlapSql({ tables: ['dec', 'dec_rev', 'nov'], source: null }, [dec, rev, nov]))
  expect(rows.map((r) => ({ tables: [...(r.tables as { toArray: () => string[] }).toArray()], n: r.n }))).toEqual([{ tables: ['dec', 'dec_rev'], n: 2 }])
  expect(await q(stackOverlapSql({ tables: ['dec', 'nov'], source: null }, [dec, nov]))).toEqual([])
})

test('dates and timestamps stack as timestamps, not text', async () => {
  const a = await table('d1', `SELECT DATE '2024-01-05' AS day`)
  const b = await table('d2', `SELECT TIMESTAMP '2024-02-01 10:30:00' AS day`)
  expect(stackReport([a, b]).asText).toEqual([])
  const rows = await q(`SELECT typeof(day) AS t FROM (${stackSql({ tables: ['d1', 'd2'], source: null }, [a, b])}) LIMIT 1`)
  expect(rows[0].t).toBe('TIMESTAMP')
})

test('a stack of months is named for all of them', async () => {
  const { stackLabel } = await import('../../src/engine/sql')
  expect(stackLabel(Array.from({ length: 12 }, (_, i) => `sales_2024_${String(i + 1).padStart(2, '0')}`))).toBe('sales_2024_01-12')
  expect(stackLabel(['m_2024_12', 'm_2024_01'])).toBe('m_2024_01-12')
  expect(stackLabel(['branch_pune', 'branch_goa'])).toBe('branch_goa-pune')
  expect(stackLabel(['jan', 'feb', 'mar'])).toBe('feb-and-2-more')
  expect(stackLabel(Array.from({ length: 12 }, (_, i) => `sales_${i + 1}`))).toBe('sales_1-12')
})
