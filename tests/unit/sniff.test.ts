import { expect, test } from '@playwright/test'
import { notATable, sniff } from '../../src/engine/sniff'

const bytes = (s: string | number[]) => (typeof s === 'string' ? new TextEncoder().encode(s) : new Uint8Array(s))

test('a file is known by its first bytes, whatever its name says', () => {
  expect(sniff(bytes('%PDF-1.4'))).toBe('pdf')
  expect(sniff(bytes([0x89, 0x50, 0x4e, 0x47, 13, 10]))).toBe('image')
  expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image')
  expect(sniff(bytes([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe('zip')
  expect(sniff(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('ole')
  expect(sniff(bytes([0xff, 0xfe, 0x6e, 0x00]))).toBe('utf16le')
  expect(sniff(bytes('﻿  <html><body><table>'))).toBe('html')
  expect(sniff(bytes('<table border=1><tr>'))).toBe('html')
  expect(sniff(bytes('<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">'))).toBe('xml-sheet')
  expect(sniff(bytes('name,city\nAsha,Pune\n'))).toBe('text')
  // A CSV whose first value happens to start with "<" is still a CSV.
  expect(sniff(bytes('<5 years,count\n'))).toBe('text')
})

test('what isn’t a table says what to do instead', () => {
  expect(notATable('pdf', 'statement.csv')).toContain('statement.csv is a PDF')
  expect(notATable('zip', 'budget.xlsx')).toBeNull()
  expect(notATable('zip', 'notes.docx')).toContain('Word document')
  expect(notATable('zip', 'stuff.zip')).toContain('Unzip it')
  expect(notATable('ole', 'old.xls')).toContain('Old .xls files aren’t supported')
  // An encrypted .xlsx is an OLE container too: it's the password, not the age.
  expect(notATable('ole', 'budget.xlsx')).toContain('password-protected')
  expect(notATable('zip', 'big.xlsb')).toContain('.xlsb')
  expect(notATable('text', 'a.csv')).toBeNull()
  expect(notATable('html', 'a.xls')).toBeNull()
})

test('a report’s title lines without separators are found above its table', async () => {
  const { titleLines } = await import('../../src/engine/sniff')
  const qb = ['Sales by Customer Detail', 'Acme Inc', 'January - June 2024', '', ',Date,Transaction Type,Num,Amount', 'Wayne Enterprises,,,,', ',06/18/2024,Sales Receipt,1001,"1,200.00"', ',06/19/2024,Invoice,1002,300.00', 'Total for Wayne Enterprises,,,,"1,500.00"'].join('\n')
  expect(titleLines(qb)).toEqual({ sep: ',', skip: 4 })
  // A plain table: nothing above its names.
  expect(titleLines('a,b\n1,2\n3,4\n')).toBe(null)
  expect(titleLines('just one line of text\nand another\n')).toBe(null)
})

test('rows ending in a trailing separator aren’t a header with title lines above it', async () => {
  const { titleLines } = await import('../../src/engine/sniff')
  const trailing = ['Date,Narration,Amount', '2024-01-01,Item 0,0,', '2024-01-02,Item 1,1,', '2024-01-03,Item 2,2,'].join('\n')
  expect(titleLines(trailing)).toBe(null)
})

test('a zip says what it holds: a workbook named .csv opens, a Word file renamed is named as one', async () => {
  const { zipInside, notATable } = await import('../../src/engine/sniff')
  const zip = (...names: string[]) => new TextEncoder().encode(`PK\x03\x04....${names.join('....')}`)
  expect(zipInside(zip('[Content_Types].xml', 'xl/workbook.xml'))).toBe('xlsx')
  expect(zipInside(zip('[Content_Types].xml', 'word/document.xml'))).toBe('docx')
  expect(zipInside(zip('mimetypeapplication/vnd.oasis.opendocument.spreadsheet'))).toBe('ods')
  expect(zipInside(zip('data.csv'))).toBe(null)
  expect(notATable('zip', 'budget export.csv', 'xlsx')).toBe(null)
  expect(notATable('zip', 'report.csv', 'docx')).toContain('is a Word document')
  expect(notATable('zip', 'archive.csv', null)).toContain('is a zip archive')
  // An Excel binary workbook has xl/ too; a Word file renamed .xlsx is still a Word file.
  expect(zipInside(zip('[Content_Types].xml', 'xl/workbook.bin', 'xl/worksheets/sheet1.bin'))).toBe('xlsb')
  expect(notATable('zip', 'book.xlsb', 'xlsb')).toContain('Excel binary workbook')
  expect(notATable('zip', 'report.xlsx', 'docx')).toContain('is a Word document')
  expect(notATable('zip', 'report.xlsx', null)).toBe(null)
})

test('UTF-8 or not: a £ written by Excel on Windows is one byte, not two', async () => {
  const { isUtf8 } = await import('../../src/engine/sniff')
  expect(isUtf8(new TextEncoder().encode('name,price\nRené,£12.50\n'))).toBe(true)
  expect(isUtf8(new Uint8Array([0x52, 0x65, 0x6e, 0xe9, 0x2c, 0xa3, 0x31]))).toBe(false) // René,£1 in Windows-1252
  expect(isUtf8(new TextEncoder().encode('£').slice(0, 1))).toBe(true) // cut off at the end of the slice
})

test('a report whose names are its first line, with group lines among its rows, is read by its separator when asked', async () => {
  const { titleLines } = await import('../../src/engine/sniff')
  const qb = [',Date,Type,Num,Amount', 'Acme Corp', ',06/10/2024,Invoice,1000,100.00', 'Total for Acme Corp,,,,100.00', 'Globex LLC', ',06/11/2024,Invoice,1001,50.00'].join('\r\n')
  expect(titleLines(qb)).toBe(null)
  expect(titleLines(qb, true)).toEqual({ sep: ',', skip: 0 })
})
