import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import readXlsxFile from 'read-excel-file/node'
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

  test('Excel: a report’s title lines above the column names are left out', async ({ page }) => {
    await openApp(page)
    await openFiles(page, committedFixture('sales register.xlsx'))
    await expect(page.locator('.toast', { hasText: 'Left out 3 title lines above the column names in sales register.xlsx' })).toBeVisible()
    await expect(page.locator('.result-meta')).toContainText('3 rows · 3 columns')
    await expect(page.locator('.sr-grid [role=columnheader]').first()).toContainText('Invoice')
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

  test('Excel export keeps numbers, dates and text apart, and never turns text into formulas', async ({ page }) => {
    await openApp(page)
    await openFiles(page, fixture('inject.csv'))
    await expect(page.locator('.result-meta')).toContainText('4 rows')
    await runSql(page, "SELECT *, DATE '2024-08-15' AS on_day, 12345678901234567890::HUGEINT AS big FROM inject")
    await expect(page.locator('.result-meta')).toContainText('4 rows')
    const dl = await exportAs(page, 'Excel (.xlsx)')
    expect(dl.suggestedFilename()).toMatch(/\.xlsx$/)
    const [sheet] = (await readXlsxFile(readFileSync((await dl.path())!))) as unknown as { data: unknown[][] }[]
    const [header, ...rows] = sheet.data
    expect(header).toContain('on_day')
    const text = rows.flat().filter((v): v is string => typeof v === 'string')
    expect(text.some((v) => v.startsWith('=HYPERLINK'))).toBe(true) // stored as text, not a formula
    expect(rows.every((r) => (r[header.indexOf('on_day')] as Date).toISOString() === '2024-08-15T00:00:00.000Z')).toBe(true)
    expect(rows[0][header.indexOf('big')]).toBe('12345678901234567890')
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

const buf = (name: string, data: string | Buffer) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.isBuffer(data) ? data : Buffer.from(data) })

test.describe('files that are something else inside', () => {
  test('a PDF, an image or a zip says what it is and what to do, in plain words', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([buf('statement.csv', '%PDF-1.7\n1 0 obj\n')])
    await expect(page.getByRole('alert')).toContainText('statement.csv is a PDF')
    await page.locator('input[type=file]').setInputFiles([buf('scan.csv', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))])
    await expect(page.getByRole('alert')).toContainText('scan.csv is an image')
    await page.locator('input[type=file]').setInputFiles([buf('export.zip.csv', Buffer.from('PK\x03\x04rest of the zip'))])
    await expect(page.getByRole('alert')).toContainText('is a zip archive. Unzip it')
  })

  test('an ".xls" that is a web page’s table opens, title lines and all', async ({ page }) => {
    await openApp(page)
    const html = `<html><head><meta charset="utf-8"><style>td{}</style></head><body>
      <table><tr><td colspan="3">Statement of account</td></tr>
      <tr><th>Date</th><th>Narration</th><th>Amount</th></tr>
      <tr><td>01-04-2024</td><td>NEFT  from Asha</td><td>1,200.00</td></tr>
      <tr><td>02-04-2024</td><td>UPI to Ravi</td><td>-350.50</td></tr></table></body></html>`
    await page.locator('input[type=file]').setInputFiles([buf('statement.xls', html)])
    // Said once, as it opens (a toast that fades): checked first.
    await expect(page.locator('.toast', { hasText: 'Left out a title line above the column names in statement.xls' })).toBeVisible()
    await expect(page.locator('.result-meta')).toContainText('2 rows · 3 columns')
    await expect(page.locator('.sr-grid [role=columnheader]').nth(1)).toContainText('Narration')
    await expect(page.locator('.side-name')).toHaveText(['statement'])
    // Excel's "web page" export: windows-1252, the data table inside a layout table, a cell spanning two rows.
    const page1252 = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head><body>
      <table><tr><td><table><tr><td>Branch</td><td>Item</td><td>Price</td></tr>
      <tr><td rowspan="2">Café Rouge</td><td>Tea</td><td>£2.50</td></tr><tr><td>Scone</td><td>£3.10</td></tr></table></td></tr></table></body></html>`
    await page.locator('input[type=file]').setInputFiles([buf('menu.xls', Buffer.from(page1252, 'latin1'))])
    await expect(page.locator('.result-meta')).toContainText('2 rows · 3 columns')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('Café Rouge')
    await expect(page.locator('.sr-grid [role=row]').nth(2)).toContainText('£3.10')
  })

  test('Excel 2003 XML and UTF-16 “Unicode text” open as tables', async ({ page }) => {
    await openApp(page)
    const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Stock"><Table>
  <Row><Cell><Data ss:Type="String">Item</Data></Cell><Cell><Data ss:Type="String">Qty</Data></Cell><Cell><Data ss:Type="String">Received</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">Pens</Data></Cell><Cell><Data ss:Type="Number">40</Data></Cell><Cell><Data ss:Type="DateTime">2024-04-03T00:00:00.000</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">Ink</Data></Cell><Cell ss:Index="3"><Data ss:Type="DateTime">2024-04-05T00:00:00.000</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`
    await page.locator('input[type=file]').setInputFiles([buf('stock.xls', xml)])
    await expect(page.locator('.result-meta')).toContainText('2 rows · 3 columns')
    await expect(page.locator('.sr-grid [role=columnheader]').nth(2)).toContainText('date')
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name\tcity\nAsha\tPuné\nRavi\tGoa\n', 'utf16le')])
    await page.locator('input[type=file]').setInputFiles([buf('people.txt', utf16)])
    await expect(page.locator('.result-meta')).toContainText('2 rows · 2 columns')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('Puné')
  })
})

test.describe('pasting cells', () => {
  test('cells copied from a spreadsheet, pasted on the page, become a table', async ({ page }) => {
    await openApp(page)
    const paste = (text: string) =>
      page.evaluate((t) => {
        const data = new DataTransfer()
        data.setData('text/plain', t)
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }, text)
    await paste('Region\tSales\nNorth\t1,200\nSouth\t800\nEast\t2,400\n')
    await expect(page.locator('.result-meta')).toContainText('3 rows · 2 columns')
    await expect(page.locator('.side-name')).toHaveText(['pasted'])
    await expect(page.locator('.toast', { hasText: 'Made a table of what you pasted: pasted' })).toBeVisible()
    // A sentence isn't a table: said so, and nothing is made.
    await paste('Just a note')
    await expect(page.locator('.toast', { hasText: 'two rows or more' })).toBeVisible()
    await expect(page.locator('.side-name')).toHaveText(['pasted'])
  })
})

test.describe('dates that read both ways', () => {
  test.use({ locale: 'en-US' })

  test('01/02/2024 read day first is offered month first to a reader who writes it that way', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([buf('paid.csv', 'id,paid_on\n1,01/02/2024\n2,03/04/2024\n3,12/11/2024\n')])
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await page.getByRole('button', { name: 'Read paid_on month first' }).click()
    await expect(page.locator('.op-chip', { hasText: 'paid_on day and month swapped' })).toBeVisible()
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-01-02')
  })
})
