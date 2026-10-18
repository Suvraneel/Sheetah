import { expect, test } from '@playwright/test'
import { quoteIdent, quoteLiteral, splitStatements, sqlName, tableNameFor } from '../../src/engine/sql'

test.describe('sql helpers', () => {
  test('quoting', () => {
    expect(quoteIdent('Unit "Price"')).toBe('"Unit ""Price"""')
    expect(quoteLiteral("it's")).toBe("'it''s'")
    expect(sqlName('city')).toBe('city')
    expect(sqlName('Unit Price')).toBe('"Unit Price"')
    expect(sqlName('order')).toBe('"order"') // reserved word
    expect(sqlName('Sales')).toBe('"Sales"')
  })

  test('statements split only on top-level semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitStatements("SELECT 'a;b'; SELECT \"x;y\" FROM t")).toEqual(["SELECT 'a;b'", 'SELECT "x;y" FROM t'])
    expect(splitStatements("SELECT 'it''s; fine'")).toEqual(["SELECT 'it''s; fine'"])
    expect(splitStatements('SELECT $$a;b$$; SELECT $t$c;d$t$')).toEqual(['SELECT $$a;b$$', 'SELECT $t$c;d$t$'])
    expect(splitStatements("SELECT E'it\\'s; ok'; SELECT 2")).toEqual(["SELECT E'it\\'s; ok'", 'SELECT 2'])
    expect(splitStatements('SELECT 1 -- a; comment\n; /* b; */ SELECT 2')).toEqual(['SELECT 1 -- a; comment', '/* b; */ SELECT 2'])
    expect(splitStatements('-- only a comment;\n;  ')).toEqual([])
  })

  test('table names from file names', () => {
    const none = new Set<string>()
    expect(tableNameFor('Sales Report (2024).csv.gz', none)).toBe('sales_report_2024')
    expect(tableNameFor('2024.csv', none)).toBe('t_2024')
    expect(tableNameFor('客户.csv', none)).toBe('data')
    expect(tableNameFor('order.csv', none)).toBe('order_data')
    expect(tableNameFor('sales.csv', new Set(['Sales']))).toBe('sales_2')
    expect(tableNameFor('sales.csv', new Set(['sales', 'sales_2']))).toBe('sales_3')
  })
})

test('every DuckDB reserved or type-function keyword is quoted', () => {
  for (const w of ['left', 'right', 'outer', 'at', 'by', 'full', 'join', 'like', 'similar', 'map', 'struct', 'columns']) {
    expect(sqlName(w), w).toBe(`"${w}"`)
  }
  expect(tableNameFor('left.csv', new Set())).toBe('left_data')
})

test.describe('errors in plain words', () => {
  test('the common DuckDB errors are explained, with the original kept as details', async () => {
    const { explainError } = await import('../../src/engine/errors')
    const sum = explainError(`Binder Error: No function matches the given name and argument types 'sum(VARCHAR)'. You might need to add explicit type casts.\n\tCandidate functions:\n\tsum(DECIMAL) -> DECIMAL`)
    expect(sum.text).toContain('Convert to number')
    expect(sum.detail).toContain('Candidate functions')
    expect(explainError(`Binder Error: Referenced column "totl" not found in FROM clause!\nCandidate bindings: "total", "title"`).text).toBe('There’s no column called “totl”. Did you mean “total”?')
    expect(explainError(`Conversion Error: Could not convert string 'abc' to INT32`).text).toBe('“abc” can’t be read as a number.')
    expect(explainError('Parser Error: syntax error at or near "orders"\n\nLINE 1: SELECT * FROMM orders\n                       ^').text).toBe(
      'SQL couldn’t be read at “orders”. Look just before it: a misspelt word, a missing comma, or a bracket left open.',
    )
    expect(explainError('Invalid Input Error: something new').text).toBe('something new')
  })

  test('the common mistakes come with a one-click fix that touches only what was wrong', async () => {
    const { applyFix, explainError } = await import('../../src/engine/errors')
    const at = (sql: string) => `\n\nLINE 1: ${sql}\n        ^`
    const sql = `SELECT * FROM orders WHERE city IN ("Pune", "Goa", "status") AND note = '"Pune"' -- "Pune"`
    const q = explainError(`Binder Error: Referenced column "Pune" not found in FROM clause!\nCandidate bindings: "city"${at(sql)}`, { columns: ['city', 'status'] })
    expect(q.fix).toEqual({ label: 'Use single quotes', kind: 'quote', values: ['Pune', 'Goa'] })
    // Only the values: a real column in the list, text and comments stay as written.
    expect(applyFix(sql, q.fix!)).toBe(`SELECT * FROM orders WHERE city IN ('Pune', 'Goa', "status") AND note = '"Pune"' -- "Pune"`)
    const typo = explainError(`Binder Error: Referenced column "totl" not found in FROM clause!\nCandidate bindings: "orders.total"${at('SELECT totl FROM orders')}`)
    expect(typo.fix).toEqual({ label: 'Use total', kind: 'rename', from: 'totl', to: 'total' })
    expect(applyFix(`SELECT totl, o.totl, "totl", 'totl', subtotl FROM orders o ORDER BY TOTL`, typo.fix!)).toBe(
      `SELECT total, o.total, total, 'totl', subtotl FROM orders o ORDER BY total`,
    )
    const table = explainError('Catalog Error: Table with name ordrs does not exist!\nDid you mean "orders"?', { tables: ['orders'] })
    expect(applyFix('SELECT * FROM ordrs', table.fix!)).toBe('SELECT * FROM orders')
    // A name that needs quotes gets them.
    expect(applyFix('SELECT gst FROM t', { label: '', kind: 'rename', from: 'gst', to: 'GST %' })).toBe('SELECT "GST %" FROM t')
    // No fix where there's no safe one.
    expect(explainError(`Binder Error: Referenced column "Pune" not found in FROM clause!\nCandidate bindings: "city"${at('SELECT "Pune" FROM t')}`).fix).toBeUndefined()
  })

  test('dates written day/month and column names with spaces get a fix too', async () => {
    const { applyFix, explainError } = await import('../../src/engine/errors')
    const at = (sql: string) => `\n\nLINE 1: ${sql}\n        ^`
    const typed = "SELECT * FROM t WHERE d BETWEEN '01-04-2024' AND '30-04-2024' AND note = 'x'"
    const msg = (v: string, sql = typed) => `Conversion Error: invalid date field format: "${v}", expected format is (YYYY-MM-DD)${at(sql)}`
    const d = explainError(msg('01-04-2024'))
    expect(d.text).toBe("Dates in SQL are written year-month-day: '2024-04-01' is 1 April 2024.")
    // Month first where the reader writes it so, unless a part over 12 settles it.
    expect(explainError(msg('01-04-2024'), { monthFirst: true }).fix).toMatchObject({ label: "Use '2024-01-04'" })
    expect(explainError(msg('30-04-2024'), { monthFirst: true }).fix).toMatchObject({ order: 'dmy' })
    expect(applyFix(typed, d.fix!)).toBe("SELECT * FROM t WHERE d BETWEEN '2024-04-01' AND '2024-04-30' AND note = 'x'")
    // A value in the data (CAST(col AS DATE)), not one typed: no fix, and it says so.
    const data = explainError(msg('15/08/2024', 'SELECT CAST(paid AS DATE) FROM t'))
    expect(data.fix).toBeUndefined()
    expect(data.text).toContain('in the data')
    const s = explainError(`Parser Error: syntax error at or near "Value"${at('SELECT sum(Taxable Value) FROM t')}`, { columns: ['Taxable Value', 'qty'] })
    expect(s.text).toBe('Column names with spaces go in double quotes: "Taxable Value".')
    expect(applyFix('SELECT sum(Taxable Value), "Taxable Value" FROM t', s.fix!)).toBe('SELECT sum("Taxable Value"), "Taxable Value" FROM t')
    const b = explainError(`Binder Error: Referenced column "Invoice" not found in FROM clause!${at('SELECT Invoice Total FROM t')}`, { columns: ['Invoice Total'] })
    expect(b.fix).toMatchObject({ kind: 'rename', from: 'Invoice Total', to: 'Invoice Total' })
  })

  test('the mistakes spreadsheet people make first are explained in their terms', async () => {
    const { explainError, sumExample } = await import('../../src/engine/errors')
    const at = (sql: string) => `\n\nLINE 1: ${sql}\n        ^`
    // Text in double quotes reads as a column.
    expect(explainError(`Binder Error: Referenced column "Pune" not found in FROM clause!\nCandidate bindings: "city"${at('SELECT * FROM orders WHERE city = "Pune"')}`).text).toBe(
      '“Pune” is in double quotes, which SQL reads as a column’s name. Put text in single quotes: \'Pune\'.',
    )
    expect(explainError(`Binder Error: Referenced column "Goa" not found in FROM clause!\nCandidate bindings: "city"${at('SELECT * FROM orders WHERE city IN (\'Pune\', "Goa")')}`).text).toContain('single quotes: \'Goa\'')
    // A misspelt column in the select list is still a misspelt column.
    expect(explainError(`Binder Error: Referenced column "totl" not found in FROM clause!\nCandidate bindings: "total"${at('SELECT city, "totl" FROM orders')}`).text).toContain('Did you mean “total”?')
    // A missing table: the user's own tables, never DuckDB's catalog.
    const tables = ['orders', 'customers']
    expect(explainError('Catalog Error: Table with name ordrs does not exist!\nDid you mean "orders"?', { tables }).text).toBe('There’s no table called “ordrs”. Did you mean “orders”?')
    expect(explainError('Catalog Error: Table with name xyzzy does not exist!\nDid you mean "pg_type"?', { tables }).text).toBe('There’s no table called “xyzzy”. Your tables: orders, customers.')
    expect(explainError('Catalog Error: Table with name sales does not exist!\nDid you mean "sqlite_master"?').text).toContain('Open a file first')
    expect(explainError('Catalog Error: Scalar Function with name vlookup does not exist!\nDid you mean "lower"?').text).toContain('Lookup')
    expect(explainError('Catalog Error: Scalar Function with name lowr does not exist!\nDid you mean "lower"?').text).toBe('There’s no function called lowr(). Did you mean lower()?')
    expect(explainError('Binder Error: column "total" must appear in the GROUP BY clause or must be part of an aggregate function.').text).toContain('GROUP BY')
    expect(explainError('Binder Error: Ambiguous reference to column name "id" (use: "orders.id" or "customers.id")').text).toBe(
      'More than one table has a column called “id”. Say which: orders.id or customers.id.',
    )
    expect(explainError('Binder Error: WHERE clause cannot contain aggregates!').text).toContain('HAVING')
    expect(explainError('Parser Error: syntax error at end of input').text).toContain('ends too soon')
    expect(explainError(`Parser Error: unterminated quoted string at or near "'Pune"`).text).toContain('isn’t closed')
    expect(explainError(`Parser Error: syntax error at or near "="${at('=SUM(A1:A3)')}`).text).toContain('spreadsheet formula')
    // The example is on the reader's own table: a number column, the amount if there is one.
    const sum = sumExample({ name: 'sales apr', columns: [{ name: 'City', type: 'VARCHAR' }, { name: 'Qty', type: 'BIGINT' }, { name: 'Net Amount', type: 'DOUBLE' }] })
    expect(explainError(`Parser Error: syntax error at or near "="${at('=SUM(C2:C9)')}`, { sum }).text).toBe(
      'That’s a spreadsheet formula. Sheetah speaks SQL: SELECT sum("Net Amount") FROM "sales apr" adds up a column.',
    )
    expect(explainError(`Parser Error: syntax error at or near "ORDER"${at('SELECT * FROM orders LIMIT 5 ORDER BY id')}`).text).toContain('wrong place')
    // …unless it's a column of theirs called Order: that needs double quotes.
    expect(explainError(`Parser Error: syntax error at or near "Order"${at("SELECT * FROM t WHERE Order = 'a'")}`, { columns: ['Order', 'Qty'] }).text).toBe(
      'Order is a SQL word, so as a column’s name it goes in double quotes: "Order".',
    )
    // A near miss of a real column after an operator is a typo, not text.
    expect(explainError(`Binder Error: Referenced column "discont" not found in FROM clause!\nCandidate bindings: "discount"${at('SELECT * FROM t WHERE amount > "discont"')}`).text).toContain(
      'Did you mean “discount”?',
    )
    // DuckDB's own countif takes a condition; text() lives in an extension; names every JS object has are no hint.
    expect(explainError("Binder Error: No function matches the given name and argument types 'countif(VARCHAR, VARCHAR)'. You might need to add explicit type casts.").text).toContain(
      "countif(city = 'Pune')",
    )
    expect(explainError('Catalog Error: Scalar Function with name "text" is not in the catalog, but it exists in the excel extension.').text).toContain('strftime')
    expect(explainError('Catalog Error: Scalar Function with name constructor does not exist!\nDid you mean "concat"?').text).toBe(
      'There’s no function called constructor(). Did you mean concat()?',
    )
  })
})

test('a missing comma between two column names is found, and put back', async () => {
  const { missingCommas } = await import('../../src/engine/errors')
  const cols = ['Region', 'City', 'amount']
  expect(missingCommas('SELECT Region City, sum(amount) FROM t GROUP BY ALL', cols)).toEqual([{ first: 'Region', second: 'City', fixed: 'SELECT Region, City, sum(amount) FROM t GROUP BY ALL' }])
  // A real alias (a new name), AS, an expression, or a comma inside brackets: left alone.
  expect(missingCommas('SELECT Region area, City AS town, round(amount, 2) total FROM t', cols)).toEqual([])
  expect(missingCommas('SELECT * FROM t', cols)).toEqual([])
})
