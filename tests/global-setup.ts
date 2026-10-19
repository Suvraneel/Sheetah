import { mkdirSync, writeFileSync as write, existsSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

/** Generates the larger fixtures (kept out of git) into tests/.fixtures. */
export const FIXTURES = join(import.meta.dirname, '.fixtures')

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

/**
 * Writes a fixture only when it isn't there as it should be: a run (the unit tests, say) never rewrites a file
 * another run is reading at that moment.
 */
function writeFileSync(path: string, data: string | Buffer) {
  const want = typeof data === 'string' ? Buffer.from(data) : data
  if (existsSync(path) && readFileSync(path).equals(want)) return
  write(path, want)
}

export default function globalSetup() {
  mkdirSync(FIXTURES, { recursive: true })
  const rand = seeded(3)

  const big = join(FIXTURES, 'big.csv')
  if (!existsSync(big)) {
    const cities = ['Pune', 'Delhi', 'Oslo', 'Lima', '']
    const lines = ['id,name,score,city,note']
    for (let i = 0; i < 300_000; i++) {
      lines.push(`${i},user_${i % 9973},${(rand() * 1000).toFixed(3)},${cities[Math.floor(rand() * 5)]},${i % 50_000 === 0 ? '"has, comma ""quoted"""' : ''}`)
    }
    writeFileSync(big, lines.join('\n') + '\n')
    writeFileSync(join(FIXTURES, 'Sales Report (2024).csv.gz'), gzipSync(lines.slice(0, 20_001).join('\n') + '\n'))
  }

  const sales = (n: number) =>
    ['region,amount', ...Array.from({ length: n }, () => `${['North', 'South', 'West'][Math.floor(rand() * 3)]},${(rand() * 100).toFixed(2)}`)].join('\n') + '\n'
  writeFileSync(join(FIXTURES, 'sales_oct.csv'), sales(500))
  writeFileSync(join(FIXTURES, 'sales_nov.csv'), sales(1000))
  writeFileSync(join(FIXTURES, 'data.tsv'), 'a\tb\tc\n1\tx y\t2.5\n2\t\t\n')
  writeFileSync(
    join(FIXTURES, 'inject.csv'),
    'name,formula,amount\nAlice,"=HYPERLINK(""http://evil"",""x"")",10\nBob,+cmd|calc,-5\nCara,@SUM(A1),3\nDan,normal text,4\n',
  )
  writeFileSync(join(FIXTURES, 'old.xls'), 'not really excel')
}
