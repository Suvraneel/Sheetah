/*
 * Fails the build if the JavaScript a visitor downloads before the app is usable grows past its budget
 * (gzip). The DuckDB engine (.wasm) and the lazily loaded editor/Excel chunks are reported, not budgeted:
 * their size is set by the pinned engine version, not by our code.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const out = process.argv[2] ?? 'dist'
const dir = join(out, 'assets')
const BUDGET = { js: 190 * 1024, css: 20 * 1024 }
// What the page loads before it's usable: the entry script and everything index.html preloads with it
// (counting by file name alone missed the small shared chunks the bundler splits out and preloads).
const html = readFileSync(join(out, 'index.html'), 'utf8')
const loaded = new Set([...html.matchAll(/<(?:script[^>]+src|link[^>]+href)="\/assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]))
const initialNames = { test: (name) => loaded.has(name) }
const initial = initialNames

let js = 0
let css = 0
const rows = []
for (const name of readdirSync(dir).sort()) {
  if (!/\.(js|css)$/.test(name)) continue
  const size = gzipSync(readFileSync(join(dir, name))).length
  if (initial.test(name)) js += size
  if (name.endsWith('.css')) css += size
  rows.push(`${initial.test(name) || name.endsWith('.css') ? '*' : ' '} ${(size / 1024).toFixed(1).padStart(7)} KB  ${name}`)
}
console.log(rows.join('\n'))
console.log(`\nInitial JS ${(js / 1024).toFixed(1)} KB (budget ${BUDGET.js / 1024} KB), CSS ${(css / 1024).toFixed(1)} KB (budget ${BUDGET.css / 1024} KB), gzip`)
if (js > BUDGET.js || css > BUDGET.css) {
  console.error('Over budget: lazy-load something, or raise the budget in scripts/check-bundle-size.mjs on purpose.')
  process.exit(1)
}
