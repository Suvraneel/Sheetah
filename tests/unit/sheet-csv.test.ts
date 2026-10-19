import { expect, test } from '@playwright/test'
import { headerRow, sheetToCsv } from '../../src/engine/sheet-csv'

/*
 * Excel sheets → CSV: report exports often have a company name, a title and a date range above the
 * column names. Those lines are left out; anything less clear-cut keeps the first row as the header.
 */
test('title lines above the column names are left out', () => {
  const data = [
    ['ABC Traders Pvt Ltd', null, null],
    ['Sales Register', null, null],
    ['1-Apr-2024 to 30-Apr-2024', null, null],
    [null, null, null],
    ['Invoice', 'Customer', 'Amount'],
    ['INV-1', 'Asha', 1200],
    ['INV-2', 'Ravi', 800],
  ]
  // Three title lines (the blank row between them and the names isn't one).
  expect(sheetToCsv(data)).toEqual({ csv: 'Invoice,Customer,Amount\nINV-1,Asha,1200\nINV-2,Ravi,800', rows: 2, skipped: 3, text: [] })
  // Month and year headers that Excel stores as dates and numbers are column names too.
  const months = [['Branch sales FY25', null, null, null], ['Branch', new Date(Date.UTC(2024, 3, 1)), new Date(Date.UTC(2024, 4, 1)), 2025], ['Pune', 1, 2, 3]]
  expect(sheetToCsv(months).csv.split('\n')[0]).toBe('Branch,2024-04-01,2024-05-01,2025')
})

test('an ordinary sheet keeps its first row as the header', () => {
  expect(headerRow([['id', 'name'], [1, 'Asha']], 2)).toBe(0)
  // Numbers under one title cell: not column names, so nothing is skipped.
  expect(headerRow([['Totals', null], [1, 2], [3, 4]], 2)).toBe(0)
  // Two cells in the first row is a (sparse) header, not a title.
  expect(headerRow([['name', null, 'city', null], ['Asha', 'x', 'Pune', 'y']], 4)).toBe(0)
  // Repeated names aren't a header row.
  expect(headerRow([['Report', null], ['a', 'a'], ['b', 'c']], 2)).toBe(0)
  // A one-column sheet is left alone.
  expect(headerRow([['Report'], ['a'], ['b']], 1)).toBe(0)
})

test('dates and text with commas are written as CSV values', () => {
  const { csv } = sheetToCsv([['when', 'note'], [new Date(Date.UTC(2024, 7, 15)), 'a, b'], [new Date(Date.UTC(2024, 7, 15, 10, 30)), ' padded']])
  expect(csv).toBe('when,note\n2024-08-15,"a, b"\n2024-08-15 10:30:00," padded"')
})

test('a header in two rows (a group merged over its columns) is read as one: Sales Units, Sales Price', async () => {
  const { twoRowHeader } = await import('../../src/engine/sheet-csv')
  const data = [
    ['Region', 'Sales', null, 'Returns', null],
    [null, 'Units', 'Price', 'Units', 'Price'],
    ['North', 10, 2.5, 1, 2.5],
    ['South', 7, 3, 0, 3],
  ]
  expect(sheetToCsv(data)).toEqual({ csv: 'Region,Sales Units,Sales Price,Returns Units,Returns Price\nNorth,10,2.5,1,2.5\nSouth,7,3,0,3', rows: 2, skipped: 0, text: [] })
  // A first row of data that happens to be text is data, not names.
  expect(twoRowHeader([['Name', null, 'City'], ['Asha', 'x', 'Pune'], ['Ravi', 'y', 'Goa']], 0, 3)).toBe(null)
  expect(twoRowHeader([['id', 'name', 'amount'], [1, 'Asha', 10], [2, 'Ravi', 20]], 0, 3)).toBe(null)
  // A first data row of notes ("TBD", "call back") under a header with an empty name: data, not names.
  expect(twoRowHeader([['Customer', 'City', 'Amount', null], ['Acme Ltd', 'Pune', 'TBD', 'call back'], ['Beta LLP', 'Goa', 1200, null]], 0, 4)).toBe(null)
})

test('codes Excel holds as text stay text; a time read a millisecond short is the second it is', async () => {
  const data = [
    ['ICCID', 'Part', 'PIN', 'Qty', 'At'],
    ['89911012000032045101', '1E5', '001234', '5', new Date(Date.UTC(2024, 3, 1, 0, 59, 59, 999))],
    ['89911012000032045102', '2E3', '560001', '7', new Date(Date.UTC(2024, 3, 1, 23, 58, 59, 999))],
  ]
  const { csv, text } = sheetToCsv(data)
  // Qty is text in the sheet too, but nothing about it changes as a number: read as one.
  expect(text).toEqual(['ICCID', 'Part', 'PIN'])
  expect(csv.split('\n')[1]).toBe('89911012000032045101,1E5,001234,5,2024-04-01 01:00:00')
  expect(csv.split('\n')[2]).toBe('89911012000032045102,2E3,560001,7,2024-04-01 23:59:00')
})

test('a measurement written 1.2E-05 as text is still a number; two columns of the same name don’t trip the reader', async () => {
  const { text } = sheetToCsv([
    ['Sample', 'Conc', 'Code'],
    ['A', '1.2E-05', '5E3'],
    ['B', '0.0034', '7E1'],
  ])
  expect(text).toEqual(['Code'])
})
