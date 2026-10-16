import { expect, test } from '@playwright/test'
import { fixture, openApp, openFiles, runSql } from './helpers'

const VIEW_SQL = 'SELECT region, round(sum(amount), 2) AS revenue, count(*) AS orders FROM sales_oct GROUP BY region ORDER BY revenue DESC'

test.describe('saved views and local data', () => {
  test('a view saved on October re-points to November', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('sales_oct.csv'))
    await expect(page.locator('.result-meta')).toContainText('500 rows')
    await runSql(page, VIEW_SQL)
    await page.getByRole('button', { name: 'Save view' }).click()
    await expect(page.locator('.modal .chips')).toContainText('sales_oct')
    await page.fill('#view-name', 'Monthly revenue by region')
    await page.locator('.modal .btn-primary').click()
    await expect(page.locator('.side-view')).toContainText('Monthly revenue by region')

    // Next month: fresh session with only the new file
    await page.reload()
    await expect(page.locator('.engine-pill.is-ready')).toBeVisible({ timeout: 90_000 })
    await openFiles(page, fixture('sales_nov.csv'))
    await expect(page.locator('.result-meta')).toContainText('1,000 rows')
    await page.locator('.side-tabs button', { hasText: 'Saved' }).click()
    await page.locator('.side-view').click()
    await expect(page.locator('.remap-row select')).toHaveValue('sales_nov')
    await page.locator('.modal .btn-primary').click()
    await expect(page.locator('.result-meta')).toContainText('3 rows · 3 columns')
    await expect(page.locator('.cm-content')).toContainText('FROM sales_nov')
    await expect(page.locator('.side-view')).toContainText('sales_nov')

    await page.locator('.view-item').hover()
    await page.locator('.view-item button[title=Delete]').click()
    await expect(page.locator('.toast')).toContainText('Deleted')
    await page.locator('.toast-action').click()
    await expect(page.locator('.side-view')).toContainText('Monthly revenue by region')
  })

  test('history can be switched off and everything can be wiped', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('sales_oct.csv'))
    await runSql(page, "SELECT * FROM sales_oct WHERE region = 'North'")
    await expect(page.locator('.result-meta')).toBeVisible()
    await page.locator('.side-tabs button', { hasText: 'History' }).click()
    expect(await page.evaluate(() => localStorage.getItem('quarry:history'))).toContain('North')

    await page.locator('.history-controls input').uncheck()
    expect(await page.evaluate(() => localStorage.getItem('quarry:history'))).toBeNull()
    await runSql(page, "SELECT * FROM sales_oct WHERE region = 'South'")
    await expect(page.locator('.result-meta')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('quarry:history'))).toBeNull()

    await page.evaluate(() => localStorage.setItem('quarry:views', '[{"id":"a","name":"v","sql":"select 1","tables":[],"savedAt":1}]'))
    await page.getByRole('button', { name: 'Clear all local data' }).click()
    await page.getByRole('button', { name: 'Yes, clear' }).click()
    await expect(page.locator('.toast')).toContainText('Cleared everything')
    const keys = await page.evaluate(() => Object.keys(localStorage))
    expect(keys.filter((k) => k !== 'quarry:remember-history')).toEqual([])
  })
})
