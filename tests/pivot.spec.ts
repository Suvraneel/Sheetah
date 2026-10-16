import { expect, test } from '@playwright/test'
import { openDemo, recordEgress, runSql } from './helpers'

test('pivot: sensible defaults, correct totals, editable, and a clear limit', async ({ page }) => {
  const egress = recordEgress(page)
  await openDemo(page)
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Summarize this result' })
  // Smallest category across, the next one down, money in the cells
  await expect(dialog.getByLabel('Column field')).toHaveValue('status')
  await expect(dialog.locator('.pivot-name')).toHaveText(['category'])
  await expect(dialog.getByLabel('Value 1 column')).toHaveValue('total')
  await dialog.getByRole('button', { name: 'Create pivot' }).click()

  await expect(page.locator('.result-meta')).toContainText('9 rows · 7 columns') // 8 categories + Total; category, 5 statuses, Total
  await expect(page.locator('.cm-content')).toContainText('-- Pivot: rows category · columns status · values Sum of total')
  const pivot = await page.locator('.cm-content').innerText()

  // The numbers add up: the grand total matches the source, and every row's statuses sum to its Total.
  await runSql(
    page,
    `WITH p AS (\n${pivot}\n)
     SELECT CASE
       WHEN (SELECT "Total" FROM p WHERE category = 'Total') <> (SELECT round(sum(total), 2) FROM orders) THEN error('grand total mismatch')
       WHEN (SELECT max(abs(cancelled + delivered + processing + returned + shipped - "Total")) FROM p) > 0.1 THEN error('row total mismatch')
       WHEN (SELECT count(*) FROM p) <> 9 THEN error('row count')
       ELSE 'ok' END AS check`,
  )
  await expect(page.locator('.result-meta')).toContainText('1 rows')
  await expect(page.locator('.error-banner')).toHaveCount(0)

  // Reopen the pivot and edit it: years across instead of status
  await runSql(page, pivot)
  await expect(page.locator('.result-meta')).toContainText('9 rows · 7 columns')
  await page.keyboard.press('Escape') // close the editor's autocomplete list
  await page.getByRole('button', { name: 'Edit pivot' }).click()
  await expect(dialog.locator('.pivot-name')).toHaveText(['category'])
  await dialog.getByLabel('Column field').selectOption('ordered_at')
  await dialog.getByLabel('Group ordered_at by').selectOption('year')
  await dialog.getByLabel('Sort rows').selectOption('value')
  await dialog.getByRole('button', { name: 'Update pivot' }).click()
  await expect(page.locator('.result-meta')).toContainText('9 rows · 4 columns')
  await expect(page.locator('.cm-content')).toContainText(`date_trunc('year', "ordered_at")::DATE`)
  await expect(page.locator('.cm-content')).toContainText('"Total" DESC')

  // Too many values for columns: say why and what to do
  await page.getByRole('button', { name: 'Edit pivot' }).click()
  await dialog.getByLabel('Column field').selectOption('customer')
  await dialog.getByRole('button', { name: 'Update pivot' }).click()
  await expect(dialog.locator('.pivot-error')).toContainText('192 different values')
  await expect(dialog.locator('.pivot-error')).toContainText('Put it in Rows instead')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(egress).toEqual([])
})

test('pivot: columns only, several values, and date rows', async ({ page }) => {
  await openDemo(page)
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Summarize this result' })
  await dialog.getByRole('button', { name: 'Remove category from rows' }).click()
  await dialog.getByRole('button', { name: '+ Add a value' }).click()
  await dialog.getByRole('button', { name: 'Create pivot' }).click()
  // One row; per status a sum and an average, plus two totals
  await expect(page.locator('.result-meta')).toContainText('1 rows · 12 columns')

  await expect(page.getByRole('button', { name: 'Edit pivot' })).toBeVisible()

  await runSql(page, 'SELECT * FROM orders')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  await dialog.getByRole('button', { name: 'Remove category from rows' }).click()
  await dialog.getByLabel('Add a row field').selectOption('ordered_at')
  await dialog.getByLabel('Group ordered_at by').selectOption('quarter')
  await dialog.getByLabel('Column field').selectOption('')
  await dialog.getByLabel('Value 1 calculation').selectOption('count')
  await dialog.getByRole('button', { name: 'Create pivot' }).click()
  await expect(page.locator('.result-meta')).toContainText(/\d+ rows · 2 columns/)
  await expect(page.locator('.cm-content')).toContainText('count(*) AS "Rows"')
  await expect(page.locator('.error-banner')).toHaveCount(0)
})
