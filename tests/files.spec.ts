import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { committedFixture, exportAs, fixture, metaText, openApp, openFiles, runSql } from './helpers'

test.describe('opening and exporting files', () => {
  test('CSV, gzipped CSV and TSV become tables with friendly names', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('big.csv'), fixture('Sales Report (2024).csv.gz'), fixture('data.tsv'))
    await expect(page.locator('.side-table .side-name')).toHaveText(['big', 'data', 'sales_report_2024'])
    await page.locator('.side-table', { hasText: 'big' }).click()
    await expect(page.locator('.result-meta')).toContainText('300,000 rows')
    await page.locator('.side-table', { hasText: 'sales_report_2024' }).click()
    await expect(page.locator('.result-meta')).toContainText('20,000 rows')
    await page.locator('.side-table', { hasText: 'data' }).click()
    await expect(page.locator('.result-meta')).toContainText('2 rows · 3 columns')
  })

  test('Excel: every sheet becomes a table with types preserved', async ({ page }) => {
    await openApp(page)
    await openFiles(page, committedFixture('budget 2024.xlsx'))
    await expect(page.locator('.side-table .side-name')).toHaveText(['budget_2024_notes', 'budget_2024_q1_sales'])
    await runSql(page, "SELECT typeof(date) AS d, typeof(paid) AS p, typeof(amount) AS a, count(*) AS n FROM budget_2024_q1_sales GROUP BY ALL")
    await expect(page.locator('.result-meta')).toContainText('1 rows')
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.statusbar')).toContainText('DATE')
  })

  test('legacy .xls gets a clear message', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('sales_oct.csv'))
    await expect(page.locator('.result-meta')).toContainText('500 rows')
    await openFiles(page, fixture('old.xls'))
    await expect(page.locator('.error-banner')).toContainText('Old .xls files aren’t supported')
  })

  test('CSV export is Excel-safe by default, with exact values on request', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('inject.csv'))
    await expect(page.locator('.result-meta')).toContainText('4 rows')

    let dl = await exportAs(page, 'CSV')
    const safe = readFileSync((await dl.path())!, 'utf8')
    expect(safe).toContain(`"'=HYPERLINK`)
    expect(safe).toContain("'+cmd|calc,-5") // numbers untouched
    expect(safe).toContain("'@SUM(A1)")
    expect(safe).toContain('Dan,normal text,4')

    dl = await exportAs(page, 'CSV, exact values')
    expect(readFileSync((await dl.path())!, 'utf8')).toContain('"=HYPERLINK')
  })

  test('large CSV export round-trips', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('big.csv'))
    await expect(page.locator('.result-meta')).toContainText('300,000 rows')
    const dl = await exportAs(page, 'CSV')
    const lines = readFileSync((await dl.path())!, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(300_001)
    expect(await metaText(page)).toContain('5 columns')
  })
})
