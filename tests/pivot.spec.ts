import { readFileSync } from 'node:fs'
import readXlsxFile from 'read-excel-file/node'
import { expect, test } from './fixtures'
import { exportAs, openDemo, recordEgress, runSql } from './helpers'

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
       WHEN abs((SELECT "Total" FROM p WHERE category = 'Total') - (SELECT sum(total) FROM orders)) > 0.01 THEN error('grand total mismatch')
       WHEN (SELECT max(abs(cancelled + delivered + processing + returned + shipped - "Total")) FROM p) > 0.1 THEN error('row total mismatch')
       WHEN (SELECT count(*) FROM p) <> 9 THEN error('row count')
       ELSE 'ok' END AS check`,
  )
  await expect(page.locator('.result-meta')).toContainText('1 row')
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
  await expect(page.locator('.result-meta')).toContainText('1 row · 12 columns')

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

test('a pivot exports to Excel with the rows behind it on a second sheet', async ({ page }) => {
  await openDemo(page)
  await runSql(page, "SELECT * FROM (VALUES ('Pune', 'card', 10), ('Pune', 'cash', 5), ('Goa', 'card', 7)) t(city, paid_by, amount)")
  await expect(page.locator('.result-meta')).toContainText('3 rows')
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  await page.getByRole('dialog', { name: 'Summarize this result' }).getByRole('button', { name: 'Create pivot' }).click()
  await expect(page.locator('.cm-content')).toContainText('-- Pivot')
  const dl = await exportAs(page, 'Excel, with the rows behind it')
  const sheets = (await readXlsxFile(readFileSync((await dl.path())!))) as unknown as { sheet: string; data: unknown[][] }[]
  expect(sheets.map((s) => s.sheet)).toEqual(['pivot', 'rows'])
  expect(sheets[1].data).toEqual([['city', 'paid_by', 'amount'], ['Pune', 'card', 10], ['Pune', 'cash', 5], ['Goa', 'card', 7]])
})

test('months in a pivot read as months that sort as dates; charted, they stay in order and read Apr 2024', async ({ page }) => {
  await openDemo(page)
  await runSql(
    page,
    "SELECT * FROM (VALUES (DATE '2024-06-03', 'Food', 10.0), (DATE '2024-04-01', 'Rent', 500.0), (DATE '2024-05-09', 'Food', 20.0), (DATE '2024-04-20', 'Food', 5.0)) t(paid_on, category, amount)",
  )
  await expect(page.locator('.result-meta')).toContainText('4 rows')
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Summarize this result' })
  // By default: the months down the side (the only other field, category, goes across). Just the months here.
  await expect(dialog.locator('.pivot-name')).toHaveText(['paid_on'])
  await dialog.getByLabel('Column field').selectOption('')
  await dialog.getByRole('button', { name: 'Create pivot' }).click()
  await expect(page.locator('.result-meta')).toContainText('4 rows · 2 columns')
  const rows = page.locator('.sr-grid [role=row]')
  await expect(rows.nth(1)).toContainText('2024-04')
  await expect(rows.nth(3)).toContainText('2024-06')
  await expect(rows.nth(4)).toContainText('Total')
  // The chart keeps the months in order (not by size), leaves the Total out, and says "Sum of amount" once.
  await page.getByRole('button', { name: 'Chart', exact: true }).click()
  await expect(page.locator('.chart-figure figcaption strong')).toHaveText('Sum of amount by paid_on (month)')
  await expect(page.locator('.chart-figure')).toContainText('3 groups')
  expect(await page.locator('.chart-figure .chart-cat').allTextContents()).toEqual(['Apr 2024', 'May 2024', 'Jun 2024'])
})

test('financial years run April to March: FY 2023-24, FY 2024-25, and their quarters', async ({ page }) => {
  await openDemo(page)
  await runSql(page, "SELECT * FROM (VALUES (DATE '2024-03-31', 100.0), (DATE '2024-04-01', 10.0), (DATE '2025-01-15', 5.0)) t(paid_on, amount)")
  await expect(page.locator('.result-meta')).toContainText('3 rows')
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Summarize this result' })
  await dialog.getByLabel('Group paid_on by').selectOption('fy')
  await dialog.getByRole('button', { name: 'Create pivot' }).click()
  await expect(page.locator('.result-meta')).toContainText('3 rows · 2 columns')
  const rows = page.locator('.sr-grid [role=row]')
  await expect(rows.nth(1)).toContainText('FY 2023-24')
  await expect(rows.nth(1)).toContainText('100')
  await expect(rows.nth(2)).toContainText('FY 2024-25')
  await expect(rows.nth(2)).toContainText('15')
  // Its quarters: April to June is Q1, January to March Q4.
  await page.locator('.origin-chip').click()
  await expect(page.locator('.result-meta')).toContainText('3 rows · 2 columns')
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  await dialog.getByLabel('Group paid_on by').selectOption('fquarter')
  await dialog.getByRole('button', { name: 'Create pivot' }).click()
  await expect(page.locator('.result-meta')).toContainText('4 rows · 2 columns')
  await expect(rows.nth(1)).toContainText('FY 2023-24 Q4')
  await expect(rows.nth(2)).toContainText('FY 2024-25 Q1')
  await expect(rows.nth(3)).toContainText('FY 2024-25 Q4')
})
