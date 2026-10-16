import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openDemo, runSql } from './helpers'

/** Whether a snapshot file exists in OPFS (false while the folder doesn't exist yet). */
const hasSnapshot = (page: Page, file: string) =>
  page.evaluate(async (f) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('quarry-tables')
      await dir.getFileHandle(f)
      return true
    } catch {
      return false
    }
  }, file)
const hasFolder = (page: Page) =>
  page.evaluate(() => navigator.storage.getDirectory().then((d) => d.getDirectoryHandle('quarry-tables')).then(() => true, () => false))

const MIXED = `CREATE TABLE kept AS SELECT
  range AS id,
  (range * 9007199254740993)::HUGEINT::BIGINT // 1 AS big,
  (range / 7)::DECIMAL(10,2) AS price,
  DATE '2024-01-01' + range::INTEGER AS day,
  TIMESTAMP '2024-01-01 08:30:00' + INTERVAL (range) MINUTE AS at,
  'row ' || range AS label,
  [range, range + 1] AS pair
FROM range(1000)`

test('kept tables survive a reload with exact types; sample data and wiped data do not', async ({ page }) => {
  await openDemo(page)
  await runSql(page, MIXED)
  await expect(page.locator('.side-name', { hasText: 'kept' })).toBeVisible()
  const types = await page.locator('.side-list > li', { hasText: 'kept' }).locator('.side-type').allInnerTexts()
  expect(types).toEqual(['bigint', 'bigint', 'decimal(10,2)', 'date', 'timestamp', 'varchar', 'bigint[]'])

  await page.getByLabel('Keep my tables in this browser').check()
  await expect(page.locator('.toast')).toContainText('kept in this browser')
  await expect
    .poll(() => hasSnapshot(page, 'kept.arrow'))
    .toBe(true)

  await page.reload()
  await expect(page.locator('.toast')).toContainText('Restored 1 table', { timeout: 90_000 })
  await expect(page.locator('.result-meta')).toContainText('1,000 rows')
  await expect(page.locator('.side-name', { hasText: 'orders' })).toHaveCount(0) // sample data is never kept
  expect(await page.locator('.side-list > li', { hasText: 'kept' }).locator('.side-type').allInnerTexts()).toEqual(types)

  await runSql(page, 'SELECT sum(big)::VARCHAR AS s, max(price)::VARCHAR AS p, max(day)::VARCHAR AS d FROM kept')
  await expect(page.locator('.result-meta')).toContainText('1 rows')
  await expect(page.locator('.statusbar')).toBeVisible()

  // Changes are re-saved: drop it and the snapshot goes too.
  await runSql(page, 'DROP TABLE kept')
  await expect
    .poll(() => hasSnapshot(page, 'kept.arrow'))
    .toBe(false)

  // "Clear all local data" removes the whole folder and turns the option off.
  await runSql(page, 'CREATE TABLE again AS SELECT 1 AS x')
  await expect.poll(() => hasSnapshot(page, 'again.arrow')).toBe(true)
  await page.getByRole('tab', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Clear all local data' }).click()
  await page.getByRole('button', { name: 'Yes, clear' }).click()
  await expect(page.locator('.toast')).toContainText('Cleared everything')
  expect(await hasFolder(page)).toBe(false)
  await page.getByRole('tab', { name: 'Tables' }).click()
  await expect(page.getByLabel('Keep my tables in this browser')).not.toBeChecked()
})
