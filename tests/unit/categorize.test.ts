import { expect, test } from '@playwright/test'
import { categorizeExpr, categoryName, knownCategory, suggestRules, wordsSql } from '../../src/engine/categorize'
import { q } from './duck'

test('rules become a CASE: the first rule with a word wins, matched where a word starts, case ignored', async () => {
  await q(`CREATE OR REPLACE TABLE nar AS SELECT * FROM (VALUES
    ('UPI-SWIGGY-swiggy@icici-Payment'), ('UPI/OLACABS/ola@axis'), ('POS COLA FACTORY'), ('NEFT CR-ACME SOLUTIONS-SALARY'),
    ('ATM WDL-HDFC ATM KORAMANGALA'), ('Zomato order 1.5+tip'), (NULL), ('UPI_ZOMATO_order'), ('HDFC0MERCAH'), ('ÀOLA'), ('भुगतान स्विगी')
  ) t("Narration")`)
  const expr = categorizeExpr({
    column: 'Narration',
    rules: [
      { category: 'Food', words: ['swiggy', ' Zomato ', '', 'स्विगी'] },
      { category: 'Merchant', words: ['mercah'] },
      { category: 'Travel', words: ['ola'] },
      { category: 'Salary', words: ['salary'] },
      { category: '  ', words: ['atm'] }, // no name: left out
      { category: 'Odd', words: ['1.5+'] }, // symbols are matched as written, not as a pattern
    ],
    otherwise: 'Other',
  })
  expect(expr).toContain("regexp_matches(\"Narration\"::VARCHAR, '((?:^|[^\\pL\\pM])swiggy|(?:^|[^\\pL\\pM])zomato|(?:^|[^\\pL\\pM])स्विगी)', 'i') THEN 'Food'")
  // A word starts after anything but a letter (a digit, _, -), in any script: ZOMATO in UPI_ZOMATO, not OLA in ÀOLA.
  expect((await q(`SELECT ${expr} AS c FROM nar`)).map((r) => r.c)).toEqual(['Food', 'Travel', 'Other', 'Salary', 'Other', 'Food', 'Other', 'Food', 'Merchant', 'Other', 'Food'])
  expect(categorizeExpr({ column: 'Narration', rules: [] })).toBe('NULL')
})

test('the words a column has, without the payment rails and banks; known ones suggest categories', async () => {
  await q(`CREATE OR REPLACE TABLE nar2 AS SELECT * FROM (VALUES
    ('UPI-SWIGGY-swiggy@icici'), ('UPI-SWIGGY-order'), ('UPI-UBER-trip'), ('NEFT-HDFC-RENT JUNE'), ('UPI-Mystery Shop'), ('POS CAFÉ_ÉCOLE'),
    ('NEFT-SBIN0001234-ACME'), ('UPI-BHARATPE09897654321@ybl'), ('AMAZON0001234 PURCHASE')
  ) t(narration)`)
  const words = (await q(wordsSql('nar2', 'narration'))).map((r) => [r.word, r.rows])
  expect(words[0]).toEqual(['swiggy', 2])
  expect(words.map((w) => w[0])).not.toContain('upi')
  expect(words.map((w) => w[0])).not.toContain('icici')
  expect(words.map((w) => w[0])).toContain('mystery')
  // Words in any script, whole: café and école, not caf and cole.
  expect(words.map((w) => w[0])).toEqual(expect.arrayContaining(['café', 'école']))
  // A bank's branch code (SBIN0001234) is left out whole; a merchant's name that runs into digits isn't cut.
  expect(words.map((w) => w[0])).toEqual(expect.arrayContaining(['acme', 'bharatpe', 'amazon']))
  expect(words.map((w) => w[0])).not.toContain('sbin')
  expect(words.map((w) => w[0])).not.toContain('bhar')
  // A charge is a charge, whatever it's for.
  expect(suggestRules(['atm', 'chgs', 'gst']).map((r) => r.category)).toEqual(['Charges and fees', 'Cash withdrawals', 'GST and taxes'])
  expect(knownCategory('UBER')).toBe('Travel')
  expect(suggestRules(['swiggy', 'uber', 'rent', 'mystery', 'zomato'])).toEqual([
    { category: 'Food and dining', words: ['swiggy', 'zomato'] },
    { category: 'Travel', words: ['uber'] },
    { category: 'Rent', words: ['rent'] },
  ])
  expect(categoryName(['Date', 'category'])).toBe('category_2')
})
