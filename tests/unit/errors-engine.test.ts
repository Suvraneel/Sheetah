import { expect, test } from '@playwright/test'
import { applyFix, explainError, type ErrorContext } from '../../src/engine/errors'
import { q } from './duck'

/*
 * Spreadsheet habits typed as SQL, run for real: DuckDB's error is explained in plain words, and the
 * one-click fix, applied to the query, runs and gives the rows meant.
 */
test.beforeAll(async () => {
  await q(`CREATE OR REPLACE TABLE sh AS SELECT * FROM (VALUES
    ('Pune', 'MH', DATE '2024-04-01', 1500.0),
    ('Goa', 'GA', DATE '2024-04-15', 900.0),
    ('Delhi', 'DL', DATE '2024-05-02', 120.0)
  ) t(city, state, d, amount)`)
})

const ctx: ErrorContext = { columns: ['city', 'state', 'd', 'amount'], tables: ['sh'], table: 'sh' }
/** The query's error explained (with the query at hand), and the rows its fix gives. */
async function tryIt(sql: string, more: ErrorContext = {}) {
  const err = await q(sql).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
  expect(err, `${sql} should fail`).not.toBeNull()
  const e = explainError(err!, { ...ctx, sql, ...more })
  const fixed = e.fix ? applyFix(sql, e.fix) : null
  return { text: e.text, fix: e.fix, fixed, rows: fixed ? await q(fixed) : null }
}

test('& joins text in a spreadsheet: || in SQL, with double-quoted text made text too', async () => {
  const a = await tryIt(`SELECT city & ' - ' & state AS place FROM sh ORDER BY d`)
  expect(a.text).toContain('||')
  expect(a.rows?.[0]).toEqual({ place: 'Pune - MH' })
  const b = await tryIt(`SELECT city & " - " & state AS place FROM sh ORDER BY d`)
  expect(b.text).toContain('single quotes')
  expect(b.fixed).toBe(`SELECT city || ' - ' || state AS place FROM sh ORDER BY d`)
  expect(b.rows?.[0]).toEqual({ place: 'Pune - MH' })
})

test('"" is empty text, "100" a number, upper("pune") text', async () => {
  const a = await tryIt(`SELECT count(*) AS n FROM sh WHERE city <> ""`)
  expect(a.text).toContain("''")
  expect(a.rows).toEqual([{ n: 3 }])
  const b = await tryIt(`SELECT city FROM sh WHERE amount > "1000"`)
  expect(b.text).toContain('needs no quotes')
  expect(b.fixed).toBe(`SELECT city FROM sh WHERE amount > 1000`)
  expect(b.rows).toEqual([{ city: 'Pune' }])
  const c = await tryIt(`SELECT city FROM sh WHERE city = upper("goa") OR lower(city) = lower("GOA")`)
  expect(c.rows).toEqual([{ city: 'Goa' }])
})

test('a bare word where a value goes is text that lost its quotes, not a column to guess at', async () => {
  const a = await tryIt(`SELECT state FROM sh WHERE city = Pune`)
  // Not "Did you mean city?": Pune is nothing like it.
  expect(a.text).not.toContain('Did you mean')
  expect(a.text).toContain("'Pune'")
  expect(a.rows).toEqual([{ state: 'MH' }])
  const b = await tryIt(`SELECT state FROM sh WHERE city IN (Pune, Goa) ORDER BY state`)
  expect(b.fixed).toBe(`SELECT state FROM sh WHERE city IN ('Pune', 'Goa') ORDER BY state`)
  expect(b.rows).toEqual([{ state: 'GA' }, { state: 'MH' }])
})

test('dates typed without quotes are a sum or a division: quoted, and written year-month-day', async () => {
  const a = await tryIt(`SELECT city FROM sh WHERE d > 2024-04-10 ORDER BY d`)
  expect(a.text).toContain('a subtraction')
  expect(a.rows).toEqual([{ city: 'Goa' }, { city: 'Delhi' }])
  const b = await tryIt(`SELECT city FROM sh WHERE d BETWEEN 01/04/2024 AND 30/04/2024 ORDER BY d`)
  expect(b.fixed).toBe(`SELECT city FROM sh WHERE d BETWEEN '2024-04-01' AND '2024-04-30' ORDER BY d`)
  expect(b.rows).toEqual([{ city: 'Pune' }, { city: 'Goa' }])
  // Month first for a reader who writes it so.
  const c = await tryIt(`SELECT city FROM sh WHERE d = 04/15/2024`, { monthFirst: true })
  expect(c.rows).toEqual([{ city: 'Goa' }])
})

test('TOP 10, a LIMIT before WHERE, 1,000 and && are put the way SQL writes them', async () => {
  const a = await tryIt(`SELECT TOP 2 city FROM sh ORDER BY amount DESC`)
  expect(a.text).toContain('LIMIT 2')
  expect(a.rows).toEqual([{ city: 'Pune' }, { city: 'Goa' }])
  const b = await tryIt(`SELECT city FROM sh LIMIT 1 ORDER BY amount`)
  expect(b.rows).toEqual([{ city: 'Delhi' }])
  const c = await tryIt(`SELECT city FROM sh WHERE amount > 1,000`)
  expect(c.text).toContain('1000')
  expect(c.rows).toEqual([{ city: 'Pune' }])
  const d = await tryIt(`SELECT city FROM sh WHERE state = 'MH' && amount > 100`)
  expect(d.rows).toEqual([{ city: 'Pune' }])
})

test('GROUP BY a name in single quotes groups by that text: the column, without them', async () => {
  const a = await tryIt(`SELECT city, sum(amount) AS total\nFROM sh\nGROUP BY 'city'\nORDER BY total`)
  expect(a.text).toContain("GROUP BY 'city' groups by the text")
  expect(a.rows?.map((r) => r.city)).toEqual(['Delhi', 'Goa', 'Pune'])
})

test('Sheetah’s own functions say how they’re written; =AVERAGE(amount) becomes its SQL', async () => {
  const a = await tryIt(`SELECT number_from_text(city, 2) FROM sh`)
  expect(a.text).toContain('number_from_text(amount)')
  const b = await tryIt(`SELECT date_from_text(city) FROM sh`)
  expect(b.text).toContain("date_from_text(day, '%d/%m/%Y')")
  const c = await tryIt(`=AVERAGE(amount)`)
  expect(c.text).toBe('That’s a spreadsheet formula. Sheetah speaks SQL: SELECT avg(amount) FROM sh does the same.')
  // DATEVALUE as the reader writes dates.
  expect(explainError('Catalog Error: Scalar Function with name datevalue does not exist!', { monthFirst: true }).text).toContain('%m/%d/%Y')
  expect(explainError('Catalog Error: Scalar Function with name datevalue does not exist!').text).toContain('%d/%m/%Y')
})

test('GROUP BY or ORDER BY a name in single quotes runs, but by the text: found, and the name put back', async () => {
  const { quotedNames } = await import('../../src/engine/errors')
  const sql = `SELECT city, count(*) AS n FROM sh GROUP BY 'city' ORDER BY n DESC`
  // It runs: one group, every row in it.
  expect(await q(`SELECT 'city' AS g, count(*) AS n FROM sh GROUP BY 'city'`)).toEqual([{ g: 'city', n: 3 }])
  const found = quotedNames(sql, ['city', 'state', 'n'])!
  expect(found).toMatchObject({ literal: 'city', column: 'city', clause: 'GROUP BY' })
  expect(found.fixed).toBe(`SELECT city, count(*) AS n FROM sh GROUP BY city ORDER BY n DESC`)
  expect((await q(found.fixed)).length).toBe(3)
  // Text that isn't a column's name, and names in text elsewhere, are left alone.
  expect(quotedNames(`SELECT * FROM sh WHERE city = 'city' ORDER BY amount`, ['city'])).toBeNull()
  expect(quotedNames(`SELECT 'x' AS city, count(*) FROM sh GROUP BY 'x'`, ['city'])).toBeNull()
})

test('ORDER BY a name in single quotes is an error in DuckDB: said, and the name put back', async () => {
  const a = await tryIt(`SELECT city, amount FROM sh ORDER BY 'amount' DESC`)
  expect(a.text).toContain("ORDER BY 'amount' sorts by the text")
  expect(a.rows?.map((r) => r.city)).toEqual(['Pune', 'Goa', 'Delhi'])
})

test('the fixes touch only the slip: not text, comments, IN lists, codes or other operators', async () => {
  // TOP inside text and LIMIT in a comment are left; the real ones are moved, before a closing ; and comment.
  const a = await tryIt(`SELECT TOP 2 city, 'Top 2 cities' AS note FROM sh ORDER BY amount DESC; -- LIMIT 1 for now`)
  expect(a.fixed).toBe(`SELECT city, 'Top 2 cities' AS note FROM sh ORDER BY amount DESC\nLIMIT 2; -- LIMIT 1 for now`)
  expect(a.rows?.map((r) => r.city)).toEqual(['Pune', 'Goa'])
  const b = await tryIt(`SELECT city FROM sh -- LIMIT 9 WHERE nothing\nLIMIT 1 ORDER BY amount`)
  expect(b.fixed).toBe(`SELECT city FROM sh -- LIMIT 9 WHERE nothing\nORDER BY amount\nLIMIT 1`)
  expect(b.rows).toEqual([{ city: 'Delhi' }])
  // 101,102 in an IN list is two numbers.
  const c = await tryIt(`SELECT city FROM sh WHERE amount > 1,000 AND amount NOT IN (101,102)`)
  expect(c.fixed).toBe(`SELECT city FROM sh WHERE amount > 1000 AND amount NOT IN (101,102)`)
  // A code in double quotes stays text: its leading zero matters.
  const d = await tryIt(`SELECT count(*) AS n FROM sh WHERE state = "0110"`)
  expect(d.fixed).toBe(`SELECT count(*) AS n FROM sh WHERE state = '0110'`)
  // && between lists is DuckDB's overlap operator: & alone is the slip.
  const e = explainError(`Binder Error: No function matches the given name and argument types '&(VARCHAR, STRING_LITERAL)'.`, { sql: `SELECT city & ' x' FROM sh WHERE [1] && [1]` })
  expect(applyFix(`SELECT city & ' x' FROM sh WHERE [1] && [1]`, e.fix!)).toBe(`SELECT city || ' x' FROM sh WHERE [1] && [1]`)
  // A label in another query of a UNION isn't a GROUP BY slip.
  const { quotedNames } = await import('../../src/engine/errors')
  expect(quotedNames(`SELECT state, sum(amount) AS amount FROM sh GROUP BY state UNION ALL SELECT 'amount', sum(amount) FROM sh`, ['state', 'amount'])).toBeNull()
})

test('a learner’s near-misses: dates settled by the whole query, columns not taken for text, TOP where it is', async () => {
  // A financial year typed day first, with no LINE in DuckDB's message: from the query, both dates at once.
  const fy = await tryIt(`SELECT count(*) AS n FROM sh WHERE d >= '01/04/2024' AND d <= '31/03/2025'`, { monthFirst: true })
  expect(fy.text).not.toContain('in the data')
  expect(fy.fixed).toBe(`SELECT count(*) AS n FROM sh WHERE d >= '2024-04-01' AND d <= '2025-03-31'`)
  expect(fy.rows).toEqual([{ n: 3 }])
  // > against a name that isn't a column: no fix that turns it into text.
  const gt = await tryIt(`SELECT * FROM sh WHERE amount > price`)
  expect(gt.fix).toBeUndefined()
  expect(gt.text).not.toContain("'price'")
  // An amount with its currency sign.
  const money = await tryIt(`SELECT city FROM sh WHERE amount > ₹1000`)
  expect(money.fixed).toBe(`SELECT city FROM sh WHERE amount > 1000`)
  expect(money.rows).toEqual([{ city: 'Pune' }])
  // TOP inside a WITH: said, not moved to the outer query (which would count every row).
  const cte = await tryIt(`WITH t AS (SELECT TOP 2 city FROM sh ORDER BY amount DESC) SELECT count(*) FROM t`)
  expect(cte.fix).toBeUndefined()
  expect(cte.text).toContain('the SELECT it’s in')
  const pct = await tryIt(`SELECT TOP 5 PERCENT * FROM sh`)
  expect(pct.fix).toBeUndefined()
  // India's grouping, LIMIT 1,000, a date the calendar doesn't have, FROM a SQL word.
  const lakh = await tryIt(`SELECT count(*) AS n FROM sh WHERE amount < 10,00,000`)
  expect(lakh.fixed).toBe(`SELECT count(*) AS n FROM sh WHERE amount < 1000000`)
  const lim = await tryIt(`SELECT city FROM sh ORDER BY amount LIMIT 1,000`)
  expect(lim.fixed).toBe(`SELECT city FROM sh ORDER BY amount LIMIT 1000`)
  expect((await tryIt(`SELECT * FROM sh WHERE d = '2024-04-31'`)).text).toContain('isn’t a day on the calendar')
  const word = explainError('Parser Error: syntax error at or near "order"\n\nLINE 1: SELECT * FROM order\n                    ^', { tables: ['orders'], sql: 'SELECT * FROM order' })
  expect(applyFix('SELECT * FROM order', word.fix!)).toBe('SELECT * FROM orders')
  expect(explainError('Parser Error: syntax error at or near "FROM"', { sql: 'SELECT * WHERE id = 1 FROM orders' }).text).toContain('FROM is in the wrong place')
})

test('names in single quotes: only whole items, every one at once, named by their clause', async () => {
  const { quotedNames } = await import('../../src/engine/errors')
  // 'total' inside a CASE is a value, not the column.
  expect(quotedNames(`SELECT * FROM sh ORDER BY CASE WHEN state = 'amount' THEN 0 ELSE 1 END`, ['state', 'amount'])).toBeNull()
  const both = await tryIt(`SELECT city, sum(amount) AS amount FROM sh GROUP BY 'city' ORDER BY 'amount' DESC`)
  expect(both.text).toContain("GROUP BY 'city'")
  expect(both.fixed).toBe(`SELECT city, sum(amount) AS amount FROM sh GROUP BY city ORDER BY amount DESC`)
  expect(both.rows?.map((r) => r.city)).toEqual(['Pune', 'Goa', 'Delhi'])
  const order = await tryIt(`SELECT city FROM sh ORDER BY 'amount' DESC`)
  expect(order.text).toMatch(/^ORDER BY 'amount' sorts/)
})

test('FROM order means orders (not order_items); a bracket left open isn’t FROM out of place; LIMIT 100,200 isn’t guessed', async () => {
  const word = explainError('Parser Error: syntax error at or near "order"', { tables: ['order_items', 'orders'], sql: 'SELECT * FROM order' })
  expect(applyFix('SELECT * FROM order', word.fix!)).toBe('SELECT * FROM orders')
  expect((await tryIt(`SELECT sum(amount FROM sh`)).text).toContain('bracket is left open')
  expect((await tryIt(`SELECT CASE WHEN amount > 1 THEN 'a' FROM sh`)).text).toContain('CASE is left open')
  expect((await tryIt(`SELECT * FROM WHERE amount > 1`)).text).toContain('A table’s name goes after FROM')
  const pair = await tryIt(`SELECT city FROM sh LIMIT 100,200`)
  expect(pair.fix).toBeUndefined()
  expect(pair.text).toContain('LIMIT 200 OFFSET 100')
})
