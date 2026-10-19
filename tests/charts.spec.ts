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

test('a chart split by a column: a line for each over time, bars in parts, the rest as Other, and its table', async ({ page }) => {
  await openDemo(page)
  await page.getByRole('button', { name: 'Chart', exact: true }).click()
  const caption = page.locator('.chart-figure figcaption')
  await expect(caption).toContainText('Sum of total by week')
  await page.getByLabel('Split by').selectOption('status')
  await expect(caption).toContainText('Sum of total by week and status')
  await expect(page.locator('.chart-legend li')).toHaveCount(5)
  await expect(page.locator('.chart svg[role=img] .chart-line')).toHaveCount(5)
  // Every series' value at a point, by keyboard too.
  await page.getByRole('img', { name: /Sum of total by week and status/ }).focus()
  await page.keyboard.press('End')
  await expect(page.locator('.chart-tip-series > div')).toHaveCount(5)

  // Bars in parts that add up to the bar.
  await page.getByLabel('Group by').selectOption('city')
  await expect(caption).toContainText('Sum of total by city and status')
  await expect(page.locator('.chart-part')).toHaveCount(14 * 5)
  // More values than colors: the largest five, the rest as Other.
  await page.getByLabel('Split by').selectOption('category')
  await expect(caption).toContainText('5 of 8 category values shown, the rest as Other')
  await expect(page.locator('.chart-legend li')).toHaveCount(6)
  // Averages don't add up: side by side, not in parts.
  await page.getByLabel('Measure').selectOption('avg')
  await expect(caption).toContainText('Average of total by city and category')
  await expect(page.locator('.chart-part')).toHaveCount(0)
  await expect(page.locator('.chart-mark')).toHaveCount(14 * 6)

  // The table behind it: one column per series.
  await page.getByRole('button', { name: 'Open as query' }).click()
  await expect(page.locator('.result-meta')).toContainText('14 rows')
  await expect(page.locator('.cm-content')).toContainText('FILTER (WHERE')
  await expect(page.locator('.cm-content')).toContainText('AS "Other"')
})

test('a pivot with a field across charts its columns as the parts of each bar, as a pivot chart does', async ({ page }) => {
  await openDemo(page)
  await runSql(
    page,
    "SELECT * FROM (VALUES (DATE '2024-04-01', 'Food', 10.0), (DATE '2024-04-20', 'Rent', 500.0), (DATE '2024-05-09', 'Food', 20.0), (DATE '2024-06-03', 'Travel', 30.0)) t(paid_on, category, amount)",
  )
  await expect(page.locator('.result-meta')).toContainText('4 rows')
  await page.getByRole('button', { name: 'Pivot', exact: true }).click()
  await page.getByRole('dialog', { name: 'Summarize this result' }).getByRole('button', { name: 'Create pivot' }).click()
  await expect(page.locator('.result-meta')).toContainText('4 rows · 5 columns')
  await page.getByRole('button', { name: 'Chart', exact: true }).click()
  await expect(page.locator('.chart-figure figcaption strong')).toHaveText('Sum of amount by paid_on (month) and category')
  await expect(page.locator('.chart-legend li')).toHaveText(['Food', 'Rent', 'Travel'])
  // April in two parts, May and June in one; the Total row and column are left out.
  await expect(page.locator('.chart-part')).toHaveCount(4)
  expect(await page.locator('.chart-figure .chart-cat').allTextContents()).toEqual(['Apr 2024', 'May 2024', 'Jun 2024'])
  // One column instead: one bar each.
  await page.getByRole('combobox', { name: 'of', exact: true }).selectOption('Total')
  await expect(page.locator('.chart-figure figcaption strong')).toHaveText('Total by paid_on (month)')
  await expect(page.locator('.chart-part')).toHaveCount(0)
  await expect(page.locator('.chart-mark')).toHaveCount(3)
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

test('rows with no date to plot are said, not passed over', async ({ page }) => {
  await openDemo(page)
  await runSql(page, "SELECT * FROM (VALUES (DATE '2024-04-01', 10.0), (NULL, 20.0), (DATE '2024-05-01', 30.0), (NULL, 5.0)) t(paid_on, amount)")
  await expect(page.locator('.result-meta')).toContainText('4 rows')
  await page.getByRole('button', { name: 'Chart', exact: true }).click()
  const caption = page.locator('.chart-figure figcaption')
  await expect(caption).toContainText('2 of 4 rows (2 with no paid_on left out)')
})
