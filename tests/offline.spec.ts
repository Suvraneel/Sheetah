import { expect, test } from '@playwright/test'
import { openApp, runSql } from './helpers'

test('after one visit, Quarry opens and runs queries with no network', async ({ page, context }) => {
  await openApp(page)
  // Wait until the service worker has precached the app, engine included.
  await expect(page.locator('.engine-pill')).toContainText('works offline', { timeout: 90_000 })

  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.engine-pill.is-ready')).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: /Try 1,000,000 sample rows/ }).click()
  await expect(page.locator('.result-meta')).toContainText('1,000,000 rows', { timeout: 60_000 })
  await runSql(page, 'SELECT status, count(*) AS n FROM orders GROUP BY 1')
  await expect(page.locator('.result-meta')).toContainText('5 rows')
  await context.setOffline(false)
})
