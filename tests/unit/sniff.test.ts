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
