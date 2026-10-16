import { expect, test, type Page } from '@playwright/test'
import { openDemo, runSql } from './helpers'

/** Switches to the chart view and returns its caption once it has finished computing. */
async function chartCaption(page: Page) {
  await page.getByRole('button', { name: 'Chart', exact: true }).click()
  await expect(page.locator('.chart-panel:not(.is-loading) .chart svg')).toBeVisible()
  return page.locator('.chart-figure figcaption').innerText()
}

test.describe('time data and odd queries', () => {
  test('TIMESTAMPTZ columns show as dates, chart in UTC, pivot and profile', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'CREATE OR REPLACE TABLE tz AS SELECT to_timestamp(1704067200 + i * 3600) AS t, i AS v FROM range(2000) r(i)')
    await runSql(page, 'SELECT * FROM tz')
    await expect(page.locator('.result-meta')).toContainText('2,000 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-01-01 00:00:00')

    expect(await chartCaption(page)).toMatch(/by day \(UTC\)/)
    await expect(page.locator('.chart-panel')).not.toContainText('Couldn’t')

    await page.getByRole('button', { name: 'Grid', exact: true }).click()
    await page.getByRole('button', { name: 'Pivot', exact: true }).click()
    await page.getByRole('button', { name: 'Create pivot' }).click()
    await expect(page.locator('.result-meta')).toContainText('4 rows') // Jan–Mar 2024 by month, plus the grand total
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })

  test('quarterly and yearly series keep their grain', async ({ page }) => {
    await openDemo(page)
    await runSql(page, "SELECT date_trunc('quarter', ordered_at) AS q, round(sum(total)) AS revenue FROM orders GROUP BY q ORDER BY q")
    await expect(page.locator('.result-meta')).toContainText('8 rows')
    expect(await chartCaption(page)).toMatch(/by quarter[\s\S]*8 quarters/)

    await page.getByRole('button', { name: 'Grid', exact: true }).click()
    await runSql(page, 'SELECT make_date(2000 + i, 1, 1) AS y, i * 10 AS v FROM range(25) r(i)')
    await expect(page.locator('.result-meta')).toContainText('25 rows')
    expect(await chartCaption(page)).toMatch(/by year/)
  })

  test('a query ending in a line comment is still a full result', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'SELECT city, count(*) AS n FROM orders GROUP BY city -- busiest cities')
    await expect(page.locator('.result-meta')).toContainText('14 rows')
    expect(await chartCaption(page)).toMatch(/by city/)
  })

  test('the distinct estimate never exceeds the row count', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'SELECT to_timestamp(1704067200 + i * 3600) AS t FROM range(2000) r(i)')
    await expect(page.locator('.result-meta')).toContainText('2,000 rows')
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Alt+ArrowDown')
    const distinct = page.locator('.facts div', { hasText: /distinct/i }).locator('dd')
    await expect(distinct).not.toHaveText('')
    expect(Number((await distinct.innerText()).replace(/[^0-9]/g, ''))).toBeLessThanOrEqual(2000)
  })
})

test.describe('layout', () => {
  test('the pivot dialog gets its full width', async ({ page }) => {
    await openDemo(page)
    await page.getByRole('button', { name: 'Pivot', exact: true }).click()
    const box = await page.getByRole('dialog', { name: 'Summarize this result' }).boundingBox()
    expect(box!.width).toBeGreaterThan(700)
  })

  test.describe('landscape phone', () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })
    test('uses the phone layout', async ({ page }) => {
      await openDemo(page)
      await expect(page.getByRole('button', { name: 'Tables' })).toBeVisible()
      await expect(page.locator('.sql-peek')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  })
})
