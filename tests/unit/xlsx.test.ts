import { expect, test } from '@playwright/test'
import readXlsxFile from 'read-excel-file/node'
import { colName, excelDate, sheetName, writeXlsx, type XlsxColumn } from '../../src/engine/xlsx-write'

/** The first sheet's rows, as read back by an independent reader. */
async function readBack(buf: Buffer): Promise<{ sheet: string; rows: unknown[][] }> {
  const [first] = (await readXlsxFile(buf)) as unknown as { sheet: string; data: unknown[][] }[]
  return { sheet: first.sheet, rows: first.data }
}

const columns: XlsxColumn[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'amount', type: 'DOUBLE' },
  { name: 'joined', type: 'DATE' },
  { name: 'seen', type: 'TIMESTAMP' },
  { name: 'active', type: 'BOOLEAN' },
  { name: 'big', type: 'HUGEINT' },
]
const data: (string | null)[][] = [
  ['1', 'Asha & Co <ltd>', '1234.5', '2024-08-15', '2024-08-15 10:30:00', 'true', '12345678901234567890'],
  ['2', '=HYPERLINK("http://x")', null, null, null, 'false', '42'],
  ['3', 'tab\there\u0001 _x0041_', '-0.25', '1999-12-31', '2000-01-01 00:00:00.5', null, '-7'],
]

async function build(rows = data, cols = columns) {
  const blob = await writeXlsx('Report: Q3/2024 [final]', { columns: cols, rowCount: rows.length, fetch: async (s, e) => rows.slice(s, e) })
  return Buffer.from(await blob.arrayBuffer())
}

test.describe('Excel export', () => {
  test('helpers: column letters, Excel dates, sheet names', () => {
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
    expect(excelDate('1900-03-01')).toBe(61)
    expect(excelDate('2024-08-15')).toBe(45519)
    expect(excelDate('2024-08-15 12:00:00')).toBe(45519.5)
    expect(excelDate('1800-01-01')).toBeNull()
    expect(excelDate('0024-08-15')).toBeNull() // not 1924
    expect(excelDate('1900-01-01')).toBe(1) // Excel's day 1
    expect(excelDate('1900-02-28')).toBe(59)
    expect(sheetName('Report: Q3/2024 [final]')).toBe('Report  Q3 2024  final')
  })

  test('a real workbook: typed cells, text never becomes a formula, long integers stay exact', async () => {
    const buf = await build()
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    const { sheet, rows } = await readBack(buf)
    expect(sheet).toBe('Report  Q3 2024  final')
    expect(rows[0]).toEqual(columns.map((c) => c.name))
    expect(rows[1][0]).toBe(1)
    expect(rows[1][1]).toBe('Asha & Co <ltd>')
    expect(rows[1][2]).toBe(1234.5)
    expect((rows[1][3] as Date).toISOString()).toBe('2024-08-15T00:00:00.000Z')
    expect((rows[1][4] as Date).toISOString()).toBe('2024-08-15T10:30:00.000Z')
    expect(rows[1][5]).toBe(true)
    expect(rows[1][6]).toBe('12345678901234567890') // 20 digits: Excel would round it as a number
    expect(rows[2][1]).toBe('=HYPERLINK("http://x")')
    expect(rows[2][2]).toBeNull()
    expect(rows[2][5]).toBe(false)
    expect(rows[2][6]).toBe(42)
    // Control characters XML can't hold are dropped. "_x0041_" is stored escaped, so Excel (which decodes
    // _xHHHH_) shows it as written instead of "A"; this reader shows the stored form.
    expect(rows[3][1]).toBe('tab\there _x005F_x0041_')
    expect(rows[3][2]).toBe(-0.25)
  })

  test('many rows stream through in windows', async () => {
    const many = Array.from({ length: 12_345 }, (_, i) => [String(i), `row ${i}`])
    const fetched: [number, number][] = []
    const blob = await writeXlsx('big', {
      columns: [
        { name: 'n', type: 'INTEGER' },
        { name: 's', type: 'VARCHAR' },
      ],
      rowCount: many.length,
      fetch: async (s, e) => {
        fetched.push([s, e])
        return many.slice(s, e)
      },
    })
    const { rows } = await readBack(Buffer.from(await blob.arrayBuffer()))
    expect(rows).toHaveLength(12_346)
    expect(rows.at(-1)).toEqual([12_344, 'row 12344'])
    expect(Math.max(...fetched.map(([s, e]) => e - s))).toBeLessThanOrEqual(5000)
  })

  test('too many cells is refused with a useful message', async () => {
    const cols = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, type: 'INTEGER' }))
    await expect(writeXlsx('x', { columns: cols, rowCount: 1_000_000, fetch: async () => [] })).rejects.toThrow(/CSV or Parquet/)
  })
})

test('percentages are written as fractions with a percent format', async () => {
  // fflate comes with read-excel-file (the reader these tests already use).
  const { unzipSync, strFromU8 } = await import('fflate')
  const buf = await build([['0.18'], ['0.125']], [{ name: 'GST %', type: 'DOUBLE', percent: true }])
  const files = unzipSync(new Uint8Array(buf))
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
  const styles = strFromU8(files['xl/styles.xml'])
  expect(sheet).toContain('<c r="A2" s="6"><v>0.18</v></c>')
  // Style 6 is Excel's built-in 0.00% format.
  const xfs = styles.slice(styles.indexOf('<cellXfs')).match(/<xf [^>]*\/>/g) ?? []
  expect(xfs[6]).toContain('numFmtId="10"')
  expect((await readBack(buf)).rows[1][0]).toBe(0.18)
})

test('a workbook can hold several sheets (a pivot, and the rows behind it)', async () => {
  const { writeWorkbook } = await import('../../src/engine/xlsx-write')
  const src = (cols: string[], rows: string[][]) => ({
    columns: cols.map((name) => ({ name, type: name === 'n' ? 'BIGINT' : 'VARCHAR', numeric: name === 'n' })),
    rowCount: rows.length,
    fetch: async (s: number, e: number) => rows.slice(s, e),
  })
  const blob = await writeWorkbook([
    { name: 'pivot', src: src(['city', 'n'], [['Pune', '2']]) },
    { name: 'pivot', src: src(['city', 'n'], [['Pune', '1'], ['Pune', '1']]) },
  ])
  const sheets = (await readXlsxFile(Buffer.from(await blob.arrayBuffer()))) as unknown as { sheet: string; data: unknown[][] }[]
  expect(sheets.map((s) => s.sheet)).toEqual(['pivot', 'pivot (2)'])
  expect(sheets[1].data).toEqual([['city', 'n'], ['Pune', 1], ['Pune', 1]])
})

test('months written as text (a pivot’s "2024-04") become real dates, shown as months; its Total stays text', async () => {
  const cols: XlsxColumn[] = [
    { name: 'Date (month)', type: 'VARCHAR' },
    { name: 'Sum of amount', type: 'DOUBLE' },
  ]
  const rows = [
    ['2024-04', '505'],
    ['2024-05', '20'],
    ['Total', '525'],
  ]
  const { rows: back } = await readBack(await build(rows, cols))
  expect(back[1][0]).toEqual(new Date(Date.UTC(2024, 3, 1)))
  expect(back[2][0]).toEqual(new Date(Date.UTC(2024, 4, 1)))
  expect(back[3][0]).toBe('Total')
  // Text that only sometimes looks like a month stays text.
  const mixed = await readBack(await build([['Apr 2024', '1'], ['Pune', '2']], cols))
  expect(mixed.rows[1][0]).toBe('Apr 2024')
  // A report's own month names count too.
  expect((await readBack(await build([['Apr 2024', '1'], ['May 2024', '2']], cols))).rows[2][0]).toEqual(new Date(Date.UTC(2024, 4, 1)))
})

test('a column is as wide as its numbers will show (141544.3 is 1,41,544.30), so Excel never shows ###', async () => {
  const { unzipSync, strFromU8 } = await import('fflate')
  const buf = await build([['Balance as per bank statement', '141544.3'], ['Less: cheques', '-12400']], [{ name: 'Particulars', type: 'VARCHAR' }, { name: 'Total', type: 'DOUBLE' }])
  const sheet = strFromU8(unzipSync(new Uint8Array(buf))['xl/worksheets/sheet1.xml'])
  const widths = [...sheet.matchAll(/<col min="(\d+)" max="\d+" width="(\d+)"/g)].map((m) => Number(m[2]))
  // "1,41,544.30" is 11 characters: a column of 9 (the raw value's) would show ###.
  expect(widths[1]).toBeGreaterThanOrEqual(12)
  expect(widths[0]).toBeGreaterThanOrEqual('Balance as per bank statement'.length)
})

test('a sum’s float noise is written to the 15 digits Excel keeps', async () => {
  const cols: XlsxColumn[] = [{ name: 'total', type: 'DOUBLE' }]
  const blob = await writeXlsx('t', { columns: cols, rowCount: 3, fetch: async () => [['98.44999999999999'], ['519314.16000000003'], ['0.30000000000000004']] })
  const { rows } = await readBack(Buffer.from(await blob.arrayBuffer()))
  expect(rows.slice(1).map((r) => r[0])).toEqual([98.45, 519314.16, 0.3])
})

test('a workbook’s sheet sizes are read from its zip directory, nothing unpacked', async () => {
  const { zipSync, strToU8 } = await import('fflate')
  const { sheetSizes } = await import('../../src/engine/xlsx-zip')
  const zip = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': strToU8('x'.repeat(5000)), 'xl/worksheets/sheet2.xml': strToU8('y'.repeat(123)) })
  expect(await sheetSizes(new Blob([zip]))).toEqual([
    { name: 'xl/worksheets/sheet1.xml', size: 5000 },
    { name: 'xl/worksheets/sheet2.xml', size: 123 },
  ])
  expect(await sheetSizes(new Blob([strToU8('not a zip')]))).toEqual([])
})
