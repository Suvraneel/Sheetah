/*
 * The common DuckDB errors in plain words, with DuckDB's own message kept as details. Spreadsheet
 * people hit these first: a sum over numbers stored as text, a misspelt column or table, text in
 * double quotes, Excel formulas, clauses in the wrong order.
 */

import { OWN_FUNCTIONS } from './own-functions'
import { isNumericType, quoteLiteral, sqlName } from './sql'

/** A one-click repair: text in double quotes made text, or a misspelt name made the real one. */
export type Fix = (
  | { label: string; kind: 'quote'; values: string[] }
  | { label: string; kind: 'rename'; from: string; to: string }
  /** '01/04/2024' and the like (these, as typed in the query), as '2024-04-01' (day or month first). */
  | { label: string; kind: 'dates'; order: 'dmy' | 'mdy'; values: string[] }
  /**
   * A rewrite of the query: `find` (a regular expression's source, case-insensitive) replaced by `to`
   * ($1… for its groups), everywhere in it, or (outside) only outside 'text', "names" and comments.
   */
  | { label: string; kind: 'swap'; find: string; to: string; outside?: boolean }
  /** The query rewritten as a whole (TOP 10 made LIMIT 10 at its end): only while it's still this query. */
  | { label: string; kind: 'sql'; from: string; to: string }
) & {
  /** A second repair, made after this one (text quoted, then & made ||). */
  then?: Fix
}

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

/** Spreadsheet functions people type, and what does the job in SQL (dates as the reader writes them). */
const spreadsheetWords = (monthFirst: boolean): Record<string, string> => ({
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
  datevalue: `date_from_text(x, '${monthFirst ? '%m/%d/%Y' : '%d/%m/%Y'}')`,
  text: `strftime(x, '${monthFirst ? '%b %d, %Y' : '%d %b %Y'}') for dates, or x::VARCHAR`,
  len: 'length(x)',
  concatenate: "concat(a, ' ', b), or a || ' ' || b",
  if: "CASE WHEN … THEN … ELSE … END (or if(cond, a, b))",
  today: 'current_date',
  now: 'now()',
  isblank: 'x IS NULL',
  average: 'avg(x)',
  counta: 'count(x)',
})


/** The line of SQL DuckDB points at ("LINE 1: SELECT …"), if it gave one. */
const lineOf = (raw: string) => /\nLINE \d+: ?(.*)/.exec(raw)?.[1] ?? ''
const head = (raw: string) => raw.split(/\n\s*\nLINE \d+:|\nLINE \d+:/)[0].trim()
/** Names DuckDB suggests that the user never made (its own catalog, Sheetah's working tables). */
const internal = (name: string) => /^(sqlite_|pg_|duckdb_|information_schema|__sheetah|sheetah_)/i.test(name)
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const spreadsheetIn = (words: Record<string, string>) => (name: string) => (Object.hasOwn(words, name.toLowerCase()) ? words[name.toLowerCase()] : null)
/** A date as SQL writes it, from 2024-04-01, 2024/04/01 or 01/04/2024 (day or month first): null if it isn't one. */
function anyIso(text: string, monthFirst: boolean): string | null {
  const ymd = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(text)
  if (!ymd) return isoDate(text, orderOf(text, monthFirst))
  const [y, mo, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null
}

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
  if (fix.kind === 'sql') {
    const done = sql === fix.from ? fix.to : sql
    return fix.then && done !== sql ? applyFix(done, fix.then) : done
  }
  if (fix.kind === 'swap' && !fix.outside) {
    const done = sql.replace(new RegExp(fix.find, 'gi'), fix.to)
    return fix.then ? applyFix(done, fix.then) : done
  }
  const swap = fix.kind === 'swap' ? new RegExp(fix.find, 'gi') : null
  const token = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g
  const word = fix.kind === 'rename' ? new RegExp(`(?<![\\w"$])${esc(fix.from)}(?![\\w"$])`, 'gi') : null
  const bare = (s: string) => (word && fix.kind === 'rename' ? s.replace(word, sqlName(fix.to)) : swap && fix.kind === 'swap' ? s.replace(swap, fix.to) : s)
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
    // "100" in double quotes after > or < is the number 100 (not "0110", a code); anything else, text
    // (which SQL compares with a number column as a number all the same).
    if (fix.kind === 'quote' && fix.values.includes(inner)) out += numberAt(sql, m.index, inner) ? inner : quoteLiteral(inner)
    else if (fix.kind === 'rename' && inner.toLowerCase() === fix.from.toLowerCase()) out += sqlName(fix.to)
    else out += tok
  }
  const done = out + bare(sql.slice(last))
  return fix.then ? applyFix(done, fix.then) : done
}

/** Whether "x" at `at` is a number being compared in order (amount > "1000"): written bare, it's that number. */
const numberAt = (sql: string, at: number, inner: string) => /^-?(0|[1-9]\d*)(\.\d+)?$/.test(inner) && /(<=|>=|<|>)\s*$/.test(sql.slice(0, at))

type Explained = { text: string; detail?: string; code?: boolean; fix?: Fix }

/** text: what to tell the user; detail: DuckDB's own words; code: the text is DuckDB's own words (shown as code); fix: a repair to offer. */
/** A sum written in SQL, on the reader's own table and a number column of it (else a made-up one). */
export function sumExample(table?: { name: string; columns: { name: string; type: string }[] }): string {
  const nums = table?.columns.filter((c) => isNumericType(c.type)) ?? []
  const col = nums.find((c) => /amount|total|value|price|sales|revenue/i.test(c.name)) ?? nums.find((c) => /qty|quantity/i.test(c.name)) ?? nums[0]
  return table && col ? `SELECT sum(${sqlName(col.name)}) FROM ${sqlName(table.name)}` : 'SELECT sum(total) FROM orders'
}

export interface ErrorContext {
  tables?: string[]
  columns?: string[]
  monthFirst?: boolean
  /** A sum written for the reader's own table (sumExample). */
  sum?: string
  /** The table the query on screen reads, for examples written on it. */
  table?: string
  /** The query that failed, when it's at hand: some slips (TOP 10, a misplaced LIMIT) are found in it, not the line DuckDB quotes. */
  sql?: string
}

/** Where a value goes (after =, in an IN list, after THEN): what's written there is a value, not a name. */
const VALUE_BEFORE = String.raw`(=|<>|!=|<=|>=|<|>|\bI?LIKE|\bTHEN|\bELSE|\bIN\s*\([^)]*?)\s*`
/** Totals: a name in one is a column's, even when it isn't found (sum("Revenue") is a misspelt column, not text). */
const TOTALS = /^(sum|avg|min|max|count|median|mode|stddev|variance|first|last|any_value|string_agg|list)$/i
/** Dates typed without quotes: 2024-04-01 (a subtraction), 01/04/2024 (a division). */
const BARE_DATE = /(?<![\w'".])(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})(?![\w'".])/g

/**
 * Whether "x" in double quotes stands where a value goes on the line: after = or in an IN list, joined to
 * other text with & or ||, or given to a function (not a total: sum("Revenue") is a column that isn't there).
 */
function valueAt(line: string, x: string): boolean {
  const q = esc(x)
  const fnArg = new RegExp(String.raw`(\w+)\s*\([^()]*"${q}"`).exec(line)
  return (
    new RegExp(`${VALUE_BEFORE}"${q}"`, 'i').test(line) ||
    new RegExp(String.raw`(&|\|\|)\s*"${q}"|"${q}"\s*(&|\|\|)`).test(line) ||
    (!!fnArg && !TOTALS.test(fnArg[1]))
  )
}

/** Several repairs as one: each made after the one before. */
const chain = (fixes: Fix[]): Fix | undefined => fixes.reduceRight<Fix | undefined>((then, f) => ({ ...f, ...(then ? { then } : {}) }), undefined)

export function explainError(message: string, ctx: ErrorContext = {}): Explained {
  const raw = message.replace(/^.*?Error: /, '')
  const first = head(raw)
  const line = lineOf(raw)
  // The query as typed, else the line DuckDB quotes from it.
  const sql = ctx.sql ?? line
  const plain = (text: string, fix?: Fix): Explained => ({ text, detail: raw, ...(fix ? { fix } : {}) })
  const known = new Set([...(ctx.columns ?? []), ...(ctx.tables ?? [])].map((n) => n.toLowerCase()))
  const spreadsheet = spreadsheetIn(spreadsheetWords(!!ctx.monthFirst))
  // Taxable Value without its quotes: SQL reads two words (and VALUE is one of its own).
  const spaced = spacedColumn(line, ctx.columns ?? [])
  const quoteIt = (s: { typed: string; column: string }) =>
    plain(`Column names with spaces go in double quotes: ${sqlName(s.column)}.`, { label: `Use ${sqlName(s.column)}`, kind: 'rename', from: s.typed, to: s.column })
  // & between texts, a spreadsheet's way of joining them: SQL's is ||.
  const ampersand: Fix = { label: 'Use ||', kind: 'swap', find: String.raw`\s*(?<!&)&(?!&)\s*`, to: ' || ', outside: true }

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

  // d > 2024-04-01: without quotes that's 2024 − 4 − 1, a number, compared with a date.
  if (/^(Cannot compare values of type|Cannot mix values of type|Unimplemented type for cast)/.test(first) && /\b(DATE|TIMESTAMP)/.test(first) && /\b(INTEGER|BIGINT|DOUBLE|DECIMAL|HUGEINT)\b/.test(first)) {
    const typed = [...new Set([...stripStrings(line).matchAll(BARE_DATE)].map((m) => m[1]))]
    const dates = typed.map((t) => ({ t, iso: anyIso(t, !!ctx.monthFirst) })).filter((x): x is { t: string; iso: string } => !!x.iso)
    if (dates.length) {
      const [{ t, iso }] = dates
      const sum = /^\d{4}/.test(t) ? 'a subtraction' : 'a division'
      return plain(`Dates go in single quotes, written year-month-day: '${iso}'. Without quotes, ${t} is ${sum}, a number.`, chain(dates.map((x) => ({ label: `Use '${dates[0].iso}'`, kind: 'swap', find: `(?<![\\w'".])${esc(x.t)}(?![\\w'".])`, to: `'${x.iso}'`, outside: true }))))
    }
  }

  const fn = /No function matches the given name and argument types '([^'(]+)\(([^)]*)\)'/.exec(raw)
  if (fn && fn[1] === '&' && /VARCHAR|STRING_LITERAL/.test(fn[2])) return plain('& joins text in a spreadsheet. In SQL it’s ||: city || \' - \' || state.', ampersand)
  // countif exists in DuckDB, for a condition: countif(city, 'Pune') is the spreadsheet's.
  if (fn && spreadsheet(fn[1])) return plain(`${fn[1]}() works differently in SQL. Use ${spreadsheet(fn[1])}.`)
  if (fn && /VARCHAR/.test(fn[2]))
    return plain(`${fn[1]}() needs numbers, but it was given text. If the column holds numbers stored as text, open its column menu and choose Convert to number.`)

  // number_from_text(amount, 2): one of Sheetah's own, given values it doesn't take.
  const macro = /Macro (\w+)\(\) does not support the supplied arguments/.exec(raw)
  if (macro) {
    const own = Object.hasOwn(OWN_FUNCTIONS, macro[1].toLowerCase()) ? OWN_FUNCTIONS[macro[1].toLowerCase()] : null
    const shape = own?.shape ?? /Candidate macros:\s*\n\s*([^\n]+)/.exec(raw)?.[1]?.trim()
    if (shape) return plain(`${macro[1]}() isn’t given the values it takes. It’s written ${shape}${own ? `: ${own.does.replace(/\.$/, '')}` : ''}.`)
  }

  const zeroLength = /zero-length delimited identifier/.test(raw)
  if (zeroLength) return plain('Empty text is two single quotes in SQL: \'\'. Double quotes are for column names.', { label: "Use ''", kind: 'quote', values: [''] })

  const col = /Referenced column "([^"]+)" not found/.exec(raw)
  if (col && spaced && spaced.typed.toLowerCase().startsWith(col[1].toLowerCase())) return quoteIt(spaced)
  if (col) {
    const candidate = /Candidate bindings: "([^"]+)"/.exec(raw)?.[1]
    const name = candidate && !internal(candidate.split('.').pop()!) ? candidate : null
    const near = !!name && misspelt(col[1], name.split('.').pop()!)
    const to = name?.split('.').pop()
    if (near && to) return plain(`There’s no column called “${col[1]}”. Did you mean “${name}”?`, { label: `Use ${to}`, kind: 'rename', from: col[1], to })
    const q = esc(col[1])
    const quoted = new RegExp(`"${q}"`).test(line)
    // city = "Pune", "Pune" & state, upper("Pune"): double quotes name a column in SQL; text takes single
    // quotes. (In a total, sum("Revenue"), it's a column that isn't there.)
    const joined = new RegExp(String.raw`(&|\|\|)\s*"${q}"|"${q}"\s*(&|\|\|)`).test(line)
    const asValue = quoted && valueAt(line, col[1])
    if (asValue) {
      // city IN ("Pune", "Goa"): the others in the list are text too (DuckDB names only the first); so is
      // other text in double quotes on the line, where a value goes (upper("goa") OR lower("GOA")).
      const list = new RegExp(String.raw`\bIN\s*\(([^)]*"${q}"[^)]*)\)`, 'i').exec(line)?.[1] ?? ''
      const listed = [...list.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'))
      const elsewhere = ctx.columns?.length ? [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')).filter((v) => valueAt(line, v)) : []
      const values = [col[1], ...new Set([...listed, ...elsewhere].filter((v) => v !== col[1] && !known.has(v.toLowerCase())))]
      const number = numberAt(line, line.indexOf(`"${col[1]}"`), col[1])
      const quote: Fix = { label: values.length > 1 ? 'Use single quotes' : number ? `Use ${col[1]}` : `Use ${quoteLiteral(col[1])}`, kind: 'quote', values }
      if (number) return plain(`“${col[1]}” is in double quotes, which SQL reads as a column’s name. A number needs no quotes: ${col[1]}.`, quote)
      const amp = joined && /&/.test(stripStrings(line))
      return plain(
        `“${col[1]}” is in double quotes, which SQL reads as a column’s name. Put text in single quotes: ${quoteLiteral(col[1])}.${amp ? ' And text is joined with ||, not &.' : ''}`,
        amp ? { ...quote, then: ampersand } : quote,
      )
    }
    // city = Pune: a bare word where a value goes is read as a column's name.
    if (!quoted && new RegExp(`${VALUE_BEFORE}${q}\\b`, 'i').test(line)) {
      const list = new RegExp(String.raw`\bIN\s*\(([^)]*\b${q}\b[^)]*)\)`, 'i').exec(line)?.[1] ?? ''
      const values = [col[1], ...[...list.matchAll(/(?<!['"\w])([A-Za-z_][\w ]*?)(?=\s*[,)]|\s*$)/g)].map((m) => m[1].trim()).filter((v) => v && v !== col[1] && !known.has(v.toLowerCase()) && !/^null$/i.test(v))]
      return plain(`${col[1]} isn’t a column, and text goes in single quotes: ${quoteLiteral(col[1])}.`, {
        label: values.length > 1 ? 'Use single quotes' : `Use ${quoteLiteral(col[1])}`,
        kind: 'swap',
        find: `(?<![\\w"'$.])(${values.map(esc).join('|')})(?![\\w"'$(])`,
        to: "'$1'",
        outside: true,
      })
    }
    return plain(`There’s no column called “${col[1]}”. If it’s text, put it in single quotes: ${quoteLiteral(col[1])}.`)
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
  if (group) {
    // GROUP BY 'city': the text 'city', the same on every row, so nothing is grouped by the column.
    const literal = new RegExp(String.raw`GROUP\s+BY\s+(?:[^;]*?,\s*)?'(${esc(group[1])})'`, 'i').exec(stripComments(sql))
    if (literal)
      return plain(`GROUP BY '${literal[1]}' groups by the text '${literal[1]}' (single quotes are text), the same on every row. A column’s name goes without them: GROUP BY ${sqlName(group[1])}.`, {
        label: `Use GROUP BY ${sqlName(group[1])}`,
        kind: 'swap',
        find: String.raw`(GROUP\s+BY\s+(?:[^;]*?,\s*)?)'${esc(literal[1])}'`,
        to: `$1${sqlName(group[1]).replace(/\$/g, '$$$$')}`,
      })
    return plain(`“${group[1]}” is neither grouped nor totalled. Add it to GROUP BY, or wrap it in sum(), count(), max() or another total.`)
  }

  // ORDER BY 'amount': DuckDB won't sort by a text that's the same on every row.
  if (/ORDER BY non-integer literal has no effect/.test(raw)) {
    const named = quotedNames(sql, ctx.columns ?? [])
    if (named) return plain(`ORDER BY '${named.literal}' sorts by the text '${named.literal}', the same on every row: single quotes are text. The column is ${sqlName(named.column)}.`, { label: `Use ${sqlName(named.column)}`, kind: 'sql', from: sql, to: named.fixed })
    return plain('ORDER BY takes a column’s name (or its number in the list): text in single quotes is the same on every row, so sorts nothing.')
  }

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
    if (/^\s*=/.test(line) && near[1] === '=') {
      const own = formulaExample(line, ctx)
      return plain(`That’s a spreadsheet formula. Sheetah speaks SQL: ${own ?? ctx.sum ?? 'SELECT sum(total) FROM orders'} ${own ? 'does the same' : 'adds up a column'}.`)
    }
    const bare = stripStrings(sql)
    // SELECT TOP 10 *: SQL Server's way. Here the number of rows goes in LIMIT, at the end.
    // (Found where it's SQL, not in text or a comment; the query rewritten there, LIMIT put after its last word.)
    const top = /\b(SELECT\s+(?:DISTINCT\s+)?)(TOP\s+(\d+)\s*)/i.exec(bare)
    if (top && near[1] === top[3]) {
      const at = top.index + top[1].length
      return plain(`TOP ${top[3]} is SQL Server’s way. Here it’s LIMIT ${top[3]}, at the end of the query.`, {
        label: `Use LIMIT ${top[3]}`,
        kind: 'sql',
        from: sql,
        to: atEnd(sql.slice(0, at) + sql.slice(at + top[2].length), `\nLIMIT ${top[3]}`),
      })
    }
    // amount > 1,000: SQL reads 1 and then a comma.
    // (Not in an IN list, where 101,102 is two numbers.)
    const grouped = [...bare.matchAll(/(?:=|<>|!=|<=|>=|<|>|\bBETWEEN|\bAND)\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?![\d,])/gi)].map((m) => m[1])
    if (near[1] === ',' && grouped.length)
      return plain(`Numbers in SQL are written without thousands separators: ${grouped[0].replace(/,/g, '')}.`, chain(grouped.map((g) => ({ label: `Use ${grouped[0].replace(/,/g, '')}`, kind: 'swap', find: `(?<![\\w.,])${esc(g)}(?![\\d,])`, to: g.replace(/,/g, ''), outside: true }))))
    // city = 'Pune' && state = 'MH': conditions are joined with AND.
    if (/&&/.test(bare)) return plain('Conditions are joined with AND (or OR) in SQL: && isn’t one of its words.', { label: 'Use AND', kind: 'swap', find: String.raw`\s*&&\s*`, to: ' AND ', outside: true })
    // A column called Order or Group: a SQL word, so its name needs double quotes.
    const word = ctx.columns?.find((c) => c.toLowerCase() === near[1].toLowerCase())
    if (word && /^[A-Za-z]+$/.test(word)) return plain(`${word} is a SQL word, so as a column’s name it goes in double quotes: "${word}".`)
    if (/^(ORDER|GROUP|WHERE|HAVING|LIMIT)$/i.test(near[1])) {
      // … LIMIT 10 WHERE …: the LIMIT goes last.
      const limit = new RegExp(String.raw`\bLIMIT\s+(\d+)\s+(?=${near[1]}\b)`, 'i').exec(bare)
      const order = `The parts of a query go in this order: SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT.`
      if (limit)
        return plain(`LIMIT goes at the very end. ${order}`, {
          label: `Move LIMIT ${limit[1]} to the end`,
          kind: 'sql',
          from: sql,
          to: atEnd(sql.slice(0, limit.index) + sql.slice(limit.index + limit[0].length), `\nLIMIT ${limit[1]}`),
        })
      return plain(`${near[1].toUpperCase()} is in the wrong place. ${order}`)
    }
    return plain(`SQL couldn’t be read at “${near[1]}”. Look just before it: a misspelt word, a missing comma, or a bracket left open.`)
  }
  // Not one we know: DuckDB's own words when they're DuckDB's (a mono font keeps its ^ under the right spot).
  return /^[A-Z][A-Za-z ]*Error: /.test(message) ? { text: raw, code: true } : { text: raw }
}

/** Text with its 'strings', "names" and comments blanked out (same length), so words inside them aren't read as SQL. */
function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
}
const stripComments = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')

/** The query with `add` after its last word: before a closing ; and any comment after it. */
function atEnd(sql: string, add: string): string {
  // Comments blanked (strings kept: a query can end with one), then the end of the code, before a ;.
  const code = sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? m : ' '.repeat(m.length))).trimEnd()
  const end = code.endsWith(';') ? code.slice(0, -1).trimEnd().length : code.length
  return sql.slice(0, end) + add + sql.slice(end)
}

/** =SUM(Amount) typed into the editor: the same thing in SQL, on the reader's table (null if it isn't one of its columns). */
function formulaExample(line: string, ctx: ErrorContext): string | null {
  const m = /^\s*=\s*(sum|average|avg|count|counta|max|min)\s*\(\s*"?([^")]*?)"?\s*\)/i.exec(line)
  const column = m && ctx.columns?.find((c) => c.toLowerCase() === m[2].trim().toLowerCase())
  if (m && column && ctx.table) {
    const f = { average: 'avg', counta: 'count' }[m[1].toLowerCase()] ?? m[1].toLowerCase()
    return `SELECT ${f}(${sqlName(column)}) FROM ${sqlName(ctx.table)}`
  }
  return null
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


/**
 * "GROUP BY 'city'", "ORDER BY 'amount'": it runs, but groups or sorts by the text 'city', the same on
 * every row (single quotes are text). Found where the text is a column's name; returned with the name put back.
 */
export function quotedNames(sql: string, columns: string[]): { literal: string; column: string; clause: string; fixed: string } | null {
  const code = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  for (const m of code.matchAll(/\b(GROUP|ORDER)\s+BY\s+((?:[^;()]|\([^()]*\))*?)(?=\bHAVING\b|\bORDER\b|\bLIMIT\b|\bQUALIFY\b|\bWINDOW\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|\bSELECT\b|\bFROM\b|\bWHERE\b|\)|;|$)/gi)) {
    for (const lit of m[2].matchAll(/'((?:[^']|'')+)'/g)) {
      const text = lit[1].replace(/''/g, "'")
      const column = columns.find((c) => c.toLowerCase() === text.toLowerCase())
      if (!column) continue
      const at = m.index + m[0].indexOf(m[2]) + lit.index
      return { literal: text, column, clause: `${m[1].toUpperCase()} BY`, fixed: `${sql.slice(0, at)}${sqlName(column)}${sql.slice(at + lit[0].length)}` }
    }
  }
  return null
}
