import { deflateRawSync, gzipSync } from 'node:zlib'
import { expect, test, type Page } from './fixtures'
import { exportAs, openApp, openDemo, runSql } from './helpers'

// Seconds of CPU (about 10–20 s in the browser), almost no memory: long enough to scroll, select and cancel while it runs.
const SLOW = 'SELECT count(*) AS n FROM range(14000) a, range(14000) b WHERE (a.range * b.range) % 7 = 3'

const file = (name: string, text: string | Buffer) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) })

/** Focuses the grid on its first cell and opens that column's menu from the keyboard. */
async function openColumnMenu(page: Page, column = 0) {
  await page.locator('.grid-scroll').focus()
  await page.keyboard.press('ArrowDown')
  for (let i = 0; i < column; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.colmenu')).toBeVisible()
}

test.describe('engine robustness', () => {
  test('a running query survives scrolling and selecting in the old result', async ({ page }) => {
    // The query is meant to be slow, and slower still while other tests share the machine.
    test.setTimeout(180_000)
    await openDemo(page)
    await runSql(page, SLOW)
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
    // Busy the read connection while the query runs: scroll, select a range (status-bar stats), jump around.
    const grid = page.locator('.grid-scroll')
    await grid.focus()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('PageDown')
      await page.keyboard.press('Shift+ArrowRight')
    }
    await page.keyboard.press('ControlOrMeta+ArrowDown')
    await expect(page.locator('.result-meta')).toContainText('1 row', { timeout: 120_000 })
    await expect(page.locator('.error-banner')).toHaveCount(0)
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText(/\d+/)
  })

  test('starting another query replaces the running one', async ({ page }) => {
    await openDemo(page)
    await runSql(page, SLOW)
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await runSql(page, 'SELECT 42 AS answer')
    await expect(page.locator('.result-meta')).toContainText('1 row · 1 column')
    await expect(page.locator('.sr-grid [role=columnheader]').first()).toContainText('answer')
    await expect(page.getByRole('button', { name: 'Run query' })).toBeVisible()
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })

  test('a column called rowid keeps rows in the query’s order', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'SELECT range AS rowid, range * 2 AS twice FROM range(1000) ORDER BY range DESC')
    await expect(page.locator('.result-meta')).toContainText('1,000 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('999')
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ControlOrMeta+ArrowDown')
    await expect(page.locator('.statusbar')).toContainText('Row 1,000')
    await expect(page.locator('.statusbar')).toContainText(/rowid\s*0/)
  })

  test('sample data never replaces a table of yours called orders', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('orders.csv', 'id,item\n1,apple\n2,pear\n')])
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    await page.getByRole('button', { name: 'Sample data' }).click()
    await expect(page.locator('.result-meta')).toContainText('1,000,000 rows', { timeout: 60_000 })
    await expect(page.locator('.side-table .side-name')).toHaveText(['orders', 'orders_2'])
    await page.locator('.side-table').filter({ has: page.locator('.side-name', { hasText: /^orders$/ }) }).click()
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    // Clicking Sample data again shows the same sample, not a third table.
    await page.getByRole('button', { name: 'Sample data' }).click()
    await expect(page.locator('.result-meta')).toContainText('1,000,000 rows')
    await expect(page.locator('.side-table')).toHaveCount(2)
  })

  test('opening a file never replaces an existing table, and odd files are handled', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('Sales.csv', 'a\n1\n')])
    await expect(page.locator('.result-meta')).toContainText('1 row')
    await page.locator('input[type=file]').setInputFiles([file('SALES.CSV.GZ', gzipSync('a,b\n1,2\n3,4\n'))])
    await expect(page.locator('.side-table .side-name')).toHaveText(['sales', 'sales_2'])
    await expect(page.locator('.result-meta')).toContainText('2 rows · 2 columns')
    await page.locator('input[type=file]').setInputFiles([file('empty.csv', '')])
    await expect(page.locator('.error-banner')).toContainText('empty.csv is empty')
    await page.locator('input[type=file]').setInputFiles([file('headers.csv', 'invoice,customer,amount\n')])
    await expect(page.locator('.grid-none')).toContainText('headers has column names but no rows yet.')
  })

  test('sorting after a multi-statement script sorts the final query', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'CREATE OR REPLACE TABLE t2 AS SELECT range AS a FROM range(10);\nSELECT * FROM t2')
    await expect(page.locator('.result-meta')).toContainText('10 rows')
    await openColumnMenu(page)
    await page.getByRole('button', { name: /High → low/ }).click()
    await expect(page.locator('.cm-content')).toContainText('ORDER BY a DESC')
    await expect(page.locator('.cm-content')).not.toContainText('CREATE')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('9')
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })

  test('a CSV whose rows have more or fewer fields than its header still opens as columns', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('ragged.csv', 'name,city,amount\nAsha,Pune,100\nRavi,Goa,200,extra\nMeera,Delhi\n')])
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await expect(page.locator('.sr-grid [role=columnheader]').nth(1)).toContainText('city')
    await expect(page.locator('.toast', { hasText: 'more or fewer fields' })).toBeVisible()
  })

  test('a big register still gets its total lines offered (a quick check of the lines that mention total)', async ({ page }) => {
    test.setTimeout(150_000)
    await openDemo(page)
    await runSql(page, "CREATE OR REPLACE TABLE register AS SELECT CASE WHEN range % 1000 = 999 THEN 'Sub-total' ELSE 'North' END AS region, range AS amount FROM range(600000)")
    await page.locator('.side-table', { hasText: 'register' }).click()
    await expect(page.locator('.result-meta')).toContainText('600,000 rows')
    await page.getByRole('button', { name: 'Leave out 600 total lines' }).click({ timeout: 60_000 })
    await expect(page.locator('.result-meta')).toContainText('599,400 of 600,000 rows')
  })

  test('statements that can’t be wrapped (PRAGMA) still give a full result you can export', async ({ page }) => {
    await openDemo(page)
    await runSql(page, "PRAGMA table_info('orders')")
    await expect(page.locator('.result-meta')).toContainText('11 rows')
    const dl = await exportAs(page, 'CSV')
    expect(dl.suggestedFilename()).toMatch(/\.csv$/)
  })

  test('a table clicked while a big one is still being looked over opens without waiting for the look-over', async ({ page }) => {
    await openApp(page)
    const big = ['id,code,city,note', ...Array.from({ length: 200_000 }, (_, i) => `${i},INV-${String(i % 9973).padStart(5, '0')},${['Pune', 'Delhi', 'Goa'][i % 3]},`)].join('\n')
    await page.locator('input[type=file]').setInputFiles([file('big.csv', big), file('small.csv', 'a,b\n1,2\n')])
    await expect(page.locator('.result-meta')).toContainText('200,000 rows', { timeout: 60_000 })
    // The look-over of the big one starts as it shows; the small one is clicked straight away.
    await page.waitForTimeout(500)
    await page.locator('.side-table', { hasText: 'small' }).click()
    await expect(page.locator('.result-meta')).toContainText('1 row', { timeout: 8_000 })
  })

  test('a shared link that inflates to gigabytes is refused, not decoded', async ({ page }) => {
    const bomb = deflateRawSync(Buffer.alloc(40_000_000, 32)).toString('base64url')
    await openApp(page, `/#q=z${bomb}`)
    await expect(page.locator('.toast-error')).toContainText('damaged or too long')
  })
})

test.describe('filters that read like people type', () => {
  test('numbers with separators, validation, and literal % in contains', async ({ page }) => {
    await openDemo(page)
    await openColumnMenu(page, 9) // total
    await page.getByLabel('Filter type').selectOption('gt')
    await page.getByLabel('Filter value').fill('abc')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await expect(page.locator('.colmenu-error')).toContainText('Enter a number')
    await page.getByLabel('Filter value').fill('20,000')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await expect(page.locator('.cm-content')).toContainText('total > 20000')
    await expect(page.locator('.op-chip')).toContainText('total > 20,000')
    await expect(page.locator('.error-banner')).toHaveCount(0)

    await runSql(page, "SELECT * FROM (VALUES ('50%'), ('50 percent'), ('a_b'), ('axb')) t(s)")
    await expect(page.locator('.result-meta')).toContainText('4 rows')
    await openColumnMenu(page)
    await page.getByLabel('Filter value').fill('50%')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await expect(page.locator('.result-meta')).toContainText('1 of 4 rows')
  })

  test('a date typed the way people write it filters by that day', async ({ page }) => {
    await openDemo(page)
    await openColumnMenu(page, 1) // ordered_at, a date and time
    await page.getByLabel('Filter value').fill('31/02/2024')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await expect(page.locator('.colmenu-error')).toContainText('Enter a date')
    // A part over 12 is the day, whatever the reader's habit (en-US here).
    await page.getByLabel('Filter type').selectOption('equals')
    await page.getByLabel('Filter value').fill('31/01/2024')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await expect(page.locator('.cm-content')).toContainText("ordered_at::DATE = DATE '2024-01-31'")
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })

  test('picking two common values keeps both (IN), and an empty result offers a way back', async ({ page }) => {
    await openDemo(page)
    await openColumnMenu(page, 3) // city
    await page.locator('.topvals li button').nth(0).click()
    await expect(page.locator('.cm-content')).toContainText("city = '")
    await expect(page.getByRole('button', { name: 'Run query' })).toBeVisible()
    // The list still offers every city (not just the one picked), with the pick checked.
    await openColumnMenu(page, 3)
    await expect(page.locator('.topvals button[aria-pressed=true]')).toHaveCount(1)
    await page.locator('.topvals button[aria-pressed=false]').first().click()
    await expect(page.locator('.cm-content')).toContainText(/city IN \('[^']+', '[^']+'\)/)
    await expect(page.locator('.op-chip')).toContainText(/city is \w+ or \w+/)
    await expect(page.getByRole('button', { name: 'Run query' })).toBeVisible()
    const n = Number((await page.locator('.result-meta strong').innerText()).replace(/,/g, ''))
    expect(n).toBeGreaterThan(100_000)

    await openColumnMenu(page, 3)
    await page.getByLabel('Filter type').selectOption('equals')
    await page.getByLabel('Filter value').fill('Atlantis')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await expect(page.locator('.grid-none')).toContainText('No rows match')
    await page.getByRole('button', { name: 'Undo last filter' }).click()
    await expect(page.locator('.result-meta strong')).toHaveText(new Intl.NumberFormat('en-US').format(n))
  })
})

test.describe('charts and pivots at the edges', () => {
  test('a column named value charts by its labels', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'SELECT city AS value, total FROM orders')
    await page.getByRole('button', { name: 'Chart', exact: true }).click()
    await page.getByLabel('Group by').selectOption('value')
    await expect(page.locator('.chart-cat').first()).toHaveText(/[A-Z][a-z]+/)
  })

  test('a blank column value becomes a (blank) pivot column', async ({ page }) => {
    await openDemo(page)
    await runSql(page, "SELECT CASE WHEN range % 2 = 0 THEN '' ELSE 'x' END AS k, 'g' || (range % 3) AS g, range AS v FROM range(30)")
    await page.getByRole('button', { name: 'Pivot', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Summarize this result' })
    await dialog.getByLabel('Column field').selectOption('k')
    await dialog.getByRole('button', { name: 'Create pivot' }).click()
    await expect(page.locator('.error-banner')).toHaveCount(0)
    await expect(page.locator('.sr-grid [role=columnheader]', { hasText: '(blank)' })).toHaveCount(1)
  })
})

test.describe('a very wide table', () => {
  test('300 columns open and are looked over without running out of memory or claiming a new version', async ({ page }) => {
    await openApp(page)
    const cols = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? `code_${i}` : i % 3 === 1 ? `amount_${i}` : `contact_${i}`))
    const lines = [cols.join(',')]
    for (let r = 0; r < 200; r++) lines.push(cols.map((_, i) => (i % 3 === 0 ? `C-${r}-${i}` : i % 3 === 1 ? (r * 1.5).toFixed(2) : `p${r}.${i}@example.com`)).join(','))
    await page.locator('input[type=file]').setInputFiles([file('wide.csv', lines.join('\n'))])
    await expect(page.locator('.result-meta')).toContainText('200 rows · 300 columns')
    // The look-over runs in parts: personal data is still found.
    await expect(page.locator('.pii-chip', { hasText: 'Personal data' })).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    await expect(page.getByText('A new version of Sheetah is ready.')).toHaveCount(0)
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('a part that can’t load', () => {
  // No service worker: it would serve the file from its cache, past the blocked route.
  test.use({ allowPageErrors: [/a part failed/], serviceWorkers: 'block' })

  test('the column menu failing to load closes with a message, and the tables stay', async ({ page }) => {
    // Offline, or the file is gone after a new version: the menu's code never arrives.
    await page.route(/ColumnMenu-[\w-]+\.js$/, (route) => route.abort())
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('sales.csv', 'city,amount\nPune,10\nGoa,20\n')])
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.locator('.error-banner')).toContainText('part of Sheetah couldn’t load')
    await expect(page.locator('.crash')).toHaveCount(0)
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    await expect(page.locator('.side-name', { hasText: 'sales' })).toBeVisible()
  })
})
