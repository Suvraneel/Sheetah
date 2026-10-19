import { expect, test } from './fixtures'
import { messyCsv } from '../src/engine/messy'
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
    // Same columns, new name: offered at once (taken up in the next test; here, the view is re-pointed by hand).
    await expect(page.locator('.toast', { hasText: 'Your view “Monthly revenue by region” fits sales_nov' })).toBeVisible()
    await page.locator('.side-tabs button', { hasText: 'Saved' }).click()
    await expect(page.locator('.side-view')).toContainText('sales_oct · fits sales_nov')
    await page.locator('.side-view').click()
    await expect(page.locator('.remap-row select')).toHaveValue('sales_nov')
    await page.locator('.modal .btn-primary').click()
    await expect(page.locator('.result-meta')).toContainText('3 rows · 3 columns')
    await expect(page.locator('.cm-content')).toContainText('FROM sales_nov')
    await expect(page.locator('.side-view')).toContainText('sales_nov')

    await page.locator('.view-item').hover()
    await page.locator('.view-item button[title=Delete]').click()
    await expect(page.locator('.toast', { hasText: 'Deleted' })).toBeVisible()
    await page.locator('.toast', { hasText: 'Deleted' }).locator('.toast-action').click()
    await expect(page.locator('.side-view')).toContainText('Monthly revenue by region')
  })

  test('next month’s export is recognised: a view saved on this month’s runs on it in one click', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'Or tidy up a messy sales export' }).click()
    await page.getByRole('button', { name: /^Leave out 4 total lines/ }).click()
    await expect(page.locator('.result-meta')).toContainText('16 of 23 rows')
    await expect(page.getByRole('button', { name: 'Run query' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Save view' }).click()
    await page.fill('#view-name', 'Tidy sales register')
    await page.locator('.modal .btn-primary').click()
    await expect(page.locator('.side-view')).toContainText('Tidy sales register')

    await page.reload()
    await expect(page.locator('.engine-pill.is-ready')).toBeVisible({ timeout: 90_000 })
    await page.locator('input[type=file]').setInputFiles([{ name: 'sales_register_may.csv', mimeType: 'text/csv', buffer: Buffer.from(messyCsv(true)) }])
    await expect(page.locator('.result-meta')).toContainText('23 rows')
    const offer = page.locator('.toast', { hasText: 'Your view “Tidy sales register” fits sales_register_may' })
    await offer.getByRole('button', { name: 'Run it' }).click()
    await expect(page.locator('.result-meta')).toContainText('16 of 23 rows · 8 columns')
    await expect(page.locator('.cm-content')).toContainText('FROM sales_register_may')
    // Its steps come back as chips, each removable, not as a wall of SQL.
    await expect(page.locator('.op-chip', { hasText: 'Without 4 total lines' })).toBeVisible()
    await page.locator('.op-chip', { hasText: 'Without 3 empty rows' }).click()
    await expect(page.locator('.result-meta')).toContainText('19 of 23 rows')
  })

  test('views can be exported to a file and imported in another browser', async ({ page, browser }) => {
    await openApp(page)
    await openFiles(page, fixture('sales_oct.csv'))
    await runSql(page, VIEW_SQL)
    await page.getByRole('button', { name: 'Save view' }).click()
    await page.fill('#view-name', 'Monthly revenue by region')
    await page.locator('.modal .btn-primary').click()
    await page.locator('.side-tabs button', { hasText: 'Saved' }).click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export views' }).click()])
    expect(download.suggestedFilename()).toMatch(/^sheetah-views-\d{4}-\d{2}-\d{2}\.json$/)
    const file = await download.path()

    // Another browser (a fresh context: nothing stored), the same file.
    const other = await (await browser.newContext()).newPage()
    await openApp(other)
    await openFiles(other, fixture('sales_nov.csv'))
    await other.locator('.side-tabs button', { hasText: 'Saved' }).click()
    await other.getByLabel('Views file to import').setInputFiles(file)
    await expect(other.locator('.toast', { hasText: 'Added 1 view' })).toBeVisible()
    await expect(other.locator('.side-view')).toContainText('Monthly revenue by region')
    // Made on October's file, it fits November's, which is open: offered at once, and, written by someone
    // else, shown for review before it runs.
    await other.locator('.toast', { hasText: '“Monthly revenue by region” fits sales_nov' }).getByRole('button', { name: 'Review it' }).click()
    await expect(other.locator('.toast', { hasText: 'came from a views file: check its SQL, then Run' })).toBeVisible()
    await expect(other.locator('.cm-content')).toContainText('FROM sales_nov')
    await expect(other.locator('.result-meta')).toContainText('1,000 rows')
    await other.getByRole('button', { name: 'Run query' }).click()
    await expect(other.locator('.result-meta')).toContainText('3 rows · 3 columns')
    // Importing the same file again adds nothing.
    await other.getByLabel('Views file to import').setInputFiles(file)
    await expect(other.locator('.toast', { hasText: 'is already saved' })).toBeVisible()
    await expect(other.locator('.side-view')).toHaveCount(1)
    // A file that isn't one says so, and nothing is added.
    await other.getByLabel('Views file to import').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') })
    await expect(other.locator('.error-banner')).toContainText('Couldn’t finish that. That isn’t a Sheetah views file.')
    await expect(other.locator('.side-view')).toHaveCount(1)
    await other.context().close()
  })

  test('history is kept only when asked, can be switched off, and everything can be wiped', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('sales_oct.csv'))
    await runSql(page, "SELECT * FROM sales_oct WHERE region = 'East'")
    await expect(page.locator('.result-meta')).toBeVisible()
    // Queries can hold names and numbers: in this tab's history, not on the computer, until asked.
    await page.locator('.side-tabs button', { hasText: 'History' }).click()
    await expect(page.locator('.side-history').first()).toContainText('East')
    expect(await page.evaluate(() => localStorage.getItem('sheetah:history'))).toBeNull()
    await page.locator('.history-controls input').check()
    await runSql(page, "SELECT * FROM sales_oct WHERE region = 'North'")
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sheetah:history'))).toContain('North')

    await page.locator('.history-controls input').uncheck()
    expect(await page.evaluate(() => localStorage.getItem('sheetah:history'))).toBeNull()
    await runSql(page, "SELECT * FROM sales_oct WHERE region = 'South'")
    await expect(page.locator('.result-meta')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('sheetah:history'))).toBeNull()

    await page.evaluate(() => localStorage.setItem('sheetah:views', '[{"id":"a","name":"v","sql":"select 1","tables":[],"savedAt":1}]'))
    await page.getByRole('button', { name: 'Clear all local data' }).click()
    await page.getByRole('button', { name: 'Yes, clear' }).click()
    await expect(page.locator('.toast', { hasText: 'Cleared everything' })).toBeVisible()
    const keys = await page.evaluate(() => Object.keys(localStorage))
    expect(keys.filter((k) => k !== 'sheetah:remember-history')).toEqual([])
  })
})
