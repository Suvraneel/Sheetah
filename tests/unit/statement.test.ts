import { expect, test } from '@playwright/test'
import { signedAmount, statementColumns } from '../../src/engine/statement'
import { balanceCheckSql, readBalanceCheck } from '../../src/engine/statement-check'
import { q } from './duck'

const col = (name: string, type = 'VARCHAR') => ({ name, type })

test('a statement is known by its money-in and money-out columns', () => {
  expect(statementColumns([col('Date'), col('Narration'), col('Withdrawal Amt.'), col('Deposit Amt.'), col('Closing Balance')])).toEqual({
    credit: 'Deposit Amt.',
    debit: 'Withdrawal Amt.',
    balance: 'Closing Balance',
  })
  expect(statementColumns([col('Debit', 'DOUBLE'), col('Credit', 'DOUBLE')])).toEqual({ credit: 'Credit', debit: 'Debit' })
  // A card number or a column that only names a type isn't money.
  expect(statementColumns([col('Credit Card No'), col('Debit')])).toBeNull()
  expect(statementColumns([col('Amount', 'DOUBLE'), col('Dr/Cr')])).toBeNull()
})

test('the signed amount is money in less money out, and the balances are checked either way round', async () => {
  const s = { credit: 'deposit', debit: 'withdrawal', balance: 'balance' }
  const isNum = () => false
  // Oldest first, amounts as text (the way banks export them), one opening line without amounts.
  await q(`CREATE OR REPLACE TABLE st AS SELECT * FROM (VALUES
    (NULL, NULL, '10,000.00'), ('500.00', NULL, '9,500.00'), (NULL, '2,000.00', '11,500.00'), ('1,500.00', NULL, '10,000.00')
  ) t(withdrawal, deposit, balance)`)
  expect((await q(`SELECT ${signedAmount(s, isNum)} AS a FROM st`)).map((r) => r.a)).toEqual([0, -500, 2000, -1500])
  expect(readBalanceCheck((await q(balanceCheckSql('st', s, isNum)))[0] as Record<string, number>)).toEqual({ pairs: 3, bad: 0, order: 'oldest first' })
  // Newest first, the same statement with its 500.00 withdrawal line missing: row 2 doesn't follow.
  await q(`CREATE OR REPLACE TABLE st2 AS SELECT * FROM (VALUES
    ('1,500.00', NULL, '10,000.00'), (NULL, '2,000.00', '11,500.00'), (NULL, NULL, '10,000.00')
  ) t(withdrawal, deposit, balance)`)
  expect(readBalanceCheck((await q(balanceCheckSql('st2', s, isNum)))[0] as Record<string, number>)).toEqual({
    pairs: 2,
    bad: 1,
    order: 'newest first',
    firstBad: { row: 2, off: -500 },
  })
})
