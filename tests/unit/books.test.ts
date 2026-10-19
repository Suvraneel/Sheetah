import { expect, test } from '@playwright/test'
import { ledgerTotalsSql } from '../../src/engine/books'
import { ledgerColumn, statementColumns } from '../../src/engine/statement'
import { q } from './duck'

const col = (name: string, type = 'VARCHAR') => ({ name, type })

test('a day book is summed by ledger: debits, credits, each one’s net, and totals that agree', async () => {
  // Rent paid, a receipt from Acme, an item sale with tax: as Tally's vouchers open (amounts as text here).
  await q(`CREATE OR REPLACE TABLE daybook AS SELECT * FROM (VALUES
    ('1', 'Rent', '25000.00', NULL), ('1', 'HDFC Bank', NULL, '25000.00'),
    ('2', 'Acme Ltd', NULL, '50000.00'), ('2', 'HDFC Bank', '50000.00', NULL),
    ('S-1', 'Sales', NULL, '10000.00'), ('S-1', 'Acme Ltd', '11800.00', NULL), ('S-1', 'Output IGST', NULL, '1800.00')
  ) t("Voucher No", "Ledger", "Debit", "Credit")`)
  const cols = [col('Voucher No'), col('Ledger'), col('Debit'), col('Credit')]
  const s = statementColumns(cols)!
  expect(s.books).toBe(true)
  expect(ledgerColumn(cols)).toBe('Ledger')
  const rows = await q(ledgerTotalsSql('SELECT * FROM daybook', s, 'Ledger', () => false))
  expect(Object.keys(rows[0])).toEqual(['Ledger', 'Debit', 'Credit', 'Net Debit', 'Net Credit'])
  expect(rows.map((r) => [r.Ledger, r.Debit, r.Credit, r['Net Debit'], r['Net Credit']])).toEqual([
    ['Acme Ltd', 11800, 50000, 0, 38200],
    ['HDFC Bank', 50000, 25000, 25000, 0],
    ['Output IGST', 0, 1800, 0, 1800],
    ['Rent', 25000, 0, 25000, 0],
    ['Sales', 0, 10000, 0, 10000],
    ['Total', 86800, 86800, 50000, 50000],
  ])
})

test('the ledger column is the books’ own (not a bank statement’s narration)', () => {
  expect(ledgerColumn([col('Date', 'DATE'), col('Particulars'), col('Debit'), col('Credit')])).toBe(null)
  expect(ledgerColumn([col('Date', 'DATE'), col('Account Name'), col('Debit', 'DOUBLE'), col('Credit', 'DOUBLE')])).toBe('Account Name')
  expect(ledgerColumn([col('Ledger', 'DOUBLE')])).toBe(null)
})
