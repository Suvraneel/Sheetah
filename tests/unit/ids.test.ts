import { expect, test } from '@playwright/test'
import { idCheckSql, idCheckText, idColumns, idOk, readIdRow } from '../../src/engine/ids'
import { q } from './duck'

const col = (name: string, type = 'VARCHAR', numeric = false) => ({ name, type, numeric })

test('columns named for a GSTIN, a PAN or an IFSC code are found; others are not', () => {
  const found = idColumns([
    col('Supplier GSTIN'),
    col('GST No.'),
    col('GSTIN/UIN of Recipient'),
    col('PAN'),
    col('pan_number'),
    col('IFSC Code'),
    // About one, not one: left alone.
    col('GSTIN Status'),
    col('GST Registration Type'),
    col('Is GSTIN Valid'),
    col('Company'),
    col('Panel'),
    col('GST', 'DOUBLE', true),
    col('GST Amount'),
  ])
  expect(found.map((f) => [f.column.name, f.kind])).toEqual([
    ['Supplier GSTIN', 'gstin'],
    ['GST No.', 'gstin'],
    ['GSTIN/UIN of Recipient', 'gstin'],
    ['PAN', 'pan'],
    ['pan_number', 'pan'],
    ['IFSC Code', 'ifsc'],
  ])
})

test('a GSTIN’s check character catches a mistyped one; a PAN and an IFSC code have their shape', async () => {
  const ok = async (kind: 'gstin' | 'pan' | 'ifsc', v: string) => (await q(`SELECT ${idOk(kind, `'${v}'`)} AS ok`))[0].ok
  // The GSTN's own example, and the same with one character changed (its check no longer fits).
  expect(await ok('gstin', '27AAPFU0939F1ZV')).toBe(true)
  expect(await ok('gstin', '24AAACC1206D1ZM')).toBe(true)
  expect(await ok('gstin', '27AAPFU0939F1ZW')).toBe(false)
  expect(await ok('gstin', '27AAPFU0939G1ZV')).toBe(false)
  expect(await ok('gstin', '27AAPFU0939F1Z')).toBe(false)
  // A TDS deductor's, on its TAN (D in 14th place), with its check character.
  expect(await ok('gstin', '07DELA12345B1DE')).toBe(true)
  expect(await ok('pan', 'AAPFU0939F')).toBe(true)
  expect(await ok('pan', 'AAPXU0939F')).toBe(false)
  expect(await ok('ifsc', 'HDFC0001234')).toBe(true)
  expect(await ok('ifsc', 'HDFC1001234')).toBe(false)
})

test('a column’s identifiers are counted and the wrong ones named, in their order', async () => {
  await q(`CREATE OR REPLACE TABLE vendors AS SELECT * FROM (VALUES
    ('27aapfu0939f1zv '), ('27AAPFU0939F1ZW'), (NULL), (''), ('URP'), ('NA'), ('24AAACC1206D1ZM'), ('29ABCDE1234F1Z')
  ) t("Supplier GSTIN")`)
  const c = col('Supplier GSTIN')
  const found = readIdRow(c.name, 'gstin', (await q(idCheckSql('vendors', c, 'gstin')))[0])
  expect(found).toEqual({ column: 'Supplier GSTIN', kind: 'gstin', n: 4, bad: 2, examples: ['27AAPFU0939F1ZW', '29ABCDE1234F1Z'] })
  expect(idCheckText([found])).toEqual({
    kind: 'ids',
    ok: false,
    text: '2 GSTINs in Supplier GSTIN don’t look right (a character mistyped, or the wrong length): 27AAPFU0939F1ZW, 29ABCDE1234F1Z',
  })
  expect(idCheckText([{ column: 'GSTIN', kind: 'gstin', n: 40, bad: 0, examples: [] }, { column: 'PAN', kind: 'pan', n: 38, bad: 0, examples: [] }])).toEqual({
    kind: 'ids',
    ok: true,
    text: 'Every GSTIN and PAN is well formed: GSTIN 40 · PAN 38',
  })
  expect(idCheckText([{ column: 'GSTIN', kind: 'gstin', n: 0, bad: 0, examples: [] }])).toBe(null)
  // A column named only for what it holds isn't said twice.
  expect(idCheckText([{ column: 'GST No.', kind: 'gstin', n: 3, bad: 1, examples: ['27AAPFU0939F1ZW'] }])?.text).toBe('1 GSTIN doesn’t look right (a character mistyped, or the wrong length): 27AAPFU0939F1ZW')
})
