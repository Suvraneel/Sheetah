import { expect, test } from '@playwright/test'
import { lookAlikes } from '../../src/engine/alike'

const v = (value: string, count: number) => ({ value, count })

test('one value written two ways is offered for merging into the common spelling', () => {
  const found = lookAlikes([v('Hyderabad', 40), v('Mumbai', 55), v('Hydrabad', 3), v('new delhi', 2), v('New Delhi', 30), v('Pune', 12)])
  expect(found).toEqual([
    { from: 'Hydrabad', to: 'Hyderabad', fromRows: 3, toRows: 40 },
    { from: 'new delhi', to: 'New Delhi', fromRows: 2, toRows: 30 },
  ])
})

test('different categories, codes and short words are left alone', () => {
  // Both common: two real categories, not a typo.
  expect(lookAlikes([v('Card Sales', 500), v('Cash Sales', 480)])).toEqual([])
  // Codes differ by a digit on purpose.
  expect(lookAlikes([v('INV-0101', 9), v('INV-0102', 1)])).toEqual([])
  // Three letters: too short to call one a typo of the other.
  expect(lookAlikes([v('Cat', 50), v('Car', 1)])).toEqual([])
  expect(lookAlikes([v('North', 50), v('', 3), v(null as unknown as string, 9)])).toEqual([])
})
