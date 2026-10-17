import { expect, test } from '@playwright/test'
import { pastedFile } from '../../src/engine/paste'

test('cells copied from a spreadsheet become a file to open; other text does not', async () => {
  const tsv = pastedFile('Region\tSales\nNorth\t1,200\nSouth\t800\n')
  expect(tsv?.name).toBe('pasted.tsv')
  expect(await tsv?.text()).toContain('North\t1,200')
  expect(pastedFile('id,city\n1,Pune\n2,Goa')?.name).toBe('pasted.csv')
  // One line, a sentence, a pasted query: not a table.
  expect(pastedFile('Region\tSales')).toBeNull()
  expect(pastedFile('Hello, world.\nThis is a note, with commas, here.')).toBeNull()
  expect(pastedFile('SELECT *\nFROM orders')).toBeNull()
})
