import { expect, test } from './fixtures'
import { openApp, openDemo, recordEgress, runSql } from './helpers'

const SQL = "SELECT city, round(sum(total)) AS revenue FROM orders WHERE status = 'delivered' GROUP BY city ORDER BY revenue DESC"

test('a shared link carries only the SQL and never auto-runs', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openDemo(page)
  await runSql(page, SQL)
  await expect(page.locator('.result-meta')).toContainText('14 rows')
  await page.getByRole('button', { name: 'Share' }).click()
  await expect(page.locator('.toast', { hasText: 'never your data' })).toBeVisible()
  const link = await page.evaluate(() => navigator.clipboard.readText())
  expect(link).toMatch(/#q=z[A-Za-z0-9_-]+$/)
  expect(link).not.toContain('delivered') // compressed, and nothing readable lands in server logs (fragment)

  // Open the link in a fresh page
  const other = await context.newPage()
  const egress = recordEgress(other)
  const served: string[] = []
  other.on('request', (r) => served.push(r.url()))
  await openApp(other, link.replace(/^https?:\/\/[^/]+/, ''))
  await expect(other.locator('.shared-banner')).toContainText('A shared query is waiting')
  expect(other.url()).not.toContain('#q=') // stripped from the address bar
  expect(served.some((u) => u.includes('q='))).toBe(false) // the fragment never reaches the server

  await other.getByRole('button', { name: /Try 1,000,000 sample rows/ }).click()
  await expect(other.getByRole('dialog', { name: 'Someone shared a query' })).toBeVisible()
  await expect(other.locator('.sql-preview')).toContainText("status = 'delivered'")
  await other.getByRole('button', { name: 'Put it in the editor' }).click()
  await expect(other.locator('.cm-content')).toContainText("status = 'delivered'")
  await expect(other.locator('.result-meta')).toContainText('1,000,000 rows') // not run yet
  expect(egress).toEqual([])
})

test('a damaged link shows a clear message', async ({ page }) => {
  await openApp(page, '/#q=zNOTVALIDDATA')
  await expect(page.locator('.toast-error')).toContainText('damaged')
})
