import { expect, test } from '@playwright/test'
import { compose, emptyOps } from '../../src/engine/compose'
import { lookupNames, lookupStatsSql, suggestMatch, type Lookup } from '../../src/engine/lookup'
import { q } from './duck'

test.beforeAll(async () => {
  await q(`CREATE OR REPLACE TABLE sales AS SELECT * FROM (VALUES (1, 'SKU-1', 2), (2, 'sku-2 ', 1), (3, 'SKU-9', 5), (4, 'SKU-1', 1)) t(id, sku, qty)`)
  await q(`CREATE OR REPLACE TABLE products AS SELECT * FROM (VALUES ('SKU-1', 'Lamp', 500::DOUBLE, 'old'), ('SKU-2', 'Mug', 120::DOUBLE, 'x'), ('SKU-1', 'Lamp v2', 550::DOUBLE, 'dup'), (NULL, 'Ghost', 1::DOUBLE, 'n')) t(sku, product, price, qty)`)
  await q(`CREATE OR REPLACE TABLE codes AS SELECT * FROM (VALUES ('1', 'one'), ('3', 'three')) t(code, label)`)
})

const base = (patch: Partial<Lookup>): Lookup => ({
  table: 'products',
  here: 'sku',
  there: 'sku',
  bring: lookupNames(['id', 'sku', 'qty'], 'products', ['product', 'price', 'qty']),
  loose: true,
  types: { here: 'VARCHAR', there: 'VARCHAR' },
  ...patch,
})

test.describe('look up values from another table (run on DuckDB)', () => {
  test('every row stays exactly once; the first match wins; no match is empty', async () => {
    const rows = await q(compose('SELECT * FROM sales', { ...emptyOps(), lookups: [base({})], sort: { column: 'id', dir: 'asc' } }))
    expect(rows).toEqual([
      { id: 1, sku: 'SKU-1', qty: 2, product: 'Lamp', price: 500, qty_products: 'old' },
      { id: 2, sku: 'sku-2 ', qty: 1, product: 'Mug', price: 120, qty_products: 'x' }, // case and spaces ignored
      { id: 3, sku: 'SKU-9', qty: 5, product: null, price: null, qty_products: null },
      { id: 4, sku: 'SKU-1', qty: 1, product: 'Lamp', price: 500, qty_products: 'old' },
    ])
  })

  test('exact matching when asked; numbers match text keys', async () => {
    const strict = await q(compose('SELECT * FROM sales', { ...emptyOps(), lookups: [base({ loose: false })] }))
    expect(strict.filter((r) => r.product !== null)).toHaveLength(2)
    const byId = await q(
      compose('SELECT * FROM sales', {
        ...emptyOps(),
        lookups: [{ table: 'codes', here: 'id', there: 'code', bring: [{ column: 'label', as: 'label' }], loose: true, types: { here: 'INTEGER', there: 'VARCHAR' } }],
        sort: { column: 'id', dir: 'asc' },
      }),
    )
    expect(byId.map((r) => r.label)).toEqual(['one', null, 'three', null])
  })

  test('filters can use the looked-up columns', async () => {
    const rows = await q(
      compose('SELECT * FROM sales', { ...emptyOps(), lookups: [base({})], filters: [{ column: 'price', op: 'gt', value: '200', numeric: true, type: 'DOUBLE' }] }),
    )
    expect(rows.map((r) => r.id).sort()).toEqual([1, 4])
  })

  test('match stats: rows matched and keys repeated in the other table', async () => {
    const [s] = await q(lookupStatsSql('sales', base({})))
    expect(s).toEqual({ rows: 4, matched: 3, repeated: 1 })
  })

  test('helpers: names never collide, likely match columns are found', () => {
    expect(lookupNames(['qty', 'qty_products'], 'products', ['qty', 'price'])).toEqual([
      { column: 'qty', as: 'qty_products_2' },
      { column: 'price', as: 'price' },
    ])
    expect(suggestMatch('SKU', [{ name: 'product' }, { name: 'sku' }])).toBe('sku')
    expect(suggestMatch('customer_id', [{ name: 'name' }, { name: 'CustomerID' }])).toBe('CustomerID')
    expect(suggestMatch('cust_code', [{ name: 'customer' }, { name: 'cust_no' }])).toBe('cust_no')
    expect(suggestMatch('zzz', [{ name: 'a' }])).toBeNull()
  })
})

test.describe('look up: order and awkward keys', () => {
  test('rows keep their order, matched or not (no sort needed)', async () => {
    await q(`CREATE OR REPLACE TABLE big_q AS SELECT i AS id, 'c' || (i % 50) AS cust FROM range(3000) t(i) ORDER BY i DESC`)
    await q(`CREATE OR REPLACE TABLE custs AS SELECT 'c' || i AS cust, 'name ' || i AS who FROM range(0, 50, 2) t(i)`) // only even customers
    const ids = (await q(compose('SELECT * FROM big_q', { ...emptyOps(), lookups: [{ table: 'custs', here: 'cust', there: 'cust', bring: [{ column: 'who', as: 'who' }], loose: false, types: { here: 'VARCHAR', there: 'VARCHAR' } }] }))).map((r) => r.id)
    expect(ids).toEqual(Array.from({ length: 3000 }, (_, i) => 2999 - i))
  })

  test('numbers match numbers written as text; dates match timestamps; blanks match nothing', async () => {
    await q(`CREATE OR REPLACE TABLE k1 AS SELECT * FROM (VALUES (1001.0::DOUBLE, DATE '2024-01-01', ''), (7::DOUBLE, DATE '2024-01-02', '  ')) t(code, day, tag)`)
    await q(`CREATE OR REPLACE TABLE k2 AS SELECT * FROM (VALUES ('1001', TIMESTAMP '2024-01-01 00:00:00', '', 'hit'), (' 7 ', TIMESTAMP '2024-01-02 00:00:00', ' ', 'seven')) t(code, "at", tag, label)`)
    const run = (here: string, there: string, types: { here: string; there: string }) =>
      q(compose('SELECT * FROM k1', { ...emptyOps(), lookups: [{ table: 'k2', here, there, bring: [{ column: 'label', as: 'label' }], loose: true, types }] })).then((rows) => rows.map((r) => r.label))
    expect(await run('code', 'code', { here: 'DOUBLE', there: 'VARCHAR' })).toEqual(['hit', 'seven'])
    expect(await run('day', 'at', { here: 'DATE', there: 'TIMESTAMP' })).toEqual(['hit', 'seven'])
    expect(await run('tag', 'tag', { here: 'VARCHAR', there: 'VARCHAR' })).toEqual([null, null])
  })
})

test('the values that find no match are listed, most rows first', async () => {
  const { lookupMissesSql } = await import('../../src/engine/lookup')
  await q("CREATE OR REPLACE TABLE lm_sales AS SELECT * FROM (VALUES ('A-1'), ('a-1 '), ('Z-9'), ('Z-9'), ('Q-2'), (NULL), ('')) t(sku)")
  await q("CREATE OR REPLACE TABLE lm_products AS SELECT * FROM (VALUES ('A-1'), ('B-2')) t(SKU)")
  const rows = await q(lookupMissesSql('lm_sales', { table: 'lm_products', here: 'sku', there: 'SKU', loose: true, types: { here: 'VARCHAR', there: 'VARCHAR' } }))
  expect(rows).toEqual([{ v: 'Z-9', n: 2 }, { v: 'Q-2', n: 1 }])
})
