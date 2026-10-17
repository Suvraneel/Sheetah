import { expect, test } from '@playwright/test'
import { changeColumn, compareLayout, compareSql, schemaDiff, type CompareSpec, type TableColumns } from '../../src/engine/compare-sql'
import { q } from './duck'

/** Creates a table and returns its columns the way the app sees them. */
async function table(name: string, sql: string): Promise<TableColumns> {
  await q(`CREATE OR REPLACE TABLE ${name} AS ${sql}`)
  const cols = await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = '${name}' ORDER BY ordinal_position`)
  return { name, columns: cols.map((c) => ({ name: String(c.name), type: String(c.type) })) }
}

const spec = (before: TableColumns, after: TableColumns, patch: Partial<CompareSpec> = {}): CompareSpec => ({
  before: before.name,
  after: after.name,
  mode: 'key',
  keys: ['id'],
  columns: schemaDiff(before, after).shared.filter((c) => c !== 'id'),
  trimSpaces: true,
  ignoreCase: true,
  tolerance: 0.01,
  includeSame: false,
  ...patch,
})

const kinds = (rows: Record<string, unknown>[], col = 'change') => rows.map((r) => `${r.id ?? ''}:${r[col]}`).sort()

test.describe('compare (run on DuckDB)', () => {
  test('matches a numeric key to the same key stored as text', async () => {
    const a = await table('ck_a', `SELECT * FROM (VALUES (1, 'Pune'), (2, 'Goa'), (3, 'Agra')) t(id, city)`)
    const b = await table('ck_b', `SELECT * FROM (VALUES ('1', 'Pune'), ('2', 'Delhi'), ('4', 'Kota')) t(id, city)`)
    const rows = await q(compareSql(spec(a, b), a, b))
    expect(kinds(rows)).toEqual(['2:changed', '3:removed', '4:added'])
  })

  test('tolerance applies to numbers with decimals, never to whole numbers', async () => {
    const a = await table('tol_a', `SELECT 1 AS id, 10.004::DOUBLE AS f, 10.004::DECIMAL(10,3) AS d, 10 AS n, 9007199254740993::UBIGINT AS big`)
    const b = await table('tol_b', `SELECT 1 AS id, 10.0::DOUBLE AS f, 10.0::DECIMAL(10,3) AS d, 11 AS n, 9007199254740993::UBIGINT AS big`)
    expect(await q(compareSql(spec(a, b), a, b))).toEqual([expect.objectContaining({ changed_columns: 'n' })])
    const loose = await q(compareSql(spec(a, b, { tolerance: 2 }), a, b))
    expect(loose[0].changed_columns).toBe('n') // 10 → 11 is a change even within 2
    expect(await q(compareSql(spec(a, b, { tolerance: null }), a, b))).toEqual([expect.objectContaining({ changed_columns: 'f, d, n' })])
  })

  test('whole rows: numbers compare as numbers across types, duplicates count', async () => {
    const a = await table('row_a', `SELECT * FROM (VALUES (1, 100), (1, 100), (2, 5)) t(x, amount)`)
    const b = await table('row_b', `SELECT * FROM (VALUES (1, 100.0), (3, 7.5)) t(x, amount)`)
    const s = spec(a, b, { mode: 'row', keys: [], columns: ['x', 'amount'] })
    const rows = await q(compareSql(s, a, b))
    expect(rows.map((r) => `${r.change}:${r.x}:${r.amount}`).sort()).toEqual(['added:3:7.5', 'removed:1:100', 'removed:2:5'])
  })

  test('a data column called "change" is kept; the marker column gets another name', async () => {
    const a = await table('cc_a', `SELECT * FROM (VALUES (1, 'up'), (2, 'down')) t(id, change)`)
    const b = await table('cc_b', `SELECT * FROM (VALUES (1, 'flat'), (3, 'up')) t(id, change)`)
    const s = spec(a, b)
    expect(changeColumn(s)).toBe('row_change')
    const rows = await q(compareSql(s, a, b))
    expect(kinds(rows, 'row_change')).toEqual(['1:changed', '2:removed', '3:added'])
    expect(rows.find((r) => r.id === 1)).toMatchObject({ change_before: 'up', change_after: 'flat', changed_columns: 'change', what_changed: 'change: up → flat' })
  })

  test('spaces and case are separate choices; spaces inside a value count too', async () => {
    const a = await table('ic_a', `SELECT 1 AS id, 'Navi Mumbai' AS city`)
    const b = await table('ic_b', `SELECT 1 AS id, '  navi   mumbai ' AS city`)
    expect(await q(compareSql(spec(a, b), a, b))).toHaveLength(0)
    expect(await q(compareSql(spec(a, b, { ignoreCase: false }), a, b))).toHaveLength(1)
    expect(await q(compareSql(spec(a, b, { trimSpaces: false }), a, b))).toHaveLength(1)
  })

  test('output names never collide with the data’s own columns', async () => {
    const a = await table('nm_a', `SELECT * FROM (VALUES (1, 'x', 'p', 5)) t(id, change, row_change, "id_before")`)
    const b = await table('nm_b', `SELECT * FROM (VALUES (1, 'y', 'p', 6)) t(id, change, row_change, "id_before")`)
    const s = spec(a, b, { columns: ['change', 'row_change', 'id_before'] })
    const layout = compareLayout(s)
    expect(layout.change).toBe('row_change_2')
    const [row] = await q(compareSql(s, a, b))
    expect(row).toMatchObject({ row_change_2: 'changed', change_before: 'x', change_after: 'y', id_before_before: 5, id_before_after: 6 })
    expect(row.changed_columns).toBe('change, id_before')
    // Whole rows: the marker is renamed the same way, and the data's own columns keep their names.
    const rows = await q(compareSql({ ...s, mode: 'row', keys: [], columns: ['id', 'change', 'row_change'] }, a, b))
    expect(Object.keys(rows[0])).toEqual(['row_change_2', 'id', 'change', 'row_change'])
  })

  test('a composite key with NULLs never matches NULL to NULL by accident', async () => {
    const a = await table('nk_a', `SELECT * FROM (VALUES ('x', 1, 'a'), ('y', NULL, 'b')) t(id, part, v)`)
    const b = await table('nk_b', `SELECT * FROM (VALUES ('x', 1, 'a'), ('y', NULL, 'b')) t(id, part, v)`)
    const rows = await q(compareSql(spec(a, b, { keys: ['id', 'part'], columns: ['v'] }), a, b))
    // NULL keys can't be matched: the row shows as removed and added rather than silently "same".
    expect(rows.map((r) => r.change).sort()).toEqual(['added', 'removed'])
  })
})

test('Compare opens on the pair worth comparing', async () => {
  const { likelyPair } = await import('../../src/engine/compare-sql')
  const t = (name: string, ...cols: string[]) => ({ name, columns: cols.map((c) => ({ name: c, type: 'VARCHAR' })) })
  const tables = [t('orders', 'id', 'total'), t('stock_april', 'sku', 'qty', 'site'), t('stock_march', 'sku', 'qty', 'site')]
  expect(likelyPair(tables)).toEqual({ before: 'stock_april', after: 'stock_march' })
  // The open table and its other version, the open one as "after".
  expect(likelyPair(tables, 'stock_april')).toEqual({ before: 'stock_march', after: 'stock_april' })
  expect(likelyPair([t('a', 'x'), t('b', 'y')])).toBeNull()
})
