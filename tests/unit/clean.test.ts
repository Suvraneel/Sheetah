import { expect, test } from '@playwright/test'
import { addClean, percentColumns, cleanExpr, describeClean, cleanSql, type Clean } from '../../src/engine/clean'
import { dataSumsSql, fillDownSql, looksFilledDown, labelSumsSql, totalsAgree, eitherJunk, junkPredicates, confidentConversion, readStats, statsSql, maybeNumbersSql, suggestCleaning, decimalsSql, fileDecimalComma } from '../../src/engine/clean-scan'
import { compose, emptyOps } from '../../src/engine/compose'
import { q } from './duck'

/** Cleans a list of text values with one step and returns the results as text (null for empty). */
async function clean(c: Omit<Clean, 'column'>, values: (string | null)[]) {
  const list = values.map((v) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)).join(', ')
  const rows = await q(`SELECT (${cleanExpr({ column: 'v', ...c })})::VARCHAR AS out FROM (SELECT unnest([${list}]::VARCHAR[]) AS v)`)
  return rows.map((r) => r.out)
}

async function suggestionsFor(values: string[], locale?: string, column = 'v') {
  await q(`CREATE OR REPLACE TABLE cl AS SELECT unnest([${values.map((v) => `'${v}'`).join(', ')}]) AS "${column}"`)
  const [row] = await q(statsSql('cl', [`"${column}"`]))
  return suggestCleaning(column, readStats(row, 0), locale)
}

test.describe('clean a column (run on DuckDB)', () => {
  test('numbers stored as text: currency, separators, Indian grouping, accounting negatives', async () => {
    expect(await clean({ kind: 'number' }, ['₹ 1,234.50', '$99', ' 12 ', '1,00,000', '(1,200)', 'n/a', null])).toEqual(['1234.5', '99.0', '12.0', '100000.0', '-1200.0', null, null])
    expect(await clean({ kind: 'percent' }, ['12%', '7.5 %'])).toEqual(['0.12', '0.075'])
    // A statistics office's figures: marks after them, thousands grouped by spaces; placeholders stay empty.
    expect(await clean({ kind: 'number' }, ['92,338[note 3]', '108,021 (p)', '56*', '1 234 567', '55 259 929.5', 'x', '..', '[x]', '98200 12345'])).toEqual([
      '92338.0', '108021.0', '56.0', '1234567.0', '55259929.5', null, null, null, null,
    ])
    expect(await clean({ kind: 'number', comma: true }, ['1 234,5 (r)', '718.420[note 1]'])).toEqual(['1234.5', '718420.0'])
    // Several marks; marks after a percent sign; a negative in brackets with a mark.
    expect(await clean({ kind: 'number' }, ['1,234 [note 3] (p)', '(250) (p)'])).toEqual(['1234.0', '-250.0'])
    expect(await clean({ kind: 'percent' }, ['12.5% (p)', '12.5%*'])).toEqual(['0.125', '0.125'])
  })

  test('a separator in the wrong place is never read as a thousands separator', async () => {
    // "12,5" is twelve and a half somewhere: never 125.
    expect(await clean({ kind: 'number' }, ['12,5', '1,2345', '15,10'])).toEqual([null, null, null])
    expect(await clean({ kind: 'number', comma: true }, ['12,5', '1.234,56', '€ 1 234,5', '(3,25)', '1.5'])).toEqual(['12.5', '1234.56', '1234.5', '-3.25', null])
    expect(await clean({ kind: 'percent', comma: true }, ['12,5 %'])).toEqual(['0.125'])
  })

  test('dates stored as text, in the layout they were written in; two-digit years only with a two-digit format', async () => {
    expect(await clean({ kind: 'date', format: '%d/%m/%Y' }, ['15/08/2024', '03/04/2024', 'soon', '15/08/24'])).toEqual(['2024-08-15', '2024-04-03', null, null])
    expect(await clean({ kind: 'date', format: '%d/%m/%y' }, ['15/08/24', '31/12/99', '15/08/65', '01/01/30', '31/12/29'])).toEqual([
      '2024-08-15',
      '1999-12-31',
      '1965-08-15',
      '1930-01-01',
      '2029-12-31',
    ])
    expect(await clean({ kind: 'date', format: '%d-%b-%y' }, ['5-Jan-25'])).toEqual(['2025-01-05'])
    // Month names (one column per month, unpivoted) become the first of the month.
    expect(await clean({ kind: 'date', format: '%b-%y' }, ['Apr-24', 'Mar-25', 'Sept-24'])).toEqual(['2024-04-01', '2025-03-01', null])
    expect(await clean({ kind: 'date', format: '%Y-%m' }, ['2024-04', '2024-04-15'])).toEqual(['2024-04-01', null])
  })

  test('spaces, case and blanks', async () => {
    expect(await clean({ kind: 'trim' }, ['  Asha   Rao ', '   ', 'ok'])).toEqual(['Asha Rao', null, 'ok'])
    expect(await clean({ kind: 'title' }, ['aSHA rao', null])).toEqual(['Asha Rao', null])
    expect(await clean({ kind: 'blank' }, ['', ' ', 'x'])).toEqual([null, null, 'x'])
  })

  test('suggestions follow the data', async () => {
    expect((await suggestionsFor(['₹1,200', '₹950', '₹3,400'])).map((s) => s.label)).toEqual(['Convert to number'])
    expect((await suggestionsFor(['12.5', '3', 'pending', '4', '5', '6', '7', '8', '9', '10']))[0]).toMatchObject({ label: 'Convert to number', note: expect.stringContaining('1 of 10') })
    expect((await suggestionsFor(['10%', '12.5%'])).map((s) => s.clean.kind)).toEqual(['percent'])
    // A day above 12 settles the layout; otherwise both are offered, the reader's own first.
    expect((await suggestionsFor(['25/01/2024', '03/02/2024'])).map((s) => s.clean.format)).toEqual(['%d/%m/%Y'])
    expect((await suggestionsFor(['03/02/2024', '04/05/2024'], 'en-US')).map((s) => s.clean.format)).toEqual(['%m/%d/%Y', '%d/%m/%Y'])
    expect((await suggestionsFor(['03/02/2024', '04/05/2024'], 'en-IN')).map((s) => s.clean.format)).toEqual(['%d/%m/%Y', '%m/%d/%Y'])
    expect((await suggestionsFor([' Pune', 'Goa'])).map((s) => s.clean.kind)).toEqual(['trim'])
    expect(await suggestionsFor(['Pune', 'Goa'])).toEqual([])
  })

  test('two-digit years are read as two-digit years, never as the year 24', async () => {
    const s = await suggestionsFor(['15/08/24', '01/02/23', '31/12/99'])
    expect(s.map((x) => x.clean.format)).toEqual(['%d/%m/%y'])
    expect(await suggestionsFor(['24-08-15', '23-01-02']).then((x) => x.filter((y) => y.clean.format?.includes('%Y')))).toEqual([])
  })

  test('decimal commas: settled by the data, then by the reader’s locale', async () => {
    const de = await suggestionsFor(['12,5', '3,25', '100,0'])
    expect(de[0]).toMatchObject({ clean: { kind: 'number', comma: true }, label: 'Convert to number (decimal comma)' })
    expect((await suggestionsFor(['1.234,56', '€ 7,10'])).map((s) => s.clean.comma)).toEqual([true])
    expect((await suggestionsFor(['1,234', '5,678'], 'de-DE'))[0].clean.comma).toBe(true)
    // …but said, and never one click: a UK file's 194,661 in a German browser would be 1000× too small.
    const uk = await suggestionsFor(['194,661', '61,234', '12'], 'de-DE')
    expect(uk[0].note).toContain('read with a decimal comma')
    expect(confidentConversion(uk)).toBeNull()
    expect(confidentConversion(await suggestionsFor(['194,661', '12'], 'en-GB'))).toMatchObject({ kind: 'number', comma: false })
    expect((await suggestionsFor(['1,234', '5,678'], 'en-IN'))[0].clean.comma).toBe(false)
    expect((await suggestionsFor(['1,234', '5.5'], 'de-DE'))[0].clean.comma).toBe(false)
    // 0,750 and 1,2345 are never a thousands separator: kilograms to three places are decimals.
    expect((await suggestionsFor(['1,500', '0,750', '10,125'], 'en-GB'))[0].clean.comma).toBe(true)
    expect((await suggestionsFor(['1,500', '1,2345'], 'en-GB'))[0].clean.comma).toBe(true)
    expect((await suggestionsFor(['1.500', '0.750'], 'de-DE'))[0].clean.comma).toBe(false)
  })

  test('a column that can’t tell is read the way the file’s other columns write decimals', async () => {
    await q(`CREATE OR REPLACE TABLE eu AS SELECT * FROM (VALUES ('1,500', '2,49'), ('10,125', '1,99')) t(kg, preis)`)
    const [row] = await q(decimalsSql('eu', ['"kg"', '"preis"']))
    const file = fileDecimalComma([{ name: 'kg', s: readStats(row, 0) }, { name: 'preis', s: readStats(row, 1) }])
    expect(file).toBe(true)
    const [kg] = await q(statsSql('eu', ['"kg"']))
    expect(suggestCleaning('kg', readStats(kg, 0), 'en-GB', true, file)[0].clean.comma).toBe(true)
    expect(suggestCleaning('kg', readStats(kg, 0), 'en-GB')[0].clean.comma).toBe(false)
    const n = (pointOnly: number, commaOnly: number) => ({ values: 4, numbers: 4, commaNumbers: 4, pointOnly, commaOnly })
    expect(fileDecimalComma([{ name: 'a', s: n(2, 0) }, { name: 'b', s: n(0, 3) }])).toBe(undefined)
    expect(fileDecimalComma([{ name: 'a', s: n(0, 0) }])).toBe(undefined)
    // Codes in a cell (two phone numbers, a list of invoice numbers) say nothing about decimals.
    await q(`CREATE OR REPLACE TABLE codes AS SELECT * FROM (VALUES ('9876543210,9123456780', '1001,1002', 'Acme'), ('9876500000', '1003', 'Beta')) t(phones, refs, customer)`)
    const [c] = await q(decimalsSql('codes', ['"phones"', '"refs"', '"customer"']))
    expect(fileDecimalComma(['phones', 'refs', 'customer'].map((name, i) => ({ name, s: readStats(c, i) })))).toBe(undefined)
    expect(readStats(c, 0).commaOnly + readStats(c, 1).commaOnly).toBe(0)
  })

  test('cleaning composes first, so filters and sorting see the converted values', async () => {
    await q(`CREATE OR REPLACE TABLE prices AS SELECT * FROM (VALUES ('A', '₹1,200'), ('B', '₹950'), ('C', '₹10,000')) t(item, price)`)
    const sql = compose('SELECT * FROM prices', {
      ...emptyOps(),
      clean: [{ column: 'price', kind: 'number' }],
      filters: [{ column: 'price', op: 'gt', value: '1000', numeric: true, type: 'DOUBLE' }],
      sort: { column: 'price', dir: 'desc' },
    })
    expect(sql).toContain('SELECT * REPLACE (')
    expect(await q(sql)).toEqual([
      { item: 'C', price: 10000 },
      { item: 'A', price: 1200 },
    ])
    expect(cleanSql('t', [])).toBe('SELECT * FROM t')
  })

  test('steps on one column stack in order: trim, then case, conversion last', async () => {
    await q(`CREATE OR REPLACE TABLE names AS SELECT * FROM (VALUES ('  aSHA   rao ', ' 1,200 ')) t(who, amount)`)
    let list: Clean[] = []
    list = addClean(list, { column: 'amount', kind: 'number' })
    list = addClean(list, { column: 'who', kind: 'trim' })
    list = addClean(list, { column: 'who', kind: 'upper' })
    list = addClean(list, { column: 'who', kind: 'title' }) // replaces UPPER
    list = addClean(list, { column: 'amount', kind: 'trim' }) // goes before the conversion
    expect(list.map((c) => `${c.column}:${c.kind}`)).toEqual(['who:trim', 'who:title', 'amount:trim', 'amount:number'])
    expect(await q(cleanSql('names', list))).toEqual([{ who: 'Asha Rao', amount: 1200 }])
  })

  test('replacing a value: matched ignoring surrounding spaces, stacked per value, before a conversion', async () => {
    expect(await clean({ kind: 'replace', from: 'Bangalore', to: 'Bengaluru' }, ['Bangalore ', 'BANGALORE', 'Pune', null])).toEqual(['Bengaluru', 'Bengaluru', 'Pune', null])
    expect(await clean({ kind: 'replace', from: 'N/A', to: null }, ['N/A', 'x'])).toEqual([null, 'x'])
    let list: Clean[] = []
    list = addClean(list, { column: 'amount', kind: 'number' })
    list = addClean(list, { column: 'amount', kind: 'replace', from: 'nil', to: '0' })
    list = addClean(list, { column: 'amount', kind: 'replace', from: 'N/A', to: null })
    list = addClean(list, { column: 'amount', kind: 'replace', from: 'nil ', to: '-1' }) // the same value again: replaces the step
    expect(list.map((c) => `${c.kind}:${c.from ?? ''}:${c.to ?? ''}`)).toEqual(['replace:nil :-1', 'replace:N/A:', 'number::'])
    expect(describeClean(list[1])).toBe('amount “N/A” → empty')
    await q(`CREATE OR REPLACE TABLE amounts AS SELECT unnest(['1,200', 'nil', 'N/A']) AS amount`)
    expect((await q(cleanSql('amounts', list))).map((r) => r.amount)).toEqual([1200, -1, null])
  })
})

test.describe('what counts as numbers stored as text', () => {
  test('codes with leading zeros and phone numbers are left alone', async () => {
    const zeros = await suggestionsFor(['007', '012', '345'])
    expect(zeros[0].note).toContain('start with 0')
    expect(confidentConversion(zeros)).toBeNull()
    expect((await suggestionsFor(['98200 12345', '98201 00000'])).filter((s) => s.clean.kind !== 'trim')).toEqual([])
  })

  test('a whole column of amounts is converted with confidence, unless its name says it is a code', async () => {
    const amounts = await suggestionsFor(['1,200', '950'])
    expect(confidentConversion(amounts)).toEqual({ column: 'v', kind: 'number', comma: false })
    for (const name of ['pin_code', 'Mobile No', 'Phone Number', 'Order ID', 'customerId']) {
      expect(confidentConversion(await suggestionsFor(['1200', '950'], 'en-IN', name)), name).toBeNull()
    }
  })

  test('dates that read both ways convert in one click the reader’s way; a column of other dates isn’t forced', async () => {
    expect(confidentConversion(await suggestionsFor(['01/04/24', '05/04/24', '12/04/24'], 'en-IN'))).toMatchObject({ kind: 'date', format: '%d/%m/%y' })
    expect(confidentConversion(await suggestionsFor(['01/04/2024', '05/04/2024'], 'en-US'))).toMatchObject({ kind: 'date', format: '%m/%d/%Y' })
    expect(confidentConversion(await suggestionsFor(['25/04/24', '30/04/24'], 'en-US'))).toMatchObject({ kind: 'date', format: '%d/%m/%y' })
  })

  test('a column of figures with placeholders (x, .., :) converts in one click; the placeholders become empty, said', async () => {
    const s = await suggestionsFor(['1,200', 'x', '350', '..', ':', '4,100'], 'en-GB')
    expect(s[0]).toMatchObject({ clean: { kind: 'number' }, quiet: true })
    expect(s[0].note).toContain('placeholders for no figure')
    expect(confidentConversion(s)).toMatchObject({ kind: 'number' })
    // Something else among them: still said, never one click.
    expect(confidentConversion(await suggestionsFor(['1,200', 'x', '350', 'pending review', '4,100', '9'], 'en-GB'))).toBeNull()
  })

  test('one query covers every column', async () => {
    await q(`CREATE OR REPLACE TABLE multi AS SELECT * FROM (VALUES ('₹1,200', ' x', '15/08/2024'), ('₹950', 'y', '16/08/2024')) t(a, b, c)`)
    const [row] = await q(statsSql('multi', ['a', 'b', 'c']))
    expect([0, 1, 2].map((i) => suggestCleaning('col', readStats(row, i)).map((s) => s.clean.kind))).toEqual([['number'], ['trim'], ['date']])
  })
})

test('fill down: empty cells take the value above, in the rows’ own order', async () => {
  await q(`CREATE OR REPLACE TABLE report AS SELECT * FROM (VALUES
    (1, 'North', 10), (2, '', 5), (3, NULL, NULL), (4, 'South', 7), (5, '  ', 1), (6, 'East', NULL)) t(id, region, n)`)
  const rows = await q(
    cleanSql('report', [
      { column: 'region', kind: 'filldown' },
      { column: 'n', kind: 'filldown' },
      { column: 'region', kind: 'upper' },
    ]),
  )
  expect(rows).toEqual([
    { id: 1, region: 'NORTH', n: 10 },
    { id: 2, region: 'NORTH', n: 5 },
    { id: 3, region: 'NORTH', n: 5 },
    { id: 4, region: 'SOUTH', n: 7 },
    { id: 5, region: 'SOUTH', n: 1 },
    { id: 6, region: 'EAST', n: 1 },
  ])
})

test('total lines and empty rows are found and left out before cleaning', async () => {
  await q(`CREATE OR REPLACE TABLE rep AS SELECT * FROM (VALUES
    ('North', 'Pens', '10'),
    (NULL, 'Paper', '5'),
    (NULL, NULL, NULL),
    ('Sub-Total', NULL, '15'),
    ('South', 'Pens', '7'),
    ('South Total', NULL, '7'),
    ('  ', '', NULL),
    ('Grand  Total:', NULL, '22'),
    ('Totally', 'Ink', '1'),
    ('Total', 'Diesel', '3'),
    ('West', 'Total', NULL)
  ) t(region, item, qty)`)
  const p = junkPredicates(['region', 'item', 'qty'].map((c) => ({ ref: `"${c}"`, text: true })))
  // The SQL reads as what it does (Sheetah's macros), not as regular expressions.
  expect(p.label!.keep).toBe('NOT is_total_label("region")')
  expect(p.blank.keep).toBe('(has_value("region") OR has_value("item") OR has_value("qty"))')
  const total = eitherJunk(p.strong!, p.weak!)
  const [counts] = await q(`SELECT count(*) FILTER (WHERE ${p.blank.drop})::INT AS blank, count(*) FILTER (WHERE ${p.strong!.drop})::INT AS strong,
    count(*) FILTER (WHERE ${total.drop})::INT AS total, count(*) FILTER (WHERE ${total.keep} AND ${p.blank.keep})::INT AS kept FROM rep`)
  // "Total" filling a whole row (a fuel brand) and "Total" outside the first text column are data.
  expect(counts).toEqual({ blank: 2, strong: 2, total: 3, kept: 6 })
  // Unnamed columns (no names given) keep to the first text column; a first column of dates or codes
  // (dates not converted yet, a Ref. No.) has its label looked for in the next one that names things.
  const named = junkPredicates([
    { ref: '"Date"', text: true, name: 'Date' },
    { ref: '"Particulars"', text: true, name: 'Particulars' },
    { ref: '"Debit"', text: true, name: 'Debit' },
  ])
  expect(named.label!.drop).toBe('(is_total_label("Date") OR is_total_label("Particulars"))')
  expect(junkPredicates([{ ref: '"Ref. No."', text: true, name: 'Ref. No.' }, { ref: '"Party\'s Name"', text: true, name: "Party's Name" }]).label!.keep).toBe(
    '(NOT is_total_label("Ref. No.") AND NOT is_total_label("Party\'s Name"))',
  )
  expect(junkPredicates([{ ref: '"Region"', text: true, name: 'Region' }, { ref: '"Item"', text: true, name: 'Item' }]).label!.drop).toBe('is_total_label("Region")')
  const drop = [
    { label: '3 total lines', keep: total.keep },
    { label: '2 empty rows', keep: p.blank.keep },
  ]
  // Filling down after the empty rows are gone: they don't come back as copies of the row above.
  const rows = await q(compose('SELECT * FROM rep', { ...emptyOps(), drop, clean: [{ column: 'region', kind: 'filldown' }, { column: 'qty', kind: 'number' }] }))
  expect(rows.map((r) => [r.region, r.item, r.qty])).toEqual([
    ['North', 'Pens', 10],
    ['North', 'Paper', 5],
    ['South', 'Pens', 7],
    ['Totally', 'Ink', 1],
    ['Total', 'Diesel', 3],
    ['West', 'Total', null],
  ])
})

test('group names written once per group are told from a column filled in now and then', async () => {
  const verdict = async (col: string) => {
    const [s] = await q(fillDownSql('groups', `"${col}"`, ['"region"', '"phone"', '"late"', '"full"', '"amount"']))
    return looksFilledDown(s as Parameters<typeof looksFilledDown>[0])
  }
  await q(`CREATE OR REPLACE TABLE groups AS SELECT * FROM (VALUES
    ('North', '98200', NULL, 'a', 10), ('', NULL, 'x', 'b', 20), (NULL, '98201', NULL, 'c', 5), ('', '98202', NULL, 'd', 1),
    ('Sub-total', NULL, NULL, '', 36), (NULL, NULL, NULL, NULL, NULL),
    ('South', NULL, 'y', 'e', 7), ('', '98203', NULL, 'f', 8), ('', '98204', NULL, 'g', 9), ('South Total', NULL, NULL, NULL, 24),
    ('Grand Total', NULL, NULL, NULL, 60)
  ) t(region, phone, late, "full", amount)`)
  // The total lines and the empty row between the groups don't count as values or gaps.
  expect(await verdict('region')).toBe(true)
  // A phone number given now and then: values next to each other.
  expect(await verdict('phone')).toBe(false)
  // Nothing on the first row: not a group's name.
  expect(await verdict('late')).toBe(false)
  expect(await verdict('full')).toBe(false)
})

test('percentage columns are found in any SQL that converts them', () => {
  const sql = cleanSql('t', [{ column: 'GST %', kind: 'percent' }, { column: 'rate', kind: 'percent', comma: true }, { column: 'amount', kind: 'number' }])
  expect(percentColumns(sql).sort()).toEqual(['GST %', 'rate'])
  expect(percentColumns('SELECT 1')).toEqual([])
})

test('a plain "Total" line with nothing empty is trusted only when its numbers add up', async () => {
  const check = async (table: string, rows: string, names: string[], numeric: string[] = []) => {
    await q(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM (VALUES ${rows}) t(${names.join(', ')})`)
    const cols = names.map((n) => ({ ref: `"${n}"`, text: !numeric.includes(n), numeric: numeric.includes(n) }))
    const p = junkPredicates(cols)
    const labelSql = labelSumsSql(table, cols, p.label!, p.first!)
    if (!labelSql) return null
    const [t] = await q(labelSql)
    const which = Object.keys(t).filter((k) => typeof t[k] === 'number').map((k) => Number(k.slice(1)))
    if (!which.length) return false
    const [d] = await q(dataSumsSql(table, cols, p.first!, which, `${p.label!.keep} AND ${p.strong!.keep} AND ${p.blank.keep}`))
    return totalsAgree(which.map((i) => ({ t: t[`t${i}`] as number, d: d[`d${i}`] as number })))
  }
  expect(await check('simple', `('North', '1,200'), ('South', '800'), ('Total', '2,000')`, ['region', 'sales'])).toBe(true)
  expect(await check('typed', `('North', 1200), ('South', 800), ('Total', 2000)`, ['region', 'sales'], ['sales'])).toBe(true)
  expect(await check('subtotals', `('a', '1'), ('North Total', '1'), ('b', '2'), ('c', '3'), ('South Total', '5')`, ['region', 'sales'])).toBe(true)
  // Sub-totals and a grand total, all labelled: twice the data.
  expect(await check('with_grand', `('A', 10), ('B', 20), ('North Total', 30), ('C', 5), ('South Total', 5), ('Grand Total', 35)`, ['region', 'sales'], ['sales'])).toBe(true)
  expect(await check('fuel', `('Shell', '100'), ('Total', '98'), ('BP', '99')`, ['brand', 'price'])).toBe(false)
  // Nothing but the label column: nothing to check (and no broken SQL).
  expect(await check('one', `('apple'), ('Total'), (NULL)`, ['fruit'])).toBeNull()
  // Most number columns must agree, not just one.
  expect(totalsAgree([{ t: 30, d: 30 }, { t: 5, d: 9 }, { t: 1, d: 7 }])).toBe(false)
  expect(totalsAgree([{ t: 0, d: 0.004 }])).toBe(false)
})

test('a column of amounts with a footer among them is still offered, saying how many values are lost', async () => {
  const values = ['1,200.00', '350.50', '9,000.00', '75.00', '120.00', 'Opening Balance', 'Closing Balance', '18,000.00']
  await q(`CREATE OR REPLACE TABLE fo AS SELECT unnest([${values.map((v) => `'${v}'`).join(', ')}]) AS "Withdrawal"`)
  const [row] = await q(statsSql('fo', ['"Withdrawal"']))
  const s = suggestCleaning('Withdrawal', readStats(row, 0), 'en-IN')
  expect(s[0]).toMatchObject({ label: 'Convert to number anyway', note: '2 of 8 values aren’t numbers and become empty' })
  // Never the one-click suggestion: that's for columns that are numbers through and through.
  expect(confidentConversion(s)).toBeNull()
})

test('dates read the other way round swap back; a day past the 12th is never made up', async () => {
  const rows = await q(`SELECT (${cleanExpr({ column: 'd', kind: 'swapdm' })})::VARCHAR AS out FROM (SELECT unnest([DATE '2024-02-01', DATE '2024-11-12', DATE '2024-04-13', NULL]) AS d)`)
  expect(rows.map((r) => r.out)).toEqual(['2024-01-02', '2024-12-11', null, null])
})

test('bank-statement amounts marked Cr and Dr read as plus and minus, and the suggestion says so', async () => {
  expect(await clean({ kind: 'number', drcr: true }, ['50,000.00 Cr', '1,200.00 Dr', '300 dr.', '₹75CR', '12', 'Dr Ravi'])).toEqual(['50000.0', '-1200.0', '-300.0', '75.0', '12.0', null])
  // On its own, Cr is crore: never read as a sign unless asked (the plain conversion leaves it unread).
  expect(await clean({ kind: 'number' }, ['₹12 Cr', '1,200.00 Dr'])).toEqual([null, null])
  expect(await suggestionsFor(['₹12 Cr', '₹4 Cr', '₹9 Cr'])).not.toContainEqual(expect.objectContaining({ label: 'Convert to number (Cr +, Dr −)' }))
  const s = await suggestionsFor(['50,000.00 Cr', '1,200.00 Dr', '9,800.00 Cr'])
  expect(s[0]).toMatchObject({ label: 'Convert to number (Cr +, Dr −)', note: expect.stringContaining('Cr counts as plus') })
  // Checked by hand first: never the one-click suggestion.
  expect(confidentConversion(s)).toBeNull()
  // A balance in credit all month is all Cr (SBI, Axis): read as the bank means it when the column is a balance.
  const allCr = ['2,11,150.00 Cr', '2,01,150.00 Cr', '1,99,500.00 Cr']
  expect(await suggestionsFor(allCr, undefined, 'Balance')).toContainEqual(expect.objectContaining({ label: 'Convert to number (Cr +, Dr −)' }))
  expect(await suggestionsFor(allCr, undefined, 'Amount')).not.toContainEqual(expect.objectContaining({ label: 'Convert to number (Cr +, Dr −)' }))
})

test('a report’s “Total for Acme Corp” is a total label; a product called Total Gym is not', async () => {
  const rows = await q(
    `SELECT v, is_total_label(v) AS t FROM (VALUES ('Total for Acme Corp'), ('TOTAL'), ('North Total'), ('Total of Region'), ('Total Gym 2000'), ('Totally')) x(v)`,
  )
  expect(rows.map((r) => [r.v, r.t])).toEqual([
    ['Total for Acme Corp', true],
    ['TOTAL', true],
    ['North Total', true],
    ['Total of Region', true],
    ['Total Gym 2000', false],
    ['Totally', false],
  ])
})

test('a conversion is checked over the whole column: values written another way are counted, placeholders aren’t', async () => {
  const { lossesSql } = await import('../../src/engine/clean-scan')
  const { cleanExpr } = await import('../../src/engine/clean')
  await q(`CREATE OR REPLACE TABLE amounts_far AS SELECT * FROM (VALUES ('₹1,200.00'), ('₹15,00,000.50'), ('n/a'), (''), (NULL), ('Rs. 25,000.00'), ('1,500.00-')) t(amount)`)
  const sql = lossesSql('amounts_far', [{ ref: 'amount', expr: cleanExpr({ column: 'amount', kind: 'number' }) }])
  const [row] = await q(sql)
  // Rs. and a trailing minus are read too: nothing lost; n/a and blanks aren't counted.
  expect(Number(row.l0)).toBe(0)
  await q(`INSERT INTO amounts_far VALUES ('12 apples')`)
  expect(Number((await q(sql))[0].l0)).toBe(1)
  const read = await q(`SELECT list(number_from_text(amount) ORDER BY rowid) AS v FROM amounts_far`)
  expect(JSON.parse(JSON.stringify(read[0].v))).toEqual([1200, 1500000.5, null, null, null, 25000, -1500, null])
  const more = await q(`SELECT number_from_text('INR 7,500') AS a, number_from_text('1,200/-') AS b, number_from_text('USD 99.95') AS c, number_from_text('2024-04-01') AS d`)
  expect(more[0]).toEqual({ a: 7500, b: 1200, c: 99.95, d: null })
  // Not a currency, not a minus: a part number, a year or a range written with a dash.
  const not = await q(`SELECT number_from_text('RS-485') AS a, number_from_text('RS232') AS b, number_from_text('2024-') AS c, number_from_text('60-') AS d, number_from_text_comma('1.500,00-') AS e`)
  expect(not[0]).toEqual({ a: null, b: null, c: null, d: null, e: -1500 })
})

test('a column’s counts are the same when only values that could be a number or a date are worked out as one', async () => {
  const values = [
    '₹ 1,234.50', '$99', ' 12 ', '1,00,000', '(1,200)', 'n/a', '92,338[note 3]', '108,021 (p)', '56*', '1 234 567', 'x', '..',
    'Rs. 25,000.00', 'INR 7,500', 'USD 99.95', '1,200/-', '1,500.00-', '50,000.00 Cr', '1,200.00 Dr', '18%', '7,5 %', '1.2E-05',
    '2024-04-01', '01/04/2024', '04-01-2024', '01.04.2024', '2024/04/01', '01 Apr 2024', '01-Apr-2024', 'Apr 01, 2024',
    '1 April 2024', 'September 30, 2024', '01/04/24', '01-Apr-24', 'Apr-24', 'Apr-2024', 'Apr 2024', 'April 2024', '2024-04',
    '007', '0456', 'user_42', 'a@b.c', '10:30', 'INV-0042', 'Pune', '', '  two  spaces ', 'Total', '1,234', '1.234', '12,5', '0,750',
    // What the engine alone would read as a figure (NaN, 1_000), notes with odd characters, and a tab.
    'NaN', 'nan', 'inf', '-Infinity', 'Infinity%', '1_000', '1,234 [note: 3]', '1,234 [a&b]', '1,234 [x?]', 'Rs. 1,200 (provisional)',
    '12,345 [note 12] (estimated)', '(see note) Dr', '01\tApr\t2024',
  ]
  await q(`CREATE OR REPLACE TABLE gates AS SELECT unnest([${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')}]) AS v`)
  const sql = statsSql('gates', ['v'], 1000)
  const [gated] = await q(sql)
  const [every] = await q(sql.replace(/CASE WHEN __(num|date) THEN/g, 'CASE WHEN true THEN'))
  expect(gated).toEqual(every)
  expect(Number(gated.c0_numbers)).toBeGreaterThan(10)
  expect(Number(gated.c0_d0)).toBe(1)
  // A column none of whose values could be a number is counted the quick way, to the same counts; the first
  // look says which columns those are.
  await q(`CREATE OR REPLACE TABLE mails AS SELECT 'p' || range || '@example.com' AS m, ' Pune ' AS city, v FROM range(30), (SELECT v FROM gates LIMIT 1)`)
  const [looks] = await q(maybeNumbersSql('mails', ['m', 'city', 'v']))
  expect(looks).toEqual({ m0: false, m1: false, m2: true })
  expect((await q(statsSql('mails', ['m', 'city'], 5000, [true, true])))[0]).toEqual((await q(statsSql('mails', ['m', 'city'])))[0])
  // A column called __n, __num or __date is counted like any other.
  await q(`CREATE OR REPLACE TABLE odd AS SELECT v AS __n, v AS __num, v AS __date FROM gates`)
  const [odd] = await q(statsSql('odd', ['"__n"', '"__num"', '"__date"'], 1000))
  expect([odd.c0_numbers, odd.c1_numbers, odd.c2_numbers]).toEqual([gated.c0_numbers, gated.c0_numbers, gated.c0_numbers])
})

test('NaN, inf and 1_000 aren’t figures; -Infinity isn’t a date', async () => {
  expect(await clean({ kind: 'number' }, ['NaN', 'inf', '-Infinity', '1_000', '1,234 [note: 3]', '12'])).toEqual([null, null, null, null, '1234.0', '12.0'])
  expect(await clean({ kind: 'percent' }, ['Infinity%', '18%'])).toEqual([null, '0.18'])
  expect(await clean({ kind: 'date', format: '%d/%m/%y' }, ['-Infinity', '01/04/24'])).toEqual([null, '2024-04-01'])
})

test('a column in two date layouts converts each value in its own (never two that read both ways)', async () => {
  const values = [...Array.from({ length: 12 }, (_, i) => `2026-03-${String(i + 10).padStart(2, '0')}`), ...Array.from({ length: 8 }, (_, i) => `${String(i + 13).padStart(2, '0')}/03/2026`)]
  const s = await suggestionsFor(values, 'en-IN')
  const date = s.find((x) => x.clean.kind === 'date')!
  expect(date.clean).toEqual({ column: 'v', kind: 'date', format: '%Y-%m-%d', formats: ['%d/%m/%Y'] })
  expect(date.label).toBe('Convert to date (YYYY-MM-DD or DD/MM/YYYY)')
  expect(date.note).toBeUndefined()
  expect(confidentConversion(s)).toEqual(date.clean)
  expect(await clean({ kind: 'date', format: '%Y-%m-%d', formats: ['%d/%m/%Y'] }, ['2026-03-10', '15/03/2026', 'soon'])).toEqual(['2026-03-10', '2026-03-15', null])
  // DD/MM and MM/DD are one layout read two ways: never put together.
  const us = await suggestionsFor(['01/02/2026', '02/03/2026', '13/01/2026', '01/13/2026'], 'en-IN')
  expect(us.some((x) => x.clean.formats)).toBe(false)
})

