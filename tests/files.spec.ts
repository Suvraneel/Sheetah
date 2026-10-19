import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import readXlsxFile from 'read-excel-file/node'
import { committedFixture, exportAs, fixture, metaText, openApp, openFiles, runSql } from './helpers'
import { writeWorkbook } from '../src/engine/xlsx-write'

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
    await expect(page.locator('.result-meta')).toContainText('1 row')
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

  test('Excel: a header in two rows (a group merged over its columns) reads as one', async ({ page }) => {
    await openApp(page)
    // Saved as a merged header is: the group in its first cell, the cells it spans empty.
    const cols = [{ name: 'Region', type: 'VARCHAR' }, ...['Sales', '', 'Returns', ''].map((name) => ({ name, type: 'DOUBLE' }))]
    const rows = [
      [null, 'Units', 'Price', 'Units', 'Price'],
      ['North', '10', '2.5', '1', '2.5'],
      ['South', '7', '3', '0', '3'],
    ]
    const book = await writeWorkbook([{ name: 'regions', src: { columns: cols, rowCount: rows.length, fetch: async (s, e) => rows.slice(s, e) } }])
    const bytes = Buffer.from(await book.arrayBuffer())
    await page.locator('input[type=file]').setInputFiles([{ name: 'returns.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes }])
    await expect(page.locator('.result-meta')).toContainText('2 rows · 5 columns')
    await expect(page.locator('.sr-grid [role=columnheader]').nth(1)).toContainText('Sales Units')
    await expect(page.locator('.sr-grid [role=columnheader]').nth(4)).toContainText('Returns Price')
  })

  test('a workbook a portal saved as .csv or .xls opens as the workbook it is', async ({ page }) => {
    await openApp(page)
    const book = readFileSync(committedFixture('budget 2024.xlsx'))
    await page.locator('input[type=file]').setInputFiles([{ name: 'budget export.csv', mimeType: 'text/csv', buffer: book }])
    await expect(page.locator('.toast', { hasText: 'budget export.csv is an Excel workbook, whatever its name says' })).toBeVisible()
    await expect(page.locator('.side-table .side-name')).toHaveText(['budget_export_notes', 'budget_export_q1_sales'])
  })

  test('a CSV saved by Excel on Windows (not UTF-8) opens with its £ and é', async ({ page }) => {
    await openApp(page)
    // René,£12.50 in Windows-1252: é and £ are one byte each.
    const latin = Buffer.concat([Buffer.from('name,note\n'), Buffer.from([0x52, 0x65, 0x6e, 0xe9]), Buffer.from(','), Buffer.from([0xa3]), Buffer.from('12.50 refund\n')])
    await page.locator('input[type=file]').setInputFiles([{ name: 'latin1.csv', mimeType: 'text/csv', buffer: latin }])
    await expect(page.locator('.result-meta')).toContainText('1 row')
    await expect(page.locator('.sr-grid').last()).toContainText('René')
    await expect(page.locator('.sr-grid').last()).toContainText('£12.50 refund')
    await expect(page.locator('.toast', { hasText: 'read as Windows-1252' })).toBeVisible()
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
    expect(safe.charCodeAt(0)).toBe(0xfeff) // UTF-8 for Excel: René and £ arrive as written

    dl = await exportAs(page, 'CSV, exact values')
    expect(readFileSync((await dl.path())!, 'utf8')).toContain('"=HYPERLINK')
    expect(readFileSync((await dl.path())!, 'utf8').charCodeAt(0)).not.toBe(0xfeff)

    // A refund written in a text column stays a number; a sum's float noise is gone.
    await runSql(page, "SELECT '-12.50' AS refund, '£12.50 René' AS note, 0.1::DOUBLE + 0.2::DOUBLE AS total, '+919876543210' AS phone")
    await expect(page.locator('.result-meta')).toContainText('1 row')
    dl = await exportAs(page, 'CSV')
    // (A phone number written +91… stays text: Excel would make a number of it.)
    expect(readFileSync((await dl.path())!, 'utf8')).toBe("\ufeffrefund,note,total,phone\n-12.50,£12.50 René,0.3,'+919876543210\n")
    // A hostile column name, and a type that prints as anything (a union): text all the same.
    await runSql(page, `SELECT 'safe' AS "=1+1", union_value(t := '=7+7') AS u, '-' AS dash`)
    await expect(page.locator('.result-meta')).toContainText('1 row')
    dl = await exportAs(page, 'CSV')
    expect(readFileSync((await dl.path())!, 'utf8')).toBe("\ufeff'=1+1,u,dash\nsafe,'=7+7,-\n")
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

  test('Tally’s own XML opens: vouchers as one row per ledger line, a report as its rows', async ({ page }) => {
    await openApp(page)
    const vouchers = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Payment" ACTION="Create"><DATE>20240401</DATE><NARRATION>Rent for April&#4;</NARRATION>
<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><PARTYLEDGERNAME>HDFC Bank</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><AMOUNT>-25000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><AMOUNT>25000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><DATE>20240405</DATE><VOUCHERNUMBER>2</VOUCHERNUMBER><PARTYLEDGERNAME>Acme Ltd</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Ltd</LEDGERNAME><AMOUNT>50000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><AMOUNT>-50000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><DATE>20240410</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-1</VOUCHERNUMBER><PARTYLEDGERNAME>Acme Ltd</PARTYLEDGERNAME>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME><AMOUNT>10000.00</AMOUNT>
<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>10000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>Acme Ltd</LEDGERNAME><AMOUNT>-11800.00</AMOUNT></LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>Output IGST</LEDGERNAME><AMOUNT>1800.00</AMOUNT></LEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>20240412</DATE><VOUCHERNUMBER>J-7</VOUCHERNUMBER>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Office Expenses</LEDGERNAME><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
    // Tally writes UTF-16 by default.
    await page.locator('input[type=file]').setInputFiles([buf('DayBook.xml', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vouchers, 'utf16le')]))])
    await expect(page.locator('.result-meta')).toContainText('9 rows · 8 columns')
    const first = page.locator('.sr-grid [role=row]').nth(1)
    await expect(first).toContainText('2024-04-01')
    await expect(first).toContainText('Rent for April')
    await expect(first).toContainText('25,000')
    await expect(page.locator('.sr-grid [role=columnheader]').nth(6)).toContainText('Debit')
    // An item invoice's sales ledger is inside its stock lines: read from there, as a credit.
    await expect(page.locator('.sr-grid [role=row]').nth(5)).toContainText('Sales')
    await expect(page.locator('.sr-grid [role=row]').nth(5)).toContainText('10,000')
    // A voucher whose debits and credits don't agree is named above the rows.
    await expect(page.locator('.checks .is-off', { hasText: '1 voucher doesn’t balance: J-7 (100.00 more in debits)' })).toBeVisible()
    // A day book is every ledger's lines: summed by ledger (not offered a bank account's signed amount).
    await expect(page.getByRole('button', { name: /^Add signed amount/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Totals by Ledger' }).click()
    await expect(page.locator('.result-meta')).toContainText('8 rows · 5 columns')
    await expect(page.locator('.origin-chip')).toContainText('Totals by Ledger, from')
    const total = page.locator('.sr-grid [role=row]').nth(8)
    await expect(total).toContainText('Total')
    await expect(total).toContainText('87,800')
    await expect(total).toContainText('87,700')
    // A report (a trial balance): one row per account.
    const report = `<ENVELOPE><DSPACCNAME><DSPDISPNAME>Capital Account</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA></DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>500000.00</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>
<DSPACCNAME><DSPDISPNAME>Rent</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-25000.00</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA></DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>
<DSPACCNAME><DSPDISPNAME>HDFC Bank</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-475000.00</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA></DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO></ENVELOPE>`
    await page.locator('input[type=file]').setInputFiles([buf('TrialBal.xml', report)])
    await expect(page.locator('.result-meta')).toContainText('3 rows · 3 columns')
    // A trial balance's debits and credits must agree: checked as it opens.
    await expect(page.locator('.checks .is-ok', { hasText: 'Debits and credits agree: 500,000.00 each' })).toBeVisible()
    await expect(page.locator('.sr-grid [role=columnheader]').nth(0)).toContainText('Particulars')
    await expect(page.locator('.sr-grid [role=row]').nth(2)).toContainText('Rent')
    // Saved as UTF-8 (its <BODY> is Tally's, not a web page's), it opens the same.
    await page.locator('input[type=file]').setInputFiles([buf('DayBook8.xml', `<?xml version="1.0" encoding="UTF-8"?>\n${vouchers}`)])
    await expect(page.locator('.result-meta')).toContainText('9 rows · 8 columns')
  })
})

test.describe('a statement whose total line has a field missing', () => {
  test('its two-digit years are still read day first', async ({ page }) => {
    await openApp(page)
    // The total line has one field fewer than the header: the file is read again with its separator.
    const csv = 'Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n13/04/24,UPI Ravi,500.00,,"9,500.00"\n15/04/24,NEFT Acme,,"50,000.00","59,500.00"\n30/04/24,Interest,,42.00,"59,542.00"\n,Total,500.00,"50,042.00"\n'
    await page.locator('input[type=file]').setInputFiles([buf('ragged.csv', csv)])
    await expect(page.locator('.result-meta')).toContainText('4 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-04-13')
    await expect(page.locator('.sr-grid [role=row]').nth(3)).toContainText('2024-04-30')
  })
})

test.describe('a report with title lines above its table', () => {
  test('QuickBooks’ title lines (no commas) are left out, and its “Total for …” lines are total lines', async ({ page }) => {
    await openApp(page)
    // Its group names (each customer) are lines without commas too: the file reader gives up on the lot.
    const csv = [
      'Sales by Customer Detail',
      'Sunny Side Bakery LLC',
      '"January 1 - December 31, 2024"',
      '',
      ',Date,Transaction Type,Num,Amount',
      "Amy's Bird Sanctuary",
      ',06/18/2024,Sales Receipt,1074,836.97',
      ',06/19/2024,Invoice,1075,"1,145.84"',
      "Total for Amy's Bird Sanctuary,,,,\"$1,982.81\"",
      "Bill's Windsurf Shop",
      ',06/20/2024,Invoice,1792,450.00',
      "Total for Bill's Windsurf Shop,,,,$450.00",
    ].join('\r\n')
    await page.locator('input[type=file]').setInputFiles([buf('qb_sales.csv', `${csv}\n`)])
    await expect(page.locator('.toast', { hasText: 'Left out 4 title lines above the column names in qb_sales.csv.' })).toBeVisible()
    await expect(page.locator('.result-meta')).toContainText('7 rows · 5 columns')
    await expect(page.getByRole('button', { name: /^Leave out 2 total lines/ })).toBeVisible()
  })

  test('however many customers, their “Total for …” lines are offered when they add up', async ({ page }) => {
    await openApp(page)
    const lines = [',Date,Transaction Type,Num,Amount']
    for (const [i, who] of ['Acme Corp', 'Globex LLC', 'Initech Inc', 'Umbrella Co'].entries()) {
      lines.push(who, `,06/1${i}/2024,Invoice,10${i}0,100.00`, `,06/2${i}/2024,Invoice,10${i}1,50.00`, `Total for ${who},,,,150.00`)
    }
    lines.push('TOTAL,,,,600.00')
    await page.locator('input[type=file]').setInputFiles([buf('qb_four.csv', `${lines.join('\r\n')}\n`)])
    await expect(page.locator('.result-meta')).toContainText('17 rows')
    await expect(page.getByRole('button', { name: /^Leave out 5 total lines/ })).toBeVisible()
  })
})

test.describe('open data, as statistics offices publish it', () => {
  test.use({ locale: 'en-GB', timezoneId: 'Europe/London' })

  test('a note below the table in another separator doesn’t take over the columns; it’s offered for leaving out', async ({ page }) => {
    await openApp(page)
    const lines = ['area_code,area,2021,2022,2023']
    for (let i = 0; i < 20; i++) lines.push(`E0${6000000 + i},Area ${i},${1000 + i},${1100 + i},${1200 + i}`)
    lines.push('Source: ONS | Licence: OGL v3')
    await page.locator('input[type=file]').setInputFiles([buf('mye_la_2023.csv', `${lines.join('\n')}\n`)])
    await expect(page.locator('.result-meta')).toContainText('21 rows · 5 columns')
    await expect(page.locator('.toast', { hasText: 'don’t fit its columns' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Leave out 1 note line/ })).toBeVisible()
  })

  test('figures with notes on them ([note 3], (p)) and placeholders (x, ..) convert in one click, placeholders empty', async ({ page }) => {
    await openApp(page)
    const csv = ['area,2022,2023', 'A,"92,338[note 3]","1,000"', 'B,x,"108,021 (p)"', 'C,..,"2,500"', 'D,"1,500",x']
    await page.locator('input[type=file]').setInputFiles([buf('ons.csv', `${csv.join('\n')}\n`)])
    await expect(page.locator('.result-meta')).toContainText('4 rows')
    await page.getByRole('button', { name: /^Convert 2 text columns to numbers/ }).click()
    await expect(page.locator('.side-type', { hasText: 'number (converted)' }).first()).toBeVisible()
    const row = (i: number) => page.locator('.sr-grid [role=row]').nth(i)
    await expect(row(1)).toContainText('92,338') // the note mark gone, the figure kept
    await expect(row(2)).toContainText('108,021')
    await expect(row(2)).not.toContainText('x') // a suppressed figure is empty, never 0
  })

  test('a suppressed figure far down doesn’t stop the file opening', async ({ page }) => {
    await openApp(page)
    const lines = ['area_code,population,households']
    for (let i = 0; i < 30_000; i++) lines.push(`${56001 + i},${1000 + i},${400 + i}`)
    lines.push('01001,x,[x]')
    await page.locator('input[type=file]').setInputFiles([buf('pop_long.csv', `${lines.join('\n')}\n`)])
    await expect(page.locator('.result-meta')).toContainText('30,001 rows')
    await expect(page.locator('.toast', { hasText: 'so nothing is lost' })).toBeVisible()
    await runSql(page, "SELECT count(*) FILTER (WHERE area_code = '01001') AS zeros_kept, typeof(any_value(population)) AS t FROM pop_long")
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('1VARCHAR')
  })

  test('codes with zeros in front only further down a big file stay codes', async ({ page }) => {
    await openApp(page)
    const lines = ['zip_code,population']
    for (let i = 0; i < 30_000; i++) lines.push(`${56001 + i},${1000 + i}`)
    lines.push('01001,58805')
    await page.locator('input[type=file]').setInputFiles([buf('zips.csv', `${lines.join('\n')}\n`)])
    await expect(page.locator('.result-meta')).toContainText('30,001 rows')
    await expect(page.locator('.toast', { hasText: 'zip_code in zips.csv is a code' })).toBeVisible()
    await runSql(page, "SELECT count(*) AS zeros_kept FROM zips WHERE zip_code = '01001'")
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('1')
  })
})

test.describe('India’s identifiers', () => {
  test('GSTINs and PANs are checked as the table opens: a mistyped one is named', async ({ page }) => {
    await openApp(page)
    const csv = 'Vendor,GSTIN,PAN No,Amount\nAcme,27AAPFU0939F1ZV,AAPFU0939F,1000\nBeta,27AAPFU0939F1ZW,AAPFU0939F,2000\nGamma,24AAACC1206D1ZM,AAACC1206D,500\n'
    await page.locator('input[type=file]').setInputFiles([buf('vendors.csv', csv), buf('other.csv', 'a,b\n1,2\n')])
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    const wrong = page.locator('.checks .is-off', { hasText: '1 GSTIN doesn’t look right (a character mistyped, or the wrong length): 27AAPFU0939F1ZW' })
    await expect(wrong).toBeVisible()
    // Each table keeps what was found in it: away and back, it's still said.
    await page.locator('.side-table .side-name', { hasText: 'other' }).click()
    await expect(page.locator('.result-meta')).toContainText('1 row')
    await expect(wrong).toHaveCount(0)
    await page.locator('.side-table .side-name', { hasText: 'vendors' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await expect(wrong).toBeVisible()
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

test.describe('a browser on US English in India', () => {
  test.use({ locale: 'en-US', timezoneId: 'Asia/Kolkata' })

  test('reads numbers and dates as India does: 1,00,000 and 01/02/2024 as 1 February', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([buf('paid.csv', 'id,paid_on,amount\n1,01/02/2024,100000\n2,03/04/2024,250000\n')])
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('1,00,000')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-02-01')
    // Read the way this reader writes dates: nothing to offer.
    await expect(page.getByRole('button', { name: /month first/ })).toHaveCount(0)
  })
})

test.describe('dates that read both ways', () => {
  test.use({ locale: 'en-US' })

  test('01/02/2024, with no day past the 12th, is read the reader’s way: month first in the US', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([buf('paid.csv', 'id,paid_on\n1,01/02/2024\n2,03/04/2024\n3,12/11/2024\n')])
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-01-02')
    await expect(page.getByRole('button', { name: /month first/ })).toHaveCount(0)
    // Read that way only because nothing said otherwise: the other way is a click away.
    await expect(page.getByRole('button', { name: 'Read paid_on day first' })).toBeVisible()
    // A day past the 12th settles it: 25/12/2024 is day first, whoever reads it.
    await page.locator('input[type=file]').setInputFiles([buf('paid_uk.csv', 'id,paid_on\n1,01/02/2024\n2,25/12/2024\n')])
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-02-01')
  })

  test('a QuickBooks report with group lines (rows of other lengths) is read month first too', async ({ page }) => {
    await openApp(page)
    const qb = ['Customer,Date,Type,Amount', 'Amy’s Bird Sanctuary', ',10/02/2026,Invoice,120.00', ',09/10/2026,Invoice,80.00', 'Bill’s Windsurf Shop', ',12/03/2026,Invoice,45.00']
    await page.locator('input[type=file]').setInputFiles([buf('qb_sales.csv', qb.join('\n'))])
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    await expect(page.locator('.sr-grid').last()).toContainText('2026-10-02')
    await expect(page.locator('.sr-grid').last()).toContainText('2026-12-03')
    await expect(page.getByRole('button', { name: 'Read Date day first' })).toBeVisible()
  })

  test('two-digit years: 01/04/24 is 1 April 2024, not 24 April 2001', async ({ page }) => {
    await openApp(page)
    const lines = ['Date,Narration,Withdrawal Amt.,Closing Balance']
    for (let d = 1; d <= 20; d++) lines.push(`${String(d).padStart(2, '0')}/04/24,UPI ${d},10.00,${1000 - 10 * d}`)
    await page.locator('input[type=file]').setInputFiles([buf('hdfc.csv', lines.join('\n'))])
    await expect(page.locator('.result-meta')).toContainText('20 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-04-01')
    // A file that really is year first stays that way.
    await page.locator('input[type=file]').setInputFiles([buf('jp.csv', 'd,x\n24/04/01,1\n24/04/30,2\n24/05/13,3\n')])
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(3)).toContainText('2024-05-13')
    // Monthly, on the same day each month: still year first (read the other way, the dates would be years away).
    await page.locator('input[type=file]').setInputFiles([buf('monthly.csv', 'd,x\n24/01/01,1\n24/02/01,2\n24/03/01,3\n')])
    await expect(page.locator('.cm-content')).toContainText('FROM monthly')
    await expect(page.locator('.sr-grid [role=row]').nth(3)).toContainText('2024-03-01')
    // Times without seconds aren't recognised as times at first (the year 1): read from how they're written.
    const times = ['at,amount', ...Array.from({ length: 15 }, (_, i) => `${String(i + 1).padStart(2, '0')}/04/24 10:30,${i}`)]
    await page.locator('input[type=file]').setInputFiles([buf('upi.csv', times.join('\n'))])
    await expect(page.locator('.cm-content')).toContainText('FROM upi')
    await expect(page.locator('.result-meta')).toContainText('15 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-04-01 10:30')
  })
})

test.describe('numbers, codes and dates as the file means them', () => {
  const csv = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })
  /** The one row a query gives (its first data row in the grid's mirror). */
  const one = async (page: import('@playwright/test').Page, sql: string) => {
    await runSql(page, sql)
    await expect(page.locator('.result-meta')).toContainText('1 row')
    return page.locator('.sr-grid [role=row]').nth(1)
  }

  test('1.500 in a file whose prices are 2,50 is fifteen hundred; long codes keep every digit; 55 is 1955', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([csv('de.csv', 'Artikel;Menge;Preis\nSchraube;1.500;2,50\nMutter;2.000;0,75\nBolzen;750;12,00\nScheibe;12.345;0,10\nDübel;3.000;1,25\n')])
    await expect(page.locator('.toast', { hasText: 'Menge in de.csv writes thousands with a point' })).toBeVisible()
    await expect(await one(page, 'SELECT sum(number_from_text_comma(Menge)) AS n FROM de')).toContainText('19,595')

    await page.locator('input[type=file]').setInputFiles([csv('sims.csv', 'iccid,plan\n89911012000032045101,A\n89911012000032045102,B\n')])
    await expect(page.locator('.toast', { hasText: 'iccid in sims.csv holds codes longer than a number keeps' })).toBeVisible()
    await expect(await one(page, "SELECT iccid FROM sims WHERE plan = 'B'")).toContainText('89911012000032045102')

    await page.locator('input[type=file]').setInputFiles([csv('people.csv', 'name,dob\nAsha,15/08/55\nRavi,01/12/62\nMeera,23/03/04\n')])
    await expect(page.locator('.toast', { hasText: 'Two-digit years in dob (people.csv)' })).toBeVisible()
    await expect(await one(page, 'SELECT string_agg(year(dob)::VARCHAR, \' \' ORDER BY name) AS y FROM people')).toContainText('1955 2004 1962')
  })

  test('a workbook’s text codes stay text, its times keep their minute, and its error cells are said', async ({ page }) => {
    await openApp(page)
    const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate')
    const cols = [
      { name: 'ICCID', type: 'VARCHAR' },
      { name: 'Part', type: 'VARCHAR' },
      { name: 'At', type: 'TIMESTAMP' },
      { name: 'Amount', type: 'DOUBLE' },
    ]
    // 01:00 as Excel stores it: 45383.041666666664, a hair under the hour.
    const rows = [
      ['89911012000032045101', '1E5', '2024-04-01 01:00:00', '10'],
      ['89911012000032045102', '2E3', '2024-04-01 23:59:00', '20'],
    ]
    const book = await writeWorkbook([{ name: 'sims', src: { columns: cols, rowCount: rows.length, fetch: async (s, e) => rows.slice(s, e) } }])
    const files = unzipSync(new Uint8Array(await book.arrayBuffer()))
    const sheet = Object.keys(files).find((f) => /^xl\/worksheets\/sheet1\.xml$/.test(f))!
    // A cell holding #DIV/0!, and the hour written as Excel writes it.
    let xml = strFromU8(files[sheet])
    xml = xml.replace(/(<c r="D3"[^>]*?)(?: t="n")?>\s*<v>[^<]*<\/v>\s*<\/c>/, '$1 t="e"><f>1/0</f><v>#DIV/0!</v></c>')
    xml = xml.replace(/(<c r="C2"[^>]*>\s*<v>)[^<]*(<\/v>)/, '$145383.041666666664$2')
    files[sheet] = strToU8(xml)
    const bytes = Buffer.from(zipSync(files))
    await page.locator('input[type=file]').setInputFiles([{ name: 'sims.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes }])
    await expect(page.locator('.toast', { hasText: '1 cell in sims.xlsx holds an Excel error' })).toBeVisible()
    await expect(await one(page, `SELECT ICCID || ' ' || Part || ' ' || strftime("At", '%H:%M') AS v FROM sims WHERE Part = '1E5'`)).toContainText('89911012000032045101 1E5 01:00')
  })

  test('a vendor called TOTAL isn’t a total line; dates written 1st April 2024 aren’t notes', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([
      csv('fuel.csv', 'Vendor,Amount,Note\nIndianOil,12000,city\nTOTAL,3000,\nHP,9000,highway\nTOTAL,3000,\nBPCL,12200,city\n'),
    ])
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    await expect(page.getByText('Checking for total lines…')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /total line/ })).toHaveCount(0)
    await page.locator('input[type=file]').setInputFiles([
      csv(
        'spend.csv',
        'Date,Item,Amount\n01/04/2024,Rent,30000\n1st April 2024,Food,2000\n02/04/2024,Fuel,1500\nApr-15-2024,Books,700\n03/04/2024,Tea,99\n04/04/2024,Taxi,400\n',
      ),
    ])
    await expect(page.locator('.result-meta')).toContainText('6 rows')
    await expect(page.getByText('Checking for total lines…')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /undated/ })).toHaveCount(0)
  })
})
