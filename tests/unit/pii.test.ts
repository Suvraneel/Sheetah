import { expect, test } from '@playwright/test'
import { RULES, actionSql, anonymizeSql, luhn, nameSuggests, verhoeff, type PiiAction, type PiiKind } from '../../src/engine/pii-rules'
import { q } from './duck'

test.describe('personal data rules', () => {
  test('checksums tell real card and Aadhaar numbers from other long numbers', () => {
    expect(luhn('4111 1111 1111 1111')).toBe(true)
    expect(luhn('4111 1111 1111 1112')).toBe(false)
    expect(luhn('1234')).toBe(false)
    expect(verhoeff('2345 6789 0124')).toBe(true)
    expect(verhoeff('2345 6789 0125')).toBe(false)
  })

  test('each action compiles to readable SQL; keep and remove add nothing', () => {
    expect(actionSql('mobile', 'phone', 'mask')).toBe(`'••••••' || right(regexp_replace(mobile::VARCHAR, '[^0-9]', '', 'g'), 4)`)
    expect(actionSql('email', 'email', 'pseudonym')).toBe('pseudonym(email)')
    expect(actionSql('dob', 'birthdate', 'generalize', true)).toBe('year(dob)')
    expect(actionSql('Last IP', 'ip', 'generalize')).toBe(`regexp_replace("Last IP"::VARCHAR, '\\.[0-9]+$', '.0') || '/24'`)
    expect(actionSql('x', null, 'keep')).toBeNull()
    expect(actionSql('x', null, 'remove')).toBeNull()
  })

  test('the query excludes, replaces, and keeps row order when numbering labels', () => {
    const sql = anonymizeSql(
      'SELECT * FROM customers',
      [
        { column: 'notes', kind: null, action: 'remove' },
        { column: 'email', kind: 'email', action: 'pseudonym' },
      ],
      'customers',
    )
    expect(sql).toBe('-- Anonymized copy of customers: 1 pseudonymized, 1 removed\nSELECT * EXCLUDE (notes)\n  REPLACE (\n    pseudonym(email) AS email\n  )\nFROM customers')
    const labelled = anonymizeSql('SELECT a FROM t WHERE b', [{ column: 'name', kind: 'name', action: 'label' }], 't')
    expect(labelled).toContain('EXCLUDE (__row)')
    expect(labelled).toContain('FROM (SELECT *, row_number() OVER () AS __row FROM (\nSELECT a FROM t WHERE b\n))\nORDER BY __row')
  })
})

test.describe('anonymizing (run on DuckDB)', () => {
  test.beforeAll(async () => {
    await q(`SET VARIABLE sheetah_key = 'test-key'`)
    await q(
      `CREATE OR REPLACE TEMP MACRO pseudonym(v) AS CASE WHEN v IS NULL THEN NULL ELSE left(sha256(getvariable('sheetah_key') || lower(trim(v::VARCHAR))), 12) END`,
    )
  })

  const run = async (column: string, kind: PiiKind | null, action: PiiAction, values: string[], temporal = false) => {
    const expr = actionSql(column, kind, action, temporal)!
    const rows = await q(`SELECT (${expr})::VARCHAR AS v FROM (SELECT unnest([${values.map((v) => `'${v}'`).join(', ')}]) AS ${column})`)
    return rows.map((r) => r.v)
  }

  test('masks keep only what identifies the format', async () => {
    expect(await run('email', 'email', 'mask', ['asha.rao@example.in'])).toEqual(['a•••@example.in'])
    expect(await run('mobile', 'phone', 'mask', ['+91 98200 12345'])).toEqual(['••••••2345'])
    expect(await run('pan', 'pan', 'mask', ['abcpe1234f'])).toEqual(['XXXXXX234F'])
    expect(await run('card', 'card', 'mask', ['4111-1111-1111-1111'])).toEqual(['XXXX XXXX XXXX 1111'])
  })

  test('generalizing keeps the coarse part', async () => {
    expect(await run('ip', 'ip', 'generalize', ['192.168.10.42'])).toEqual(['192.168.10.0/24'])
    expect(await run('pin', 'postcode', 'generalize', ['560034'])).toEqual(['560XXX'])
    // Text birth dates in any order give the year; text without one gives nothing rather than a fragment.
    expect(await run('dob', 'birthdate', 'generalize', ['15/08/1990', '1987-02-01', '3 March 2001', 'unknown'])).toEqual(['1990', '1987', '2001', null])
  })

  test('pseudonyms are stable, case-insensitive, and keyed', async () => {
    const [a, b, c] = await run('email', 'email', 'pseudonym', ['Asha@Example.in', ' asha@example.in', 'ravi@example.in'])
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    // Without the key, the plain hash of the value is different: a pseudonym can't be looked up by hashing guesses.
    const [plain] = await q(`SELECT left(sha256('asha@example.in'), 12) AS h`)
    expect(a).not.toBe(plain.h)
  })

  test('the whole query runs, removes and labels, and keeps the row order', async () => {
    await q(`CREATE OR REPLACE TABLE people AS SELECT * FROM (VALUES (1, 'Zoya', 'z@x.in', 'note'), (2, 'Amit', 'a@x.in', 'n'), (3, 'Zoya', 'z@x.in', NULL)) t(id, customer_name, email, notes)`)
    const sql = anonymizeSql(
      'SELECT * FROM people',
      [
        { column: 'customer_name', kind: 'name', action: 'label' },
        { column: 'email', kind: 'email', action: 'mask' },
        { column: 'notes', kind: null, action: 'remove' },
      ],
      'people',
    )
    const rows = await q(sql)
    expect(Object.keys(rows[0])).toEqual(['id', 'customer_name', 'email'])
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3])
    expect(rows[0].customer_name).toBe(rows[2].customer_name)
    expect(rows[0].customer_name).not.toBe(rows[1].customer_name)
    expect(String(rows[1].customer_name)).toMatch(/^Person \d$/)
  })
})

test.describe('which column names count as personal', () => {
  const nameRule = RULES.find((r) => r.kind === 'name')!
  test('names that say whose name it is', () => {
    for (const n of ['name', 'Name', 'first_name', 'LastName', 'Customer Name', 'customerName', 'patient_name', 'nominee_name', 'customer', 'full_name']) expect(nameSuggests(nameRule, n), n).toBe(true)
    for (const n of ['product_name', 'City Name', 'file_name', 'companyName', 'name_of_scheme', 'sheet_name']) expect(nameSuggests(nameRule, n), n).toBe(false)
    const email = RULES.find((r) => r.kind === 'email')!
    expect(['E-mail', 'Email Address', 'customerEmail'].every((n) => nameSuggests(email, n))).toBe(true)
  })
})
