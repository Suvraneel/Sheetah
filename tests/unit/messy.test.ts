import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Clean } from '../../src/engine/clean'
import { eitherJunk, junkPredicates, readStats, statsSql, suggestCleaning } from '../../src/engine/clean-scan'
import { compose, emptyOps } from '../../src/engine/compose'
import { messyCsv } from '../../src/engine/messy'
import { q } from './duck'

/*
 * The messy sample is a showcase: opened like any file, every clean-up it is there to show must be
 * found, and once applied the numbers must add up to the report's own Grand Total.
 */
test('the messy sample cleans up into numbers that match its own grand total', async () => {
  const path = join(tmpdir(), `messy-${process.pid}.csv`)
  writeFileSync(path, messyCsv())
  await q(`CREATE OR REPLACE TABLE messy AS SELECT * FROM read_csv_auto('${path}', header = true)`)
  const cols = await q(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = 'messy' ORDER BY ordinal_position`)
  expect(cols.every((c) => c.type === 'VARCHAR')).toBe(true)

  const p = junkPredicates(cols.map((c) => ({ ref: `"${c.name}"`, text: true })))
  const totals = eitherJunk(p.strong!, p.weak!)
  const [junk] = await q(`SELECT count(*) FILTER (WHERE ${p.blank.drop})::INT AS blank, count(*) FILTER (WHERE ${totals.drop})::INT AS total, count(*)::INT AS n FROM messy`)
  expect(junk).toEqual({ blank: 3, total: 4, n: 23 })

  const refs = cols.map((c) => `"${c.name}"`)
  const [row] = await q(statsSql('messy', refs))
  const pick = (name: string) => suggestCleaning(name, readStats(row, refs.indexOf(`"${name}"`)), 'en-IN').map((s) => s.clean)
  const conversions = ['Invoice Date', 'Taxable Value', 'GST %', 'Invoice Total'].map((n) => pick(n).find((c) => ['number', 'percent', 'date'].includes(c.kind)))
  expect(conversions.map((c) => c && `${c.kind}${c.format ? ` ${c.format}` : ''}`)).toEqual(['date %d-%b-%Y', 'number', 'percent', 'number'])

  const clean: Clean[] = [{ column: 'Region', kind: 'filldown' }, ...(conversions as Clean[])]
  const sql = compose('SELECT * FROM messy', {
    ...emptyOps(),
    drop: [
      { label: 'totals', keep: totals.keep },
      { label: 'empty', keep: p.blank.keep },
    ],
    clean,
  })
  const [sums] = await q(`SELECT count(*)::INT AS n, sum("Taxable Value") AS taxable, count(DISTINCT "Region")::INT AS regions, min("Invoice Date")::VARCHAR AS first FROM (${sql})`)
  const [grand] = await q(`SELECT number_from_text("Taxable Value") AS taxable FROM messy WHERE "Region" = 'Grand Total'`)
  expect(sums).toEqual({ n: 16, taxable: grand.taxable, regions: 3, first: '2024-04-01' })
})
