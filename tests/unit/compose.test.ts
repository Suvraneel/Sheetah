import { expect, test } from '@playwright/test'
import { addFilter, compose, describeFilter, emptyOps, parseNumber, removePick, type Filter } from '../../src/engine/compose'
import { q } from './duck'

const pick = (column: string, value: string | undefined): Filter => ({ column, op: 'equals', value, exact: true, type: 'VARCHAR' })

test.describe('composed SQL', () => {
  test('numbers are read the way people type them, and kept exact', () => {
    expect(parseNumber('1,234.50')).toBe('1234.50')
    expect(parseNumber('₹ 12,34,567')).toBe('1234567')
    expect(parseNumber('(250)')).toBe('-250')
    expect(parseNumber('.5')).toBe('0.5')
    expect(parseNumber('1e6')).toBe('1e6')
    expect(parseNumber('9007199254740993')).toBe('9007199254740993')
    expect(parseNumber('abc')).toBeNull()
    expect(parseNumber('1.2.3')).toBeNull()
  })

  test('a plain table query is filtered in place, readably', () => {
    const sql = compose('SELECT * FROM orders', {
      ...emptyOps(),
      filters: [{ column: 'total', op: 'gt', value: '1,000', numeric: true, type: 'DOUBLE' }],
      sort: { column: 'city', dir: 'desc' },
    })
    expect(sql).toBe('SELECT *\nFROM orders\nWHERE total > 1000\nORDER BY city DESC NULLS LAST')
  })

  test('other queries are wrapped without re-indenting (multi-line strings stay intact)', () => {
    const base = "SELECT * FROM notes WHERE s = 'line1\nline2'"
    const sql = compose(base, { ...emptyOps(), sort: { column: 's', dir: 'asc' } })
    expect(sql).toContain("'line1\nline2'")
    expect(sql.startsWith('SELECT *\nFROM (\n' + base + '\n)')).toBe(true)
  })

  test('only the last statement of a script is composed', () => {
    const sql = compose('CREATE TABLE t AS SELECT 1 AS a; SELECT * FROM t', { ...emptyOps(), sort: { column: 'a', dir: 'asc' } })
    expect(sql).not.toContain('CREATE')
    expect(sql).toContain('FROM t')
  })

  test('filters: contains is literal, equals ignores case unless picked, numbers stay exact', () => {
    const where = (f: Filter) => compose('SELECT * FROM t', { ...emptyOps(), filters: [f] }).split('WHERE ')[1]
    expect(where({ column: 's', op: 'contains', value: '50%', type: 'VARCHAR' })).toBe("contains(lower(s), lower('50%'))")
    expect(where({ column: 's', op: 'equals', value: 'Delhi', type: 'VARCHAR' })).toBe("lower(s) = lower('Delhi')")
    expect(where(pick('s', 'Delhi'))).toBe("s = 'Delhi'")
    expect(where({ column: 'id', op: 'equals', value: '9007199254740993', numeric: true, type: 'UBIGINT' })).toBe('id = 9007199254740993')
    expect(where({ column: 'd', op: 'between', value: '2024-01-01', value2: '2024-12-31', type: 'DATE' })).toBe("d BETWEEN '2024-01-01' AND '2024-12-31'")
    expect(where({ column: 'n', op: 'equals', type: 'INTEGER', numeric: true })).toBe('n IS NULL')
  })

  test('picking values builds an IN list; un-picking shrinks it back', () => {
    let filters = addFilter([], pick('city', 'Delhi'))
    filters = addFilter(filters, pick('city', 'Pune'))
    filters = addFilter(filters, pick('city', undefined))
    expect(filters).toHaveLength(1)
    expect(compose('SELECT * FROM t', { ...emptyOps(), filters })).toContain("(city IN ('Delhi', 'Pune') OR city IS NULL)")
    expect(describeFilter(filters[0])).toBe('city is Delhi or Pune or empty')
    filters = removePick(filters, 'city', null)
    filters = removePick(filters, 'city', 'Pune')
    expect(filters).toEqual([{ ...pick('city', 'Delhi'), values: undefined }])
    expect(removePick(filters, 'city', 'Delhi')).toEqual([])
  })
})

test.describe('find and duplicates', () => {
  test('find searches every column as text', () => {
    expect(compose('SELECT * FROM t', { ...emptyOps(), search: '50%' })).toBe(
      "SELECT *\nFROM t\nWHERE contains(lower(concat_ws(' ', *COLUMNS(*))), lower('50%'))",
    )
  })

  test('duplicates: show repeats, or keep the first of each in the original order', () => {
    expect(compose('SELECT * FROM t', { ...emptyOps(), dedupe: { column: 'email', mode: 'show' } })).toBe(
      'SELECT *\nFROM t\nQUALIFY email IS NOT NULL AND count(*) OVER (PARTITION BY email) > 1\nORDER BY email',
    )
    const keep = compose('SELECT * FROM t', { ...emptyOps(), dedupe: { column: 'email', mode: 'remove' }, sort: { column: 'id', dir: 'asc' } })
    expect(keep).toContain('QUALIFY email IS NULL OR row_number() OVER (PARTITION BY email ORDER BY __sheetah_row) = 1')
    expect(keep.endsWith('ORDER BY id ASC NULLS LAST')).toBe(true)
  })
})

test('dates typed into a date-and-time column mean the whole day', () => {
  const where = (f: Filter) => compose('SELECT * FROM t', { ...emptyOps(), filters: [f] }).split('WHERE ')[1]
  expect(where({ column: 'ts', op: 'equals', value: '2024-01-31', type: 'TIMESTAMP' })).toBe("ts::DATE = DATE '2024-01-31'")
  expect(where({ column: 'ts', op: 'between', value: '2024-01-01', value2: '2024-01-31', type: 'TIMESTAMP' })).toBe(
    "ts >= '2024-01-01' AND ts < DATE '2024-01-31' + INTERVAL 1 DAY",
  )
  expect(where({ column: 'd', op: 'equals', value: '2024-01-31', type: 'DATE' })).toBe("d = '2024-01-31'")
})

test('find also matches numbers typed with separators', () => {
  expect(compose('SELECT * FROM t', { ...emptyOps(), search: '1,234' })).toContain("contains(lower(concat_ws(' ', *COLUMNS(*))), '1234')")
})

test('filters on a percentage column read as percentages', () => {
  expect(describeFilter({ column: 'GST %', op: 'gt', value: '0.12', numeric: true, percent: true })).toBe('GST % > 12%')
  expect(describeFilter({ column: 'GST %', op: 'in', values: ['0.18', null], numeric: true, percent: true, exact: true })).toBe('GST % is 18% or empty')
})

test('typed SQL can be run on the tidied rows of the table it reads', async () => {
  const { onTidiedRows, tidySteps } = await import('../../src/engine/compose')
  await q("CREATE OR REPLACE TABLE reg AS SELECT * FROM (VALUES ('North', '1,200'), ('South', '800'), ('Grand Total', '2,000')) t(region, amount)")
  const ops = { ...emptyOps(), drop: [{ label: '1 total line', keep: 'NOT is_grand_or_subtotal(region)' }], clean: [{ column: 'amount', kind: 'number' as const }], filters: [{ column: 'region', op: 'equals' as const, value: 'North' }] }
  const { ops: tidy, count } = tidySteps(ops)
  expect(count).toBe(2) // a filter narrows the view; it isn't tidying
  const tidied = compose('SELECT * FROM reg', tidy)
  const typed = 'SELECT sum(amount) AS total FROM reg'
  expect((await q(onTidiedRows(typed, 'reg', tidied, count)))[0].total).toBe(2000)
  // A query with its own WITH, and comments on top.
  const own = '-- mine\nWITH big AS (SELECT * FROM reg WHERE amount > 900)\nSELECT count(*)::INT AS n FROM big'
  const wrapped = onTidiedRows(own, 'reg', tidied, count)
  expect(wrapped.startsWith('-- mine\n-- reg with its 2 tidy-up steps\nWITH reg AS (')).toBe(true)
  expect((await q(wrapped))[0].n).toBe(1)
})
