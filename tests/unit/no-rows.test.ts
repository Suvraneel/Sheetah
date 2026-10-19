import { expect, test } from '@playwright/test'
import { noRowsReasons, probeReason, probes, probeSql } from '../../src/engine/no-rows'
import { q } from './duck'

/* Queries that run and find nothing because of a slip: each said, and the query as meant finds the rows. */
test.beforeAll(async () => {
  await q(`CREATE OR REPLACE TABLE nr AS SELECT * FROM (VALUES
    ('Pune', NULL, TIMESTAMP '2024-04-01 10:30', 'UPI*SWIGGY'),
    (' Goa', 'x@y.in', TIMESTAMP '2024-04-02 09:00', 'NEFT ACME')
  ) t(city, email, paid_at, note)`)
})
const cols = [
  { name: 'city', type: 'VARCHAR' },
  { name: 'email', type: 'VARCHAR' },
  { name: 'paid_at', type: 'TIMESTAMP' },
  { name: 'note', type: 'VARCHAR' },
]
const count = async (sql: string) => (await q(sql)).length

test('= NULL, LIKE with *, and a day compared with a date-and-time: said, and fixed', async () => {
  const nul = `SELECT * FROM nr WHERE email = NULL AND note <> 'x = NULL'`
  expect(await count(nul)).toBe(0)
  const [a] = noRowsReasons(nul, cols)
  expect(a.text).toContain('IS NULL')
  expect(a.fixed).toBe(`SELECT * FROM nr WHERE email IS NULL AND note <> 'x = NULL'`)
  expect(await count(a.fixed!)).toBe(1)

  const like = `SELECT * FROM nr WHERE note LIKE 'UPI*'`
  expect(await count(like)).toBe(0)
  const [b] = noRowsReasons(like, cols)
  expect(b.fixed).toBe(`SELECT * FROM nr WHERE note LIKE 'UPI%'`)
  expect(await count(b.fixed!)).toBe(1)

  const day = `SELECT * FROM nr WHERE paid_at = '2024-04-01'`
  expect(await count(day)).toBe(0)
  const [c] = noRowsReasons(day, cols)
  expect(c.text).toContain('only midnight')
  expect(await count(c.fixed!)).toBe(1)
  // Nothing to say about a query with none of these.
  expect(noRowsReasons(`SELECT * FROM nr WHERE city = 'Delhi'`, cols)).toEqual([])
})

test('text that differs only in capitals or spaces is looked up, and written the table’s way', async () => {
  for (const [sql, want] of [
    [`SELECT * FROM nr WHERE city = 'pune'`, "'Pune'"],
    [`SELECT * FROM nr WHERE city = 'Goa'`, 'spaces'],
    [`SELECT * FROM nr WHERE note LIKE 'upi%'`, 'ILIKE'],
  ] as const) {
    expect(await count(sql)).toBe(0)
    const [p] = probes(sql, cols)
    const found = (await q(probeSql('nr', p))).map((r) => ({ v: String(r.v), exact: r.exact === true }))
    const why = probeReason(sql, p, found)!
    expect(why.text).toContain(want)
    expect(await count(why.fixed!)).toBe(1)
  }
  // A value nothing like any row's: no reason made up.
  const sql = `SELECT * FROM nr WHERE city = 'Delhi'`
  const [p] = probes(sql, cols)
  const rows = async (sql: string) => (await q(probeSql('nr', probes(sql, cols)[0]))).map((r) => ({ v: String(r.v), exact: r.exact === true }))
  expect(probeReason(sql, p, await rows(sql))).toBeNull()
  // The value is there as typed: something else found no rows, not the capitals.
  const there = `SELECT * FROM nr WHERE city = 'Pune' AND note = 'nothing'`
  expect(await count(there)).toBe(0)
  expect(probeReason(there, probes(there, cols)[0], await rows(there))).toBeNull()
  const like = `SELECT * FROM nr WHERE note LIKE 'UPI%' AND paid_at > now()`
  expect(await count(like)).toBe(0)
  expect(probeReason(like, probes(like, cols)[0], await rows(like))).toBeNull()
  // == NULL and <> NULL are put right; >= NULL isn't a test for empty and is left alone.
  expect(noRowsReasons(`SELECT * FROM nr WHERE email == NULL OR city <> NULL OR note >= NULL`, cols)[0].fixed).toBe(
    `SELECT * FROM nr WHERE email IS NULL OR city IS NOT NULL OR note >= NULL`,
  )
})

test('names after an alias, and = \'\' where the empty cells are NULL', async () => {
  const sql = `SELECT * FROM nr o WHERE o.paid_at = '2024-04-01'`
  expect(await count(sql)).toBe(0)
  const [why] = noRowsReasons(sql, cols)
  expect(why.fixed).toBe(`SELECT * FROM nr o WHERE o.paid_at::DATE = '2024-04-01'`)
  expect(await count(why.fixed!)).toBe(1)
  const city = `SELECT * FROM nr AS o WHERE o.city = 'pune'`
  const [p] = probes(city, cols)
  expect(p).toMatchObject({ column: 'city', value: 'pune' })
  const empty = `SELECT * FROM nr WHERE email = ''`
  expect(await count(empty)).toBe(0)
  const [e] = noRowsReasons(empty, cols)
  expect(e.fixed).toBe(`SELECT * FROM nr WHERE (email IS NULL OR email = '')`)
  expect(await count(e.fixed!)).toBe(1)
  // <> NULL is put right as IS NOT NULL, and the button says so.
  expect(noRowsReasons(`SELECT * FROM nr WHERE email <> NULL`, cols)[0].label).toBe('Use IS NOT NULL')
})
