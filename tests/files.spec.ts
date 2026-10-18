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

  test('01/02/2024 read day first is offered month first to a reader who writes it that way', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([buf('paid.csv', 'id,paid_on\n1,01/02/2024\n2,03/04/2024\n3,12/11/2024\n')])
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await page.getByRole('button', { name: 'Read paid_on month first' }).click()
    await expect(page.locator('.op-chip', { hasText: 'paid_on day and month swapped' })).toBeVisible()
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-01-02')
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
