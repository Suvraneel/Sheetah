/*
 * The common DuckDB errors in plain words, with DuckDB's own message kept as details. Spreadsheet
 * people hit these first: a sum over numbers stored as text, a misspelt column or table, text in
 * double quotes, Excel formulas, clauses in the wrong order.
 */

import { quoteLiteral, sqlName } from './sql'

/** A one-click repair: text in double quotes made text, or a misspelt name made the real one. */
export type Fix =
  | { label: string; kind: 'quote'; values: string[] }
  | { label: string; kind: 'rename'; from: string; to: string }
  /** '01/04/2024' and the like (these, as typed in the query), as '2024-04-01' (day or month first). */
  | { label: string; kind: 'dates'; order: 'dmy' | 'mdy'; values: string[] }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/
/** A day/month/year date as ISO, in the given order; null if it isn't a real date that way. */
function isoDate(text: string, order: 'dmy' | 'mdy'): string | null {
  const m = DMY.exec(text.trim())
  if (!m) return null
  const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [d, mo] = order === 'dmy' ? [a, b] : [b, a]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
/** Which way round a date is written: settled by a part over 12, else by the reader's habit. */
const orderOf = (text: string, monthFirst: boolean): 'dmy' | 'mdy' => {
  const m = DMY.exec(text.trim())
  if (m && Number(m[1]) > 12) return 'dmy'
  if (m && Number(m[2]) > 12) return 'mdy'
  return monthFirst ? 'mdy' : 'dmy'
}
/** A column whose name has spaces, written in the SQL without its quotes (Taxable Value). */
function spacedColumn(line: string, columns: string[]): { typed: string; column: string } | null {
  for (const c of columns.filter((x) => /\s/.test(x.trim())).sort((a, b) => b.length - a.length)) {
    const m = new RegExp(`(?<![\\w"$])${c.trim().split(/\s+/).map(esc).join('\\s+')}(?![\\w"$])`, 'i').exec(line)
    if (m) return { typed: m[0], column: c }
  }
  return null
}

/** Spreadsheet functions people type, and what does the job in SQL. */
const SPREADSHEET: Record<string, string> = {
  vlookup: 'a join. Lookup, in a column’s menu, writes one for you',
  xlookup: 'a join. Lookup, in a column’s menu, writes one for you',
  hlookup: 'a join. Lookup, in a column’s menu, writes one for you',
  countif: "countif(city = 'Pune'), or count(*) FILTER (WHERE …)",
  countifs: 'count(*) FILTER (WHERE … AND …)',
  sumif: 'sum(x) FILTER (WHERE …)',
  sumifs: 'sum(x) FILTER (WHERE … AND …)',
  averageif: 'avg(x) FILTER (WHERE …)',
  iferror: 'coalesce(TRY_CAST(x AS DOUBLE), 0)',
  proper: 'title_case(x)',
  mid: 'substr(x, start, length)',
  find: "strpos(x, 'text')",
  search: "strpos(lower(x), 'text')",
  value: 'number_from_text(x)',
  datevalue: "date_from_text(x, '%d/%m/%Y')",
  text: "strftime(x, '%d %b %Y') for dates, or x::VARCHAR",
}

/** The line of SQL DuckDB points at ("LINE 1: SELECT …"), if it gave one. */
const lineOf = (raw: string) => /\nLINE \d+: ?(.*)/.exec(raw)?.[1] ?? ''
const head = (raw: string) => raw.split(/\n\s*\nLINE \d+:|\nLINE \d+:/)[0].trim()
/** Names DuckDB suggests that the user never made (its own catalog, Sheetah's working tables). */
const internal = (name: string) => /^(sqlite_|pg_|duckdb_|information_schema|__sheetah|sheetah_)/i.test(name)
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const spreadsheet = (name: string) => (Object.hasOwn(SPREADSHEET, name.toLowerCase()) ? SPREADSHEET[name.toLowerCase()] : null)

/** Edits (insert, delete, change a letter) between two short names, ignoring case. */
function distance(a: string, b: string): number {
  a = a.toLowerCase()
  b = b.toLowerCase()
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}
/** A misspelling of the name, not a different word (discont → discount, not Pune → city). */
const misspelt = (typed: string, name: string) => typed.length >= 3 && distance(typed, name) <= Math.min(2, Math.floor(typed.length / 3))

/**
 * The SQL with a fix applied: outside 'text' and comments, in names written plainly or in double
 * quotes. Unchanged when there's nothing to fix.
 */
export function applyFix(sql: string, fix: Fix): string {
  const token = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g
  const word = fix.kind === 'rename' ? new RegExp(`(?<![\\w"$])${esc(fix.from)}(?![\\w"$])`, 'gi') : null
  const bare = (s: string) => (word && fix.kind === 'rename' ? s.replace(word, sqlName(fix.to)) : s)
  let out = ''
  let last = 0
  for (const m of sql.matchAll(token)) {
    const tok = m[0]
    out += bare(sql.slice(last, m.index))
    last = m.index + tok.length
    if (fix.kind === 'dates' && tok.startsWith("'") && fix.values.includes(tok.slice(1, -1))) {
      const iso = isoDate(tok.slice(1, -1), fix.order)
      out += iso ? `'${iso}'` : tok
      continue
    }
    if (!tok.startsWith('"')) {
      out += tok
      continue
    }
    const inner = tok.slice(1, -1).replace(/""/g, '"')
    if (fix.kind === 'quote' && fix.values.includes(inner)) out += quoteLiteral(inner)
    else if (fix.kind === 'rename' && inner.toLowerCase() === fix.from.toLowerCase()) out += sqlName(fix.to)
    else out += tok
  }
  return out + bare(sql.slice(last))
}

type Explained = { text: string; detail?: string; code?: boolean; fix?: Fix }

/** text: what to tell the user; detail: DuckDB's own words; code: the text is DuckDB's own words (shown as code); fix: a repair to offer. */
export function explainError(message: string, ctx: { tables?: string[]; columns?: string[]; monthFirst?: boolean } = {}): Explained {
  const raw = message.replace(/^.*?Error: /, '')
  const first = head(raw)
  const line = lineOf(raw)
  const plain = (text: string, fix?: Fix): Explained => ({ text, detail: raw, ...(fix ? { fix } : {}) })
  const known = new Set([...(ctx.columns ?? []), ...(ctx.tables ?? [])].map((n) => n.toLowerCase()))
  // Taxable Value without its quotes: SQL reads two words (and VALUE is one of its own).
  const spaced = spacedColumn(line, ctx.columns ?? [])
  const quoteIt = (s: { typed: string; column: string }) =>
    plain(`Column names with spaces go in double quotes: ${sqlName(s.column)}.`, { label: `Use ${sqlName(s.column)}`, kind: 'rename', from: s.typed, to: s.column })

  const dateText = /invalid (date|timestamp) field format: "([^"]*)"/.exec(raw)
  if (dateText) {
    // Typed in the query ('01/04/2024' on the line DuckDB quotes), or a value in the data being cast.
    if (!line.includes(`'${dateText[2]}'`))
      return plain(`“${dateText[2]}” in the data isn’t a date SQL can read as it is. Convert the column from its menu (Convert to date) first.`)
    const order = orderOf(dateText[2], !!ctx.monthFirst)
    const iso = isoDate(dateText[2], order)
    if (!iso) return plain(`“${dateText[2]}” isn’t a date SQL can read. Dates are written year-month-day: '2024-04-01'.`)
    const [y, m, d] = iso.split('-').map(Number)
    // Every date written this way on that line (BETWEEN '01/04/2024' AND '30/04/2024'), not text elsewhere.
    const values = [...line.matchAll(/'([^']*)'/g)].map((x) => x[1]).filter((v) => isoDate(v, order))
    return plain(`Dates in SQL are written year-month-day: '${iso}' is ${d} ${MONTHS[m - 1]} ${y}.`, { label: `Use '${iso}'`, kind: 'dates', order, values })
  }

  const fn = /No function matches the given name and argument types '(\w+)\(([^)]*)\)'/.exec(raw)
  // countif exists in DuckDB, for a condition: countif(city, 'Pune') is the spreadsheet's.
  if (fn && spreadsheet(fn[1])) return plain(`${fn[1]}() works differently in SQL. Use ${spreadsheet(fn[1])}.`)
  if (fn && /VARCHAR/.test(fn[2]))
    return plain(`${fn[1]}() needs numbers, but it was given text. If the column holds numbers stored as text, open its column menu and choose Convert to number.`)

  const col = /Referenced column "([^"]+)" not found/.exec(raw)
  if (col && spaced && spaced.typed.toLowerCase().startsWith(col[1].toLowerCase())) return quoteIt(spaced)
  if (col) {
    const candidate = /Candidate bindings: "([^"]+)"/.exec(raw)?.[1]
    const name = candidate && !internal(candidate.split('.').pop()!) ? candidate : null
    // city = "Pune": double quotes name a column in SQL; text takes single quotes. Unless it's a near
    // miss of a real column (amount > "discont").
    const asValue = new RegExp(`(=|<>|!=|<=|>=|<|>|\\bI?LIKE|\\bTHEN|\\bELSE|\\bIN\\s*\\([^)]*?)\\s*"${esc(col[1])}"`, 'i').test(line)
    const near = !!name && misspelt(col[1], name.split('.').pop()!)
    if (asValue && !near) {
      // city IN ("Pune", "Goa"): the others in the list are text too (DuckDB names only the first).
      const list = new RegExp(`\\bIN\\s*\\(([^)]*"${esc(col[1])}"[^)]*)\\)`, 'i').exec(line)?.[1] ?? ''
      const values = [col[1], ...[...list.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')).filter((v) => v !== col[1] && !known.has(v.toLowerCase()))]
      return plain(`“${col[1]}” is in double quotes, which SQL reads as a column’s name. Put text in single quotes: ${quoteLiteral(col[1])}.`, {
        label: values.length > 1 ? 'Use single quotes' : `Use ${quoteLiteral(col[1])}`,
        kind: 'quote',
        values,
      })
    }
    const hint = name ? ` Did you mean “${name}”?` : ' Text goes in single quotes, like \'big\'.'
    const to = name?.split('.').pop()
    return plain(`There’s no column called “${col[1]}”.${hint}`, to && near ? { label: `Use ${to}`, kind: 'rename', from: col[1], to } : undefined)
  }

  const table = /Table with name (\S+?) does not exist/.exec(raw)
  if (table) {
    const mine = (ctx.tables ?? []).filter((t) => !internal(t))
    const suggested = /Did you mean "([^"]+)"/.exec(raw)?.[1]
    const near = suggested && mine.find((t) => t.toLowerCase() === suggested.toLowerCase())
    const yours = mine.length ? ` Your tables: ${mine.slice(0, 8).join(', ')}${mine.length > 8 ? '…' : ''}.` : ' Open a file first: its name becomes a table.'
    return plain(`There’s no table called “${table[1]}”.${near ? ` Did you mean “${near}”?` : yours}`, near ? { label: `Use ${near}`, kind: 'rename', from: table[1], to: near } : undefined)
  }

  // "…with name vlookup does not exist!", or "…with name "text" is not in the catalog, but it exists in the excel extension."
  const scalar = /(?:Scalar|Aggregate|Table) Function with name "?(\w+)"? (?:does not exist|is not in the catalog)/i.exec(raw)
  if (scalar) {
    const hint = spreadsheet(scalar[1])
    if (hint) return plain(`${scalar[1]}() is a spreadsheet function. In SQL, use ${hint}.`)
    const suggested = /Did you mean "([^"]+)"/.exec(raw)?.[1]
    return plain(`There’s no function called ${scalar[1]}().${suggested && !internal(suggested) ? ` Did you mean ${suggested.replace(/\(.*$/, '')}()?` : ''}`)
  }

  const group = /column "([^"]+)" must appear in the GROUP BY clause/.exec(raw)
  if (group) return plain(`“${group[1]}” is neither grouped nor totalled. Add it to GROUP BY, or wrap it in sum(), count(), max() or another total.`)

  const ambiguous = /Ambiguous reference to column name "([^"]+)" \(use: ([^)]+)\)/.exec(raw)
  if (ambiguous) return plain(`More than one table has a column called “${ambiguous[1]}”. Say which: ${ambiguous[2].replace(/"/g, '')}.`)

  if (/WHERE clause cannot contain aggregates/.test(raw))
    return plain('Totals like count() and sum() can’t go in WHERE, which picks rows before they’re totalled. Filter totals with HAVING, after GROUP BY.')

  const conv = /Could not convert string '([^']*)' to (\w+)/.exec(raw)
  if (conv) return plain(`“${conv[1]}” can’t be read as ${/INT|DOUBLE|DECIMAL|FLOAT/.test(conv[2]) ? 'a number' : /DATE|TIME/.test(conv[2]) ? 'a date' : conv[2].toLowerCase()}.`)

  if (/^syntax error at end of input/.test(first)) return plain('The query ends too soon. Something is missing at the end: a value after AND or =, or a closing bracket.')
  if (/^unterminated quoted string/.test(first)) return plain('A quote isn’t closed. Text starts and ends with a single quote: \'Pune\'.')
  const near = /^syntax error at or near "([^"]*)"/.exec(first)
  if (near && spaced) return quoteIt(spaced)
  if (near) {
    if (/^\s*=/.test(line) && near[1] === '=') return plain('That’s a spreadsheet formula. Sheetah speaks SQL: SELECT sum(total) FROM orders adds up a column.')
    // A column called Order or Group: a SQL word, so its name needs double quotes.
    const word = ctx.columns?.find((c) => c.toLowerCase() === near[1].toLowerCase())
    if (word && /^[A-Za-z]+$/.test(word)) return plain(`${word} is a SQL word, so as a column’s name it goes in double quotes: "${word}".`)
    if (/^(ORDER|GROUP|WHERE|HAVING|LIMIT)$/i.test(near[1]))
      return plain(`${near[1].toUpperCase()} is in the wrong place. The parts of a query go in this order: SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT.`)
    return plain(`SQL couldn’t be read at “${near[1]}”. Look just before it: a misspelt word, a missing comma, or a bracket left open.`)
  }
  // Not one we know: DuckDB's own words when they're DuckDB's (a mono font keeps its ^ under the right spot).
  return /^[A-Z][A-Za-z ]*Error: /.test(message) ? { text: raw, code: true } : { text: raw }
}

export { isLoadFailure } from './load-errors'

/**
 * "SELECT Region City FROM t": no error, but City is Region renamed (a missing comma). Found in the
 * select list of a query that ran: two bare names in a row that are both columns of the tables read.
 * Returns each slip and the SQL with its comma put back.
 */
export function missingCommas(sql: string, columns: string[]): { first: string; second: string; fixed: string }[] {
  const select = /^\s*SELECT\s+(DISTINCT\s+)?([\s\S]*?)\s+FROM\s/i.exec(sql.replace(/--[^\n]*/g, ''))
  if (!select) return []
  const known = new Set(columns.map((c) => c.toLowerCase()))
  // Top-level items of the select list (commas inside brackets or quotes don't split).
  const items: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const ch of select[2]) {
    if (quote) quote = ch === quote ? null : quote
    else if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      items.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  items.push(cur)
  const out: { first: string; second: string; fixed: string }[] = []
  for (const item of items) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(item)
    if (!m || /^as$/i.test(m[2]) || !known.has(m[1].toLowerCase()) || !known.has(m[2].toLowerCase()) || m[1].toLowerCase() === m[2].toLowerCase()) continue
    const at = sql.indexOf(item.trim())
    if (at < 0) continue
    out.push({ first: m[1], second: m[2], fixed: `${sql.slice(0, at)}${m[1]}, ${m[2]}${sql.slice(at + item.trim().length)}` })
  }
  return out
}

