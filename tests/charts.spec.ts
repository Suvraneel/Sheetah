import { expect, test } from './fixtures'
import { gridTop, openDemo, recordEgress, runSql } from './helpers'

test('quick charts: time trend, grouped bars, distribution, and a runnable table view', async ({ page }) => {
  const egress = recordEgress(page)
  await openDemo(page)
  await page.getByRole('button', { name: 'Chart', exact: true }).click()

  // Picks a time axis and a money-like measure by default
  const caption = page.locator('.chart-figure figcaption')
  await expect(caption).toContainText('Sum of total by week')
  await expect(caption).toContainText('all 1,000,000 rows')
  const svg = page.getByRole('img', { name: /Sum of total by week/ })
  await svg.focus()
  await page.keyboard.press('End')
  await expect(page.locator('.chart-tip')).toBeVisible() // values readable by keyboard, not only hover

  await page.getByLabel('Group by').selectOption('city')
  await expect(caption).toContainText('Sum of total by city')
  await expect(page.locator('.chart-mark')).toHaveCount(14)
  await page.getByLabel('Measure').selectOption('count')
  await expect(caption).toContainText('Rows by city')

  // The table-view twin: the same numbers as plain SQL
  await page.getByRole('button', { name: 'Open as query' }).click()
  await expect(page.locator('.result-meta')).toContainText('14 rows')
  await expect(page.locator('.cm-content')).toContainText('count(*)')
  await runSql(page, 'SELECT * FROM orders')
  await expect(page.locator('.result-meta')).toContainText('1,000,000 rows')

  await page.getByRole('button', { name: 'Chart', exact: true }).click()
  await page.getByLabel('Group by').selectOption('total')
  await expect(caption).toContainText('Distribution of total')
  await expect(page.locator('.chart-mark')).toHaveCount(20)

  // Many groups are cut to the top 20 and say so
  await runSql(page, 'SELECT customer, total FROM orders')
  await expect(caption).toContainText('Distribution of total') // the choice carries over to the new result
  await page.getByLabel('Group by').selectOption('customer')
  await expect(caption).toContainText(/Top 20 of 192 groups/)
  expect(egress).toEqual([])
})

test('the column profile shows a histogram for numeric columns', async ({ page }) => {
  await openDemo(page)
  const top = await gridTop(page)
  await page.mouse.click(1250, top + 20) // quantity
  await expect(page.locator('.colmenu-hist')).toBeVisible()
  await expect(page.locator('.colmenu-hist .chart-mark')).toHaveCount(5) // one bar per value 1..5
})

test('years (as an unpivot leaves them, text) chart as a line over time; a rate isn’t summed by default', async ({ page }) => {
  await openDemo(page)
  await runSql(page, "SELECT * FROM (VALUES ('2015', 10.0, 1.5), ('2016', 12.0, 1.7), ('2018', 9.0, 1.2), ('2017', 11.0, 1.1)) t(year, value, rate_per_1000)")
  await expect(page.locator('.result-meta')).toContainText('4 rows')
  await page.getByRole('button', { name: 'Chart', exact: true }).click()
  const caption = page.locator('.chart-figure figcaption')
  await expect(caption).toContainText('Sum of value by year')
  // Every year, in order, as a line (not the top 20 of them as bars).
  await expect(page.getByRole('img', { name: /Sum of value by year/ })).toBeVisible()
  await expect(caption).not.toContainText('Top')
})
