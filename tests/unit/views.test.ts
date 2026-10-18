import { expect, test } from '@playwright/test'
import { referencedTables, remapTables, tablesIn, viewNameFor, viewsThatFit, type SavedView } from '../../src/engine/views'
import { exportViews, mergeViews, parseViews } from '../../src/engine/views-file'

const view = (over: Partial<SavedView>): SavedView => ({ id: 'v', name: 'Tidy', sql: 'SELECT * FROM april', tables: ['april'], savedAt: 1, ...over })
const cols = (...names: string[]) => names.map((name) => ({ name }))

test('a saved view fits next month’s file when that file has its table’s columns', () => {
  const tidy = view({ shapes: { april: ['Region', 'Amount', 'Date'] } })
  expect(viewsThatFit([tidy], { name: 'may', columns: cols('region', 'amount', 'date', 'notes') })).toEqual([{ view: tidy, from: 'april' }])
  // A column missing, the same table, no shape saved, or a view over two tables: not offered.
  expect(viewsThatFit([tidy], { name: 'may', columns: cols('region', 'amount') })).toEqual([])
  expect(viewsThatFit([tidy], { name: 'April', columns: cols('region', 'amount', 'date') })).toEqual([])
  expect(viewsThatFit([view({})], { name: 'may', columns: cols('region') })).toEqual([])
  expect(viewsThatFit([view({ tables: ['a', 'b'], shapes: { a: ['x', 'y'], b: ['x', 'y'] } })], { name: 'c', columns: cols('x', 'y') })).toEqual([])
  // This month's sales looked up in the product list: May's sales fit while the product list is open.
  const lookedUp = view({ tables: ['sales_apr', 'products'], shapes: { sales_apr: ['sku', 'qty', 'region'], products: ['sku', 'cost'] } })
  expect(viewsThatFit([lookedUp], { name: 'sales_may', columns: cols('sku', 'qty', 'region') }, ['sales_may', 'products'])).toEqual([{ view: lookedUp, from: 'sales_apr' }])
  expect(viewsThatFit([lookedUp], { name: 'sales_may', columns: cols('sku', 'qty', 'region') }, ['sales_may'])).toEqual([])
})

test('the most recently used view comes first, and runs on the new table', () => {
  const old = view({ id: 'old', savedAt: 1, shapes: { april: ['a', 'b'] } })
  const used = view({ id: 'used', savedAt: 1, lastRunAt: 5, shapes: { april: ['a', 'b'] } })
  const [first] = viewsThatFit([old, used], { name: 'may', columns: cols('a', 'b') })
  expect(first.view.id).toBe('used')
  expect(remapTables(first.view.sql, { [first.from]: 'sales may' })).toBe('SELECT * FROM "sales may"')
})

test('re-pointing a view renames the table, never a column that shares its name', () => {
  const m = { sales: 'sales_may' }
  expect(remapTables('SELECT number_from_text(sales) AS sales FROM sales', m)).toBe('SELECT number_from_text(sales) AS sales FROM sales_may')
  expect(remapTables('SELECT sales.amount FROM regions r JOIN sales ON sales.region = r.region', m)).toBe(
    'SELECT sales_may.amount FROM regions r JOIN sales_may ON sales_may.region = r.region',
  )
  expect(remapTables('SELECT * FROM regions, sales WHERE sales > 1', m)).toBe('SELECT * FROM regions, sales_may WHERE sales > 1')
  expect(remapTables('SELECT sales FROM (SELECT sales, x FROM sales) WHERE sales > 0', m)).toBe('SELECT sales FROM (SELECT sales, x FROM sales_may) WHERE sales > 0')
  expect(remapTables("SELECT 'from sales' AS note FROM \"sales\"", m)).toBe("SELECT 'from sales' AS note FROM sales_may")
  expect(remapTables('SELECT * FROM sales UNPIVOT (v FOR n IN (a, b))', m)).toBe('SELECT * FROM sales_may UNPIVOT (v FOR n IN (a, b))')
})

test('a view finds the tables it reads, not columns named like tables', () => {
  expect(referencedTables('SELECT orders FROM customers', ['orders', 'customers'])).toEqual(['customers'])
  expect(referencedTables('SELECT * FROM orders o JOIN customers c ON o.id = c.id', ['orders', 'customers']).sort()).toEqual(['customers', 'orders'])
})

test('views travel as a file: only names and SQL, checked on the way in, never clashing', () => {
  // What it last ran on (a closing balance) is the file's data: it stays in this browser.
  const tidy = view({ name: 'Tidy', sql: 'SELECT 1 FROM april', shapes: { april: ['a', 'b'] }, lastRunAt: 9, last: { table: 'april', rows: 4, closing: 7000 } })
  const file = exportViews([tidy])
  expect(JSON.parse(file)).toEqual({ format: 'sheetah-views', version: 1, views: [{ name: 'Tidy', sql: 'SELECT 1 FROM april', tables: ['april'], shapes: { april: ['a', 'b'] }, savedAt: 1 }] })
  const [back] = parseViews(file)
  expect(back).toMatchObject({ name: 'Tidy', sql: 'SELECT 1 FROM april', tables: ['april'], shapes: { april: ['a', 'b'] }, imported: true })
  expect(back.id).not.toBe('v')
  // The same view again is skipped; another view under a taken name gets a number.
  const other = { ...back, id: 'x', sql: 'SELECT 2 FROM april' }
  const merged = mergeViews([tidy], [back, other, { ...other, id: 'y' }])
  expect(merged.added.map((v) => v.name)).toEqual(['Tidy (2)'])
  expect(merged.skipped).toBe(2)
  expect(merged.views.map((v) => v.name)).toEqual(['Tidy (2)', 'Tidy'])
  // Not a views file, or one with nothing usable in it: a plain message, nothing imported.
  expect(() => parseViews('{"views": []}')).toThrow('isn’t a Sheetah views file')
  expect(() => parseViews('nope')).toThrow('isn’t JSON')
  expect(() => parseViews('{"format":"sheetah-views","views":[{"name":"x"},{"sql":"SELECT 1"}]}')).toThrow('no views')
  // Odd fields are dropped, not trusted; a file can't date its views in the future to put them first.
  const [odd] = parseViews('{"format":"sheetah-views","views":[{"name":" A\\u0007 ","sql":"SELECT 2","tables":[1],"shapes":{"t":[2]},"savedAt":99999999999999}]}')
  expect(odd).toMatchObject({ name: 'A', tables: [], shapes: undefined })
  expect(odd.savedAt).toBeLessThanOrEqual(Date.now())
})

test('a views file can’t reach inherited properties or claim tables its SQL doesn’t read', () => {
  const file = (v: object) => JSON.stringify({ format: 'sheetah-views', views: [{ name: 'x', sql: 'SELECT * FROM sales', ...v }] })
  // Table names that are also Object.prototype's: no shapes come out of them, and nothing throws later.
  for (const t of ['__defineGetter__', '__proto__', 'constructor', 'length']) {
    const [v] = parseViews(file({ tables: [t, 'sales'], shapes: t === 'length' ? [] : {} }))
    expect(v.tables).toEqual(['sales']) // only the tables the SQL reads
    expect(v.shapes).toBeUndefined()
    expect(viewsThatFit([v], { name: 'may', columns: cols('a', 'b') })).toEqual([])
  }
  const [poisoned] = parseViews('{"format":"sheetah-views","views":[{"name":"x","sql":"SELECT * FROM \\"__proto__\\"","tables":["__proto__"],"shapes":{"__proto__":["a","b"]}}]}')
  expect(poisoned.tables).toEqual(['__proto__'])
  expect(Object.getPrototypeOf(poisoned.shapes ?? {})).not.toBe(Array.prototype)
  expect(viewsThatFit([poisoned], { name: 'may', columns: cols('a', 'b') })).toHaveLength(poisoned.shapes ? 1 : 0)
  expect(tablesIn("SELECT sales.amount, 'from x' FROM sales s JOIN regions ON 1 = 1, (SELECT * FROM refunds)")).toEqual(['sales', 'regions', 'refunds'])
})

test('a view keeps the steps it was made of, only while they are exactly its SQL', async () => {
  const { stepsOf, remapSteps, tableBase } = await import('../../src/engine/views')
  const { compose, emptyOps } = await import('../../src/engine/compose')
  const ops = { ...emptyOps(), drop: [{ label: '1 total line', keep: 'NOT is_total_label(region)' }], clean: [{ column: 'amount', kind: 'number' as const }] }
  const sql = compose(tableBase('sales_april'), ops)
  const view = { id: 'v', name: 'Tidy', sql, tables: ['sales_april'], savedAt: 1, steps: { table: 'sales_april', ops } }
  expect(stepsOf(view)).toEqual(view.steps)
  // Steps that say more than the SQL (a views file someone edited) are ignored: the SQL runs as written.
  expect(stepsOf({ ...view, steps: { table: 'sales_april', ops: { ...ops, filters: [{ column: 'x', op: 'equals' as const, value: '1' }] } } })).toBeNull()
  expect(stepsOf({ ...view, sql: sql + '\nLIMIT 5' })).toBeNull()
  expect(stepsOf({ ...view, steps: { table: 'sales_april', ops: { filters: 'nope' } as never } })).toBeNull()
  // Next month: the table, and a look-up's table, follow the mapping.
  const withLookup = { table: 'sales_april', ops: { ...ops, lookups: [{ table: 'rates_april', here: 'k', there: 'k', bring: [], loose: true, types: { here: 'VARCHAR', there: 'VARCHAR' } }] } }
  const moved = remapSteps(withLookup, { sales_april: 'sales_may', RATES_APRIL: 'rates_may' })
  expect([moved.table, moved.ops.lookups![0].table]).toEqual(['sales_may', 'rates_may'])
  // They travel in a views file, and are checked on the way in.
  const [back] = parseViews(exportViews([view]))
  expect(back.steps).toEqual(view.steps)
  const [edited] = parseViews(exportViews([{ ...view, sql: 'SELECT 1' }]))
  expect(edited.steps).toBeUndefined()
})

test('steps and SQL are compared without comments, but quoted text exactly', async () => {
  const { withoutComments, stepsMake, remapSteps, remapTables, tableBase } = await import('../../src/engine/views')
  const { compose, emptyOps } = await import('../../src/engine/compose')
  expect(withoutComments(`SELECT 'a  -- b'  -- note\nFROM t /* x */ WHERE c = "x  y"`)).toBe(`SELECT 'a  -- b' FROM t WHERE c = "x  y"`)
  // Two spaces inside a value are a different value.
  expect(withoutComments("WHERE c = 'x  y'")).not.toBe(withoutComments("WHERE c = 'x y'"))
  // A view re-pointed to next month keeps a comment naming last month's table: its steps still count.
  const lookup = { table: 'rates_sep', here: 'code', there: 'code', bring: [{ column: 'rate', as: 'rate' }], loose: true, types: { here: 'VARCHAR', there: 'VARCHAR' } }
  const steps = { table: 'sales_sep', ops: { ...emptyOps(), lookups: [lookup] } }
  const sql = compose(tableBase('sales_sep'), steps.ops)
  const mapping = { sales_sep: 'sales_oct', rates_sep: 'rates_oct' }
  expect(stepsMake(remapSteps(steps, mapping), remapTables(sql, mapping))).toBe(true)
  // Steps that don't say what the re-pointed SQL says (a table named inside an added column) don't count.
  const inColumn = { table: 'sales_sep', ops: { ...emptyOps(), computed: [{ name: 'n', expr: '(SELECT count(*) FROM rates_sep)' }] } }
  const moved = remapTables(compose(tableBase('sales_sep'), inColumn.ops), mapping)
  expect(stepsMake(remapSteps(inColumn, mapping), moved)).toBe(false)
})

test('a views file’s category rules are kept only when they are exactly the column’s formula', async () => {
  const { categorizeExpr } = await import('../../src/engine/categorize')
  const { compose } = await import('../../src/engine/compose')
  const rules = { column: 'Narration', rules: [{ category: 'Food', words: ['swiggy'] }], otherwise: 'Other' }
  const steps = (categorize: unknown) => ({ table: 'april', ops: { filters: [], computed: [{ name: 'category', expr: categorizeExpr(rules), categorize }] } })
  const sql = compose('SELECT * FROM april', steps(rules).ops as never)
  const file = (categorize: unknown) => JSON.stringify({ format: 'sheetah-views', version: 1, views: [{ name: 'Tidy', sql, tables: ['april'], steps: steps(categorize) }] })
  expect(parseViews(file(rules))[0].steps?.ops.computed[0].categorize).toEqual(rules)
  // Rules that say something else than the formula, or aren't rules at all: the column stays, its rules go.
  for (const odd of [{ ...rules, otherwise: 'Misc' }, { rules: 'nope' }, 42]) {
    const [v] = parseViews(file(odd))
    expect(v.steps?.ops.computed[0]).toEqual({ name: 'category', expr: categorizeExpr(rules) })
  }
})

test('a view is named for its table without the month or year: it is for every month', () => {
  expect(viewNameFor('stmt_apr_2024')).toBe('stmt view')
  expect(viewNameFor('sales-2024-04')).toBe('sales view')
  expect(viewNameFor('HDFC_Statement_April24')).toBe('HDFC Statement view')
  expect(viewNameFor('fy24_ledger_q1_2024')).toBe('ledger view')
  expect(viewNameFor('market_share')).toBe('market share view')
  expect(viewNameFor('Statement')).toBe('Statement view')
  // Nothing but a date: the table's name, as it is.
  expect(viewNameFor('2024_04')).toBe('2024 04 view')
})
