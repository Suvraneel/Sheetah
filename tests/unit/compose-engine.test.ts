import { expect, test } from '@playwright/test'
import { compose, emptyOps, type Filter, type Ops } from '../../src/engine/compose'
import { q } from './duck'

/*
 * The composed SQL, executed: filters, find and duplicates must return the right rows, not just
 * read nicely.
 */
test.beforeAll(async () => {
  await q(`CREATE OR REPLACE TABLE ev AS SELECT * FROM (VALUES
    (1, 'Pune',  TIMESTAMP '2024-01-30 09:00', DATE '2024-01-30', 1234.5::DOUBLE, 'a@x.in'),
    (2, 'pune',  TIMESTAMP '2024-01-31 00:00', DATE '2024-01-31', 99::DOUBLE,     NULL),
    (3, 'Goa',   TIMESTAMP '2024-01-31 23:59:59', DATE '2024-01-31', NULL,       'a@x.in'),
    (4, NULL,    TIMESTAMP '2024-02-01 00:00', DATE '2024-02-01', 5::DOUBLE,      NULL),
    (5, 'Delhi', TIMESTAMP '2024-02-02 10:00', DATE '2024-02-02', 1234.5::DOUBLE, 'b@x.in')
  ) t(id, city, "at", day, amount, email)`) // "at" is a reserved word: filters must quote it
})

const ids = async (ops: Partial<Ops>) => (await q(compose('SELECT * FROM ev', { ...emptyOps(), ...ops }))).map((r) => r.id)
const f = (x: Filter): Partial<Ops> => ({ filters: [x] })

test('a date typed into a timestamp column means the whole day', async () => {
  expect(await ids(f({ column: 'at', op: 'equals', value: '2024-01-31', type: 'TIMESTAMP' }))).toEqual([2, 3])
  expect(await ids(f({ column: 'at', op: 'between', value: '2024-01-30', value2: '2024-01-31', type: 'TIMESTAMP' }))).toEqual([1, 2, 3])
  expect(await ids(f({ column: 'at', op: 'lte', value: '2024-01-31', type: 'TIMESTAMP' }))).toEqual([1, 2, 3])
  expect(await ids(f({ column: 'at', op: 'gt', value: '2024-01-31', type: 'TIMESTAMP' }))).toEqual([4, 5])
  expect(await ids(f({ column: 'at', op: 'not_equals', value: '2024-01-31', type: 'TIMESTAMP' }))).toEqual([1, 4, 5])
  expect(await ids(f({ column: 'day', op: 'equals', value: '2024-01-31', type: 'DATE' }))).toEqual([2, 3])
})

test('text filters: case-insensitive when typed, exact when picked, empty values on request', async () => {
  expect(await ids(f({ column: 'city', op: 'equals', value: 'PUNE', type: 'VARCHAR' }))).toEqual([1, 2])
  expect(await ids(f({ column: 'city', op: 'equals', value: 'Pune', type: 'VARCHAR', exact: true }))).toEqual([1])
  expect(await ids(f({ column: 'city', op: 'in', values: ['Goa', null], type: 'VARCHAR', exact: true }))).toEqual([3, 4])
  expect(await ids(f({ column: 'city', op: 'not_contains', value: 'un', type: 'VARCHAR' }))).toEqual([3, 4, 5])
})

test('numbers typed with separators compare as numbers', async () => {
  expect(await ids(f({ column: 'amount', op: 'gte', value: '1,234.50', type: 'DOUBLE', numeric: true }))).toEqual([1, 5])
  expect(await ids(f({ column: 'amount', op: 'between', value: '5', value2: '99', type: 'DOUBLE', numeric: true }))).toEqual([2, 4])
  expect(await ids(f({ column: 'amount', op: 'not_equals', value: '99', type: 'DOUBLE', numeric: true }))).toEqual([1, 3, 4, 5])
})

test('find matches any column, literally, and numbers typed with separators', async () => {
  expect(await ids({ search: 'PUN' })).toEqual([1, 2])
  expect(await ids({ search: '1,234.5' })).toEqual([1, 5])
  expect(await ids({ search: '%' })).toEqual([])
  expect(await ids({ search: 'x.in' })).toEqual([1, 3, 5])
})

test('duplicates: empty values never repeat each other, and removing keeps the first of each', async () => {
  expect(await ids({ dedupe: { column: 'email', mode: 'show' } })).toEqual([1, 3])
  expect(await ids({ dedupe: { column: 'email', mode: 'remove' } })).toEqual([1, 2, 4, 5])
  expect(await ids({ dedupe: { column: 'amount', mode: 'remove' }, filters: [{ column: 'id', op: 'gt', value: '1', numeric: true, type: 'INTEGER' }] })).toEqual([2, 3, 4, 5])
})

test('sort, filters and a computed column compose into one query', async () => {
  const rows = await q(
    compose('SELECT * FROM ev', {
      ...emptyOps(),
      computed: [{ name: 'double amount', expr: 'amount * 2' }],
      filters: [{ column: 'double amount', op: 'gt', value: '10', numeric: true, type: 'DOUBLE' }],
      sort: { column: 'double amount', dir: 'desc' },
    }),
  )
  expect(rows.map((r) => r.id)).toEqual([1, 5, 2])
  expect(rows[0]['double amount']).toBe(2469)
})

test('hidden columns leave the result but still filter and sort', async () => {
  const rows = await q(
    compose('SELECT * FROM ev', {
      ...emptyOps(),
      hidden: ['email', 'at'],
      filters: [{ column: 'email', op: 'not_null', type: 'VARCHAR' }],
      sort: { column: 'id', dir: 'desc' },
    }),
  )
  expect(Object.keys(rows[0])).toEqual(['id', 'city', 'day', 'amount'])
  expect(rows.map((r) => r.id)).toEqual([5, 3, 1])
  expect(compose('SELECT * FROM ev', { ...emptyOps(), hidden: ['email'] })).toBe('SELECT * EXCLUDE (email)\nFROM ev')
})

test('find looks only at the columns you can see', async () => {
  expect(await ids({ search: 'x.in' })).toEqual([1, 3, 5])
  expect(await ids({ search: 'x.in', hidden: ['email'] })).toEqual([])
})
