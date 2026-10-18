/*
 * Pure SQL text helpers: quoting, statement splitting, naming. No engine imports, so they can be
 * unit-tested in Node (tests/unit) and used anywhere.
 */

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/**
 * Words DuckDB won't accept as a bare name: its "reserved" and "type_function" keywords
 * (SELECT keyword_name FROM duckdb_keywords() WHERE keyword_category IN ('reserved', 'type_function')).
 */
const RESERVED = new Set(
  ('all analyse analyze and anti any array as asc asof asymmetric at authorization binary both by case cast check ' +
    'collate collation column columns concurrently constraint create cross default deferrable desc describe distinct do ' +
    'else end except false fetch for foreign freeze from full generated glob group having ilike in initially inner ' +
    'intersect into is isnull join lambda lateral leading left like limit map natural not notnull null offset on only ' +
    'or order outer overlaps pivot pivot_longer pivot_wider placing positional primary qualify references returning ' +
    'right select semi show similar some struct summarize symmetric table tablesample then to trailing true try_cast ' +
    'union unique unpack unpivot using variadic verbose when where window with').split(' '),
)
export const isReserved = (name: string) => RESERVED.has(name.toLowerCase())

/** A name as people would type it: bare when that's valid SQL (city, sales_2024), quoted otherwise ("Unit Price", "order"). */
export const sqlName = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) && !isReserved(name) ? name : quoteIdent(name))
export const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

/**
 * Splits a script into statements on top-level semicolons. Understands 'strings' (with '' escapes),
 * E'escape\\'d' strings, "identifiers", $$dollar-quoted$$ / $tag$…$tag$ strings, -- line comments
 * and /* block comments *\/, so a semicolon inside any of them doesn't split.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  const push = (end: number) => {
    const stmt = sql.slice(start, end).trim()
    if (stripComments(stmt).trim()) out.push(stmt)
  }
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (ch === "'" || ch === '"') {
      // E'…' strings use backslash escapes; everywhere else a doubled quote is the escape.
      const backslash = ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '')
      i++
      while (i < sql.length) {
        if (backslash && sql[i] === '\\') i += 2
        else if (sql[i] === ch && sql[i + 1] === ch) i += 2
        else if (sql[i] === ch) break
        else i++
      }
      i++
    } else if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        i = end === -1 ? sql.length : end + tag[0].length
      } else i++
    } else if (ch === ';') {
      push(i)
      start = i + 1
      i++
    } else i++
  }
  push(sql.length)
  return out
}

const stripComments = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

/** Turns "Sales Report (2024).csv.gz" into a friendly SQL name: sales_report_2024. `taken` is compared case-insensitively. */
export function tableNameFor(fileName: string, taken: Set<string>): string {
  const stem = fileName
    .replace(/\.(gz|gzip|zst)$/i, '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  let name = !stem ? 'data' : /^[a-z_]/.test(stem) ? stem : `t_${stem}`
  if (isReserved(name)) name = `${name}_data`
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  const base = name
  for (let i = 2; lower.has(name); i++) name = `${base}_${i}`
  return name
}


// Anchored at the end: INTEGER[] or DOUBLE[3] (lists) are not numbers.
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/i
export const isNumericType = (t: string) => NUMERIC.test(t.trim())

/**
 * A column name reduced to words joined by "_" (Customer Name, customerName, CUSTOMER-NAME →
 * customer_name), so name-based guesses work for spreadsheet-style headers too.
 */
export const nameKey = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** Text for a `-- comment` line: a newline in a name must not end the comment and start SQL. */
export const commentText = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ')

/**
 * Whether a column's name says it holds identifiers or codes rather than amounts (order_id, Invoice No.,
 * pin_code, customerId, year): not summed, not grouped with thousands separators, not split or re-cased.
 */
export const isIdLike = (name: string) =>
  /(^|_)(id|ids|code|no|num|number|pin|zip|zipcode|postcode|postal|year|yr|phone|mobile|sku|ref|uuid|guid|gstin|pan|ifsc|invoice|voucher|serial|sr|sno)$/.test(nameKey(name))

/**
 * The reader's locale, for numbers (12,34,567 in India, 1.234.567 in Germany) and how dates are written.
 * A browser left on plain or US English in India (its time zone says where it is) reads as India does:
 * 1,00,000, and 01/04/2024 as 1 April.
 */
export function readerLocale(language: string | undefined, zone: string | undefined): string {
  const lang = language || 'en-US'
  return /^en(-US)?$/i.test(lang) && /^Asia\/(Kolkata|Calcutta)$/.test(zone ?? '') ? 'en-IN' : lang
}

const zone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
})()
export const LOCALE = readerLocale(typeof navigator !== 'undefined' ? navigator.language : undefined, zone)

/** Words that differ between American English and the rest (India's included): aging as of, ageing as on. */
export const WORDS = /^en-US$/i.test(LOCALE) ? { ageing: 'Aging', asOn: 'As of' } : { ageing: 'Ageing', asOn: 'As on' }

/** Dates and timestamps (with or without a time zone): charted over time, bucketed by month in pivots. */
export const isTemporal = (c: { type: string }) => /^(DATE|TIMESTAMP)/i.test(c.type)

/** Tables stacked together, named as one: sales_2024_01 … sales_2024_12 → sales_2024_01-12; else the first and how many more. */
export function stackLabel(names: string[]): string {
  // In number order: sales_2 before sales_10.
  const sorted = [...names].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
  const [a, b] = [sorted[0], sorted[sorted.length - 1]]
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  // Back to a digit run's start, so 2024_01 and 2024_12 differ as 01 and 12, sales_1 and sales_12 as 1 and 12.
  while (i > 0 && /\d/.test(a[i - 1])) i--
  return i >= 3 && i < a.length && i < b.length ? `${a}-${b.slice(i)}` : `${sorted[0]}-and-${sorted.length - 1}-more`
}
