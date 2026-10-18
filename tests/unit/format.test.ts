import { expect, test } from '@playwright/test'
import { makeFormatter, share } from '../../src/grid/format'

const col = (name: string, type: string) => ({ name, type, numeric: true })

test.describe('grid number formatting', () => {
  test('whole numbers are grouped exactly, except identifiers and years', () => {
    expect(makeFormatter(col('qty', 'BIGINT'), [])('1234567')).toBe('1,234,567')
    expect(makeFormatter(col('n', 'UBIGINT'), [])('18446744073709551615')).toBe('18,446,744,073,709,551,615')
    expect(makeFormatter(col('order_id', 'BIGINT'), [])('1234567')).toBe('1234567')
    expect(makeFormatter(col('year', 'INTEGER'), [])('2024')).toBe('2024')
    // Whole amounts are money all the same; a count named Total isn't.
    expect(makeFormatter(col('Amount', 'BIGINT'), [])('1200')).toBe('1,200.00')
    expect(makeFormatter(col('Taxable Value', 'INTEGER'), [])('-450')).toBe('-450.00')
    expect(makeFormatter(col('Total Units', 'BIGINT'), [])('1200')).toBe('1,200')
  })

  test('decimals keep their scale; doubles show the decimals the data uses', () => {
    expect(makeFormatter(col('amt', 'DECIMAL(18,2)'), [])('-1234567.50')).toBe('-1,234,567.50')
    const price = makeFormatter(col('price', 'DOUBLE'), ['12.5', '3.25', '8820.0'])
    expect(price('8820.0')).toBe('8,820.00')
    expect(price('12.5')).toBe('12.50')
    const whole = makeFormatter(col('units', 'DOUBLE'), ['8820.0', '12.0'])
    expect(whole('8820.0')).toBe('8,820')
    expect(whole('0.0012')).toBe('0.0012') // small fractions stay readable
    expect(whole('inf')).toBe('inf')
    // Named for money: two decimals even when this column's are whole (beside one with paise).
    expect(makeFormatter(col('Withdrawal Amt.', 'DOUBLE'), ['118000.0'])('118000.0')).toBe('118,000.00')
    expect(makeFormatter(col('Sum of Taxable Value', 'DOUBLE'), ['28800.0'])('28800.0')).toBe('28,800.00')
    expect(makeFormatter(col('Net Qty', 'DOUBLE'), ['150.0'])('150.0')).toBe('150')
  })

  test('midnight-only timestamps show as dates; text is untouched', () => {
    const ts = makeFormatter({ name: 'd', type: 'TIMESTAMP', numeric: false }, ['2024-01-01 00:00:00', '2024-02-01 00:00:00'])
    expect(ts('2024-03-01 00:00:00')).toBe('2024-03-01')
    expect(ts('2024-03-01 10:30:00')).toBe('2024-03-01 10:30:00')
    expect(makeFormatter({ name: 's', type: 'VARCHAR', numeric: false }, [])('1000')).toBe('1000')
  })
})

test('a decimal later in a whole-number column is never rounded away', () => {
  const f = makeFormatter({ name: 'rating', type: 'DOUBLE', numeric: true }, ['0.0', '5.0', '4.0'])
  expect(f('2.5')).toBe('2.5')
  expect(f('1234.4')).toBe('1,234.4')
  expect(f('0.3333333')).toBe('0.3333')
})

test('columns converted from percentages show as percentages; nothing else does', () => {
  const gst = makeFormatter({ ...col('GST %', 'DOUBLE'), percent: true }, ['0.18', '0.05', '0.12'])
  expect(gst('0.18')).toBe('18%')
  expect(gst('0.125')).toBe('12.5%')
  expect(gst('')).toBe('')
  // A share computed by a query (0.42 meaning 0.42%) or whole percentages are never multiplied.
  expect(makeFormatter(col('pct', 'DOUBLE'), ['0.42'])('0.42')).toBe('0.42')
  expect(makeFormatter(col('discount_pct', 'DOUBLE'), ['5.0', '12.0'])('12.0')).toBe('12')
})

test('a share is never said as all or none when it isn’t', () => {
  expect(share(479308, 480673)).toBe('99.7%')
  expect(share(480673, 480673)).toBe('100%')
  expect(share(1, 480673)).toBe('0.1%')
  expect(share(0, 10)).toBe('0%')
  expect(share(1, 3)).toBe('33%')
  expect(share(1, 0)).toBe('')
})
