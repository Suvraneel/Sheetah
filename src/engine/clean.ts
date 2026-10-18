import { LOCALE, nameKey, quoteLiteral, sqlName } from './sql'

/*
 * Clean a column in place: numbers stored as text ("₹1,234", "12%", "(250)", "12,5" in a decimal-comma
 * locale), dates stored as text ("15/08/2024", "15-Aug-24"), stray spaces, inconsistent case. Like every
 * other action it is plain SQL — SELECT * REPLACE (…) — composed around the query, so the original
 * data never changes and the editor shows exactly what happened.
 *
 * Conversions never guess silently: a value that doesn't fit the chosen reading becomes empty rather
 * than a different number ("12,5" is never read as 125, "15/08/24" never as the year 24).
 */
export type CleanKind = 'number' | 'percent' | 'date' | 'trim' | 'upper' | 'lower' | 'title' | 'blank' | 'filldown' | 'replace' | 'swapdm'

/** Row position used by "fill down" (reports exported with a group's name only on its first row). */
const FILL_POS = '__sheetah_fill_pos'

export interface Clean {
  column: string
  kind: CleanKind
  /** strptime format for 'date' (e.g. %d/%m/%Y). */
  format?: string
  /** For numbers: a comma marks the decimals (12,5 = 12.5) and dots group thousands. */
  comma?: boolean
  /** For numbers: a trailing Cr is plus and Dr minus (a bank statement's credits and debits). */
  drcr?: boolean
  /** For 'replace': the value to replace (matched ignoring case and surrounding spaces) and what it becomes (null: empty). */
  from?: string
  to?: string | null
}

/** Date layouts people type; each is a DuckDB strptime format. %Y needs four digits, %y means two. */
export const DATE_FORMATS: { format: string; label: string }[] = [
  { format: '%Y-%m-%d', label: 'YYYY-MM-DD' },
  { format: '%d/%m/%Y', label: 'DD/MM/YYYY' },
  { format: '%m/%d/%Y', label: 'MM/DD/YYYY' },
  { format: '%d-%m-%Y', label: 'DD-MM-YYYY' },
  { format: '%m-%d-%Y', label: 'MM-DD-YYYY' },
  { format: '%d.%m.%Y', label: 'DD.MM.YYYY' },
  { format: '%Y/%m/%d', label: 'YYYY/MM/DD' },
  { format: '%d %b %Y', label: 'DD Mon YYYY' },
  { format: '%d-%b-%Y', label: 'DD-Mon-YYYY' },
  { format: '%b %d, %Y', label: 'Mon DD, YYYY' },
  { format: '%d %B %Y', label: 'DD Month YYYY' },
  { format: '%B %d, %Y', label: 'Month DD, YYYY' },
  { format: '%d/%m/%y', label: 'DD/MM/YY' },
  { format: '%m/%d/%y', label: 'MM/DD/YY' },
  { format: '%d-%m-%y', label: 'DD-MM-YY' },
  { format: '%d-%b-%y', label: 'DD-Mon-YY' },
  // Months (a report's column per month, turned into rows): the first of the month.
  { format: '%b-%y', label: 'Mon-YY' },
  { format: '%b-%Y', label: 'Mon-YYYY' },
  { format: '%b %Y', label: 'Mon YYYY' },
  { format: '%B %Y', label: 'Month YYYY' },
  { format: '%Y-%m', label: 'YYYY-MM' },
]

export const formatLabel = (format?: string) => DATE_FORMATS.find((f) => f.format === format)?.label ?? format ?? ''

/** The value as trimmed text: what every cleaning step starts from. */
const textOf = (ref: string) => `trim(${ref}::VARCHAR)`

/**
 * A number written the way people write them, as SQL text DuckDB can cast. Currency signs go, "(250)"
 * means −250, and separators must be where a thousands separator can be (groups of three): otherwise
 * the value is left unreadable, so "12,5" can't turn into 125. Spaces inside are kept unless commas mark
 * decimals (1 234,56), so a phone number like "98200 12345" isn't mistaken for one.
 */
function numberText(t: string, comma: boolean, drcr = false): string {
  // "50,000.00 Cr" / "1,200.00 Dr": a bank statement's credit and debit, plus and minus. Only when asked
  // for: on its own, "₹12 Cr" is twelve crore.
  const debit = drcr ? `regexp_matches(${t}, '[0-9)]\\s*[dD][rR]\\.?$')` : 'false'
  const unmarked = drcr ? `regexp_replace(${t}, '([0-9)])\\s*([cC][rR]|[dD][rR])\\.?$', '\\1')` : t
  const noCurrency = `regexp_replace(${unmarked}, '[₹$€£¥${comma ? '\\s\u00a0\u202f' : ''}]', '', 'g')`
  const negative = `regexp_replace(trim(${noCurrency}), '^\\(\\s*(.*?)\\s*\\)$', '-\\1')`
  // A separator followed by anything but three digits isn't a thousands separator (two are allowed
  // before another comma: Indian grouping, 1,00,000).
  const badGroup = comma ? `'\\.([0-9]{0,2}([^0-9]|$)|[0-9]{4})'` : `',([0-9]?([^0-9]|$)|[0-9]{2}([^0-9,]|$)|[0-9]{4})'`
  const plain = comma ? `replace(replace(${negative}, '.', ''), ',', '.')` : `replace(${negative}, ',', '')`
  return drcr ? `CASE WHEN NOT regexp_matches(${negative}, ${badGroup}) THEN (CASE WHEN ${debit} THEN '-' ELSE '' END) || ${plain} END` : `CASE WHEN NOT regexp_matches(${negative}, ${badGroup}) THEN ${plain} END`
}

/*
 * The conversions are macros, defined in every connection when the engine starts (and in the unit
 * tests' engine), so the SQL a clean-up writes stays short enough to read:
 *   number_from_text(amount)  ·  date_from_text(paid_on, '%d/%m/%Y')  ·  title_case(name)
 */
const T = textOf('x')
const GRAND_OR_SUB = '(grand|sub)[ -]*totals?:?'
const ANY_TOTAL = '(.*[^ ] +)?totals?:?'

export const CLEAN_MACROS: string[] = [
  `CREATE OR REPLACE TEMP MACRO number_from_text(x) AS TRY_CAST(${numberText(T, false)} AS DOUBLE)`,
  `CREATE OR REPLACE TEMP MACRO number_from_text_comma(x) AS TRY_CAST(${numberText(T, true)} AS DOUBLE)`,
  `CREATE OR REPLACE TEMP MACRO number_from_cr_dr(x) AS TRY_CAST(${numberText(T, false, true)} AS DOUBLE)`,
  `CREATE OR REPLACE TEMP MACRO percent_from_text(x) AS TRY_CAST(${numberText(`rtrim(${T}, '%')`, false)} AS DOUBLE) / 100`,
  `CREATE OR REPLACE TEMP MACRO percent_from_text_comma(x) AS TRY_CAST(${numberText(`rtrim(${T}, '%')`, true)} AS DOUBLE) / 100`,
  // %Y also reads "24" as the year 24: only values with a four-digit year qualify. Two-digit years are
  // read as spreadsheets read them: 30–99 are 1930–1999, 00–29 are 2000–2029.
  `CREATE OR REPLACE TEMP MACRO date_from_text(x, fmt) AS CASE
    WHEN contains(fmt, '%Y') THEN CASE WHEN regexp_matches(${T}, '[0-9]{4}') THEN try_strptime(${T}, fmt)::DATE END
    WHEN year(try_strptime(${T}, fmt)) >= 2030 THEN (try_strptime(${T}, fmt) - INTERVAL 100 YEAR)::DATE
    ELSE try_strptime(${T}, fmt)::DATE END`,
  `CREATE OR REPLACE TEMP MACRO tidy_spaces(x) AS nullif(regexp_replace(${T}, '\\s+', ' ', 'g'), '')`,
  // "aSHA  rao" → "Asha Rao": each word capitalised, the rest lower-case.
  `CREATE OR REPLACE TEMP MACRO title_case(x) AS list_aggregate(list_transform(string_split(lower(${T}), ' '), w -> upper(left(w, 1)) || substr(w, 2)), 'string_agg', ' ')`,
  // For leaving out rows that aren't data, readably: a cell with something in it, and the labels of a
  // report's total lines. The patterns only run on the few values that mention "total".
  `CREATE OR REPLACE TEMP MACRO has_value(x) AS coalesce(trim(x::VARCHAR), '') <> ''`,
  `CREATE OR REPLACE TEMP MACRO is_grand_or_subtotal(x) AS CASE WHEN x::VARCHAR ILIKE '%total%' THEN regexp_full_match(lower(trim(x::VARCHAR)), '${GRAND_OR_SUB}') ELSE false END`,
  `CREATE OR REPLACE TEMP MACRO is_total_label(x) AS CASE WHEN x::VARCHAR ILIKE '%total%' THEN regexp_full_match(lower(trim(x::VARCHAR)), '${ANY_TOTAL}') ELSE false END`,
]

const IDENT = `"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*`
const PERCENT_AS = new RegExp(`percent_from_text(?:_comma)?\\(\\s*(?:${IDENT})\\s*\\)\\s+AS\\s+(${IDENT})`, 'gi')

/**
 * Columns a query converts from "18%" text (percent_from_text(x) AS x): shown as percentages wherever
 * the SQL came from (a clean-up, a saved view, a shared link, the editor).
 */
export function percentColumns(sql: string): string[] {
  return [...sql.matchAll(PERCENT_AS)].map((m) => (m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1]))
}

/** The cleaned value of one column, as SQL. */
export function cleanExpr(c: Clean): string {
  const col = sqlName(c.column)
  const text = textOf(col)
  switch (c.kind) {
    case 'number':
      return c.drcr ? `number_from_cr_dr(${col})` : `number_from_text${c.comma ? '_comma' : ''}(${col})`
    case 'percent':
      return `percent_from_text${c.comma ? '_comma' : ''}(${col})`
    case 'date':
      return `date_from_text(${col}, ${quoteLiteral(c.format ?? '%Y-%m-%d')})`
    case 'trim':
      return `tidy_spaces(${col})`
    case 'upper':
      return `upper(${col})`
    case 'lower':
      return `lower(${col})`
    case 'title':
      return `title_case(${col})`
    case 'blank':
      return `nullif(${text}, '')`
    case 'replace': {
      const to = c.to === null || c.to === undefined || c.to === '' ? 'NULL' : quoteLiteral(c.to)
      return `CASE WHEN lower(trim(${col})) = lower(${quoteLiteral((c.from ?? '').trim())}) THEN ${to} ELSE ${col} END`
    }
    case 'swapdm':
      // A date the file reader read the other way round (01/02 as 1 February, meant as January 2nd).
      // Only dates up to the 12th can be read both ways: any other is left empty, never made up.
      return `CASE WHEN day(${col}) <= 12 THEN make_date(year(${col}), day(${col}), month(${col})) END`
    case 'filldown':
      // The last non-empty value at or above each row, in the rows' own order.
      return `last_value(CASE WHEN has_value(${col}) THEN ${col} END IGNORE NULLS) OVER (ORDER BY ${FILL_POS} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`
  }
}

export const CLEAN_LABEL: Record<CleanKind, string> = {
  number: 'as number',
  percent: 'as number (from %)',
  date: 'as date',
  trim: 'trimmed',
  upper: 'UPPER CASE',
  lower: 'lower case',
  title: 'Title Case',
  blank: 'blanks as empty',
  filldown: 'filled down',
  swapdm: 'day and month swapped',
  replace: 'values replaced',
}

/** Spaces at either end, made visible ("Mumbai␣"): otherwise "Mumbai " → "Mumbai" reads as nothing changing. */
export const visibleSpaces = (v: string) => v.replace(/^\s+|\s+$/g, (m) => '␣'.repeat(m.length)).replace(/\s{2,}/g, (m) => '␣'.repeat(m.length))
const shown = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 'empty' : `“${visibleSpaces(v)}”`)

export const describeClean = (c: Clean) =>
  `${c.column} ${
    c.kind === 'date'
      ? `as date (${formatLabel(c.format)})`
      : c.kind === 'number' && c.drcr
        ? 'as number (Cr +, Dr −)'
        : c.kind === 'number' && c.comma
        ? 'as number (decimal comma)'
        : c.kind === 'replace'
          ? `${shown(c.from)} → ${shown(c.to)}`
          : CLEAN_LABEL[c.kind]
  }`

const CONVERSIONS: CleanKind[] = ['number', 'percent', 'date']
const CASES: CleanKind[] = ['upper', 'lower', 'title']
export const isConversion = (c: Clean) => CONVERSIONS.includes(c.kind)

/**
 * Adds a cleaning step. Steps on one column stack (trim, then Title case), but one of each sort: a new
 * case replaces the old case, a new conversion the old conversion, and a conversion comes last (after
 * it the column isn't text any more).
 */
export function addClean(list: Clean[], c: Clean): Clean[] {
  // Replacing one value stacks with replacing another; replacing the same value again replaces the step.
  const sort = (x: Clean) =>
    CONVERSIONS.includes(x.kind) ? 'convert' : CASES.includes(x.kind) ? 'case' : x.kind === 'replace' ? `replace:${(x.from ?? '').trim().toLowerCase()}` : x.kind
  const same = list.findIndex((x) => x.column === c.column && sort(x) === sort(c))
  // A new case (or the same value replaced again) takes the old step's place: steps after it were
  // written against its output ("Ravi Kumar" after Title case) and still need it first.
  if (same >= 0) return list.map((x, i) => (i === same ? c : x))
  const kept = list
  const conversion = kept.find((x) => x.column === c.column && isConversion(x))
  if (!conversion || isConversion(c)) return [...kept, c]
  // Keep the conversion after the text steps for this column.
  return [...kept.filter((x) => x !== conversion), c, conversion]
}

/**
 * SELECT * REPLACE (…) FROM src: the cleaned columns keep their names and positions. Several steps on
 * one column become successive layers, each reading the previous one.
 */
export function cleanSql(src: string, list: Clean[]): string {
  if (!list.length) return `SELECT * FROM ${src}`
  const layers: Clean[][] = [[]]
  const fills = (l: Clean[]) => l.some((x) => x.kind === 'filldown')
  for (const c of list) {
    const last = layers[layers.length - 1]
    // Fill-down steps share a layer that numbers the rows; other steps never join it.
    if (last.some((x) => x.column === c.column) || (last.length > 0 && fills(last) !== (c.kind === 'filldown'))) layers.push([c])
    else last.push(c)
  }
  let sql = src
  layers.forEach((layer, i) => {
    const replace = layer.map((c) => `${cleanExpr(c)} AS ${sqlName(c.column)}`).join(',\n  ')
    const body = fills(layer)
      ? `SELECT * EXCLUDE (${FILL_POS}) REPLACE (\n  ${replace}\n)\nFROM (SELECT *, row_number() OVER () AS ${FILL_POS} FROM ${sql})\nORDER BY ${FILL_POS}`
      : `SELECT * REPLACE (\n  ${replace}\n)\nFROM ${sql}`
    sql = i === layers.length - 1 ? body : `(\n${body}\n)`
  })
  return sql
}


/* ------------------------- Rows that aren't data ------------------------- */

/** Rows to leave out of the data: a report's "Grand Total" lines, rows with nothing in them. */
export interface DropRows {
  label: string
  /** True for the rows to keep (written against the table's columns; never NULL). */
  keep: string
  /** The tie-out: whether their numbers come to the rows kept (sub-totals, a grand total), column by column. */
  checked?: TieOut
  /** What these rows are: total lines (the ones a tie-out adds up), a statement's balance lines, empty rows. */
  kind?: 'totals' | 'balance' | 'empty'
}

export interface TieOut {
  /** Columns whose total lines come to exactly the rows kept (the largest sum first). */
  ok: { column: string; sum: number }[]
  /** Columns whose total lines don't: what the lines say, and what the rows come to. */
  off: { column: string; says: number; rows: number }[]
}

/**
 * The tie-out, column by column: the total lines' sum (t) against the rows kept (d), exact to a hundredth
 * (a total written as a whole number may be off by a half). Sub-totals with a grand total come to twice
 * the rows. A column whose lines are nowhere near either (a closing balance, a rate) isn't one they total.
 */
export function readTieOut(pairs: { column: string; t: number | null; d: number | null }[]): TieOut | null {
  const ok: TieOut['ok'] = []
  const off: TieOut['off'] = []
  for (const { column, t, d } of pairs) {
    if (typeof t !== 'number' || typeof d !== 'number' || !d) continue
    const r = t / d
    const k = r > 0.5 && r < 1.5 ? 1 : r >= 1.5 && r < 2.5 ? 2 : 0
    if (!k) continue
    const gap = Math.abs(t - k * d)
    if (gap < 0.005 * k + Math.abs(t) * 1e-9 || (Number.isInteger(t) && gap <= 0.5 * k)) ok.push({ column, sum: d })
    else off.push({ column, says: t / k, rows: d })
  }
  ok.sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))
  return ok.length || off.length ? { ok, off } : null
}

/** One kind of row that isn't data, as SQL: true for those rows (drop), and its opposite (keep). */
export interface Junk {
  drop: string
  keep: string
}


/**
 * Rows that aren't data, given the table's columns as SQL references:
 *   - blank: nothing in any column
 *   - strong: "Grand Total", "Sub-total:", "Subtotal" in any text column (never a real value)
 *   - weak: "Total" or "North Total" (Excel's subtotal lines) in the first text column, in a row with at
 *     least one empty cell: a fuel brand called Total, or a census row for both sexes, fills its row
 * The keep forms are written out (not NOT(drop)) so a filter can stop at the first column that settles
 * it, and the patterns only run on the few values that mention "total".
 */
export function junkPredicates(cols: { ref: string; text: boolean }[]): { blank: Junk; strong: Junk | null; weak: Junk | null; label: Junk | null; first: string | null } {
  const empty = (r: string) => `NOT has_value(${r})`
  const filled = (r: string) => `has_value(${r})`
  // Each one is parenthesised, so it can be combined with AND / OR as it is.
  const all = (parts: string[], op: 'AND' | 'OR') => (parts.length > 1 ? `(${parts.join(` ${op} `)})` : (parts[0] ?? (op === 'AND' ? 'true' : 'false')))
  const blank = { drop: cols.length ? all(cols.map((c) => empty(c.ref)), 'AND') : 'false', keep: cols.length ? all(cols.map((c) => filled(c.ref)), 'OR') : 'true' }
  const texts = cols.filter((c) => c.text)
  if (!texts.length) return { blank, strong: null, weak: null, label: null, first: null }
  const first = texts[0].ref
  return {
    blank,
    strong: { drop: all(texts.map((c) => `is_grand_or_subtotal(${c.ref})`), 'OR'), keep: all(texts.map((c) => `NOT is_grand_or_subtotal(${c.ref})`), 'AND') },
    weak: {
      drop: `(is_total_label(${first}) AND ${all(cols.map((c) => empty(c.ref)), 'OR')})`,
      keep: `(NOT is_total_label(${first}) OR ${all(cols.map((c) => filled(c.ref)), 'AND')})`,
    },
    // "Total" in the first text column, however full the row: trusted once its numbers add up (see totalsAddUp).
    label: { drop: `is_total_label(${first})`, keep: `NOT is_total_label(${first})` },
    first,
  }
}

/** A column's values as numbers, for checking totals ("₹1,200" text too). */
const asNumber = (c: { ref: string; numeric?: boolean }) => (c.numeric ? `TRY_CAST(${c.ref} AS DOUBLE)` : `number_from_text(${c.ref}::VARCHAR)`)

/*
 * Checking that lines labelled "Total" really are totals, in two cheap steps: sum each other column over
 * the few labelled lines (t), then, only for the columns where that's a number, over the data rows (d).
 * A report's total line, or its sub-totals together, add up (t = d); sub-totals and a grand total both
 * labelled add up twice (t = 2d). A fuel brand called Total doesn't.
 */
export function labelSumsSql(table: string, cols: { ref: string; numeric?: boolean }[], label: Junk, first: string): string | null {
  const others = cols.filter((c) => c.ref !== first)
  if (!others.length) return null
  return `SELECT ${others.map((c, i) => `sum(${asNumber(c)})::DOUBLE AS t${i}`).join(', ')} FROM (SELECT * FROM ${table} WHERE ${label.drop})`
}

/** Sums of the given columns (by their index among the non-label columns) over the rows that are data. */
export function dataSumsSql(table: string, cols: { ref: string; numeric?: boolean }[], first: string, which: number[], keep: string): string {
  const others = cols.filter((c) => c.ref !== first)
  return `SELECT ${which.map((i) => `sum(${asNumber(others[i])})::DOUBLE AS d${i}`).join(', ')} FROM (SELECT * FROM ${table} WHERE ${keep})`
}

/** Whether the labelled lines add up: in at least half the columns that hold numbers, and at least one. */
export function totalsAgree(pairs: { t: number; d: number }[]): boolean {
  const close = (a: number, b: number) => b !== 0 && Math.abs(a - b) <= Math.abs(b) * 0.005
  const agree = pairs.filter((p) => close(p.t, p.d) || close(p.t, 2 * p.d)).length
  return agree > 0 && agree * 2 >= pairs.length
}

/*
 * Group names written once, at the top of each group (a report's Region over its invoices): fill down.
 * Counted over the rows that are data (empty rows and total lines sit between the groups), in the
 * table's own order: how many rows, how many have a value, how often a value is followed by another,
 * whether the first row has one, and the longest value.
 */
export function fillDownSql(table: string, col: string, cols: string[]): string {
  const { blank } = junkPredicates(cols.map((ref) => ({ ref, text: false })))
  const notTotal = `NOT is_grand_or_subtotal(${col}) AND NOT is_total_label(${col})`
  return `SELECT count(*)::DOUBLE AS n, count(v)::DOUBLE AS filled,
  count(*) FILTER (WHERE v IS NOT NULL AND nxt IS NOT NULL)::DOUBLE AS pairs,
  coalesce(bool_or(i = 1 AND v IS NOT NULL), false) AS first, coalesce(max(length(v)), 0)::DOUBLE AS len
FROM (SELECT v, lead(v) OVER (ORDER BY r) AS nxt, row_number() OVER (ORDER BY r) AS i
  FROM (SELECT rowid AS r, nullif(trim(${col}::VARCHAR), '') AS v FROM ${table} WHERE ${blank.keep} AND ${notTotal}))`
}

/**
 * Whether those counts are a group column's: the first row named, at least 3 rows in 10 empty, and a
 * value seldom followed by another (each group has more than one row). A column filled in now and then
 * (a phone number, a note) has its values anywhere, next to each other as often as not.
 */
export function looksFilledDown(s: { n: number; filled: number; pairs: number; first: boolean; len: number }): boolean {
  return s.first && s.n >= 6 && s.filled >= 2 && s.n - s.filled >= s.n * 0.3 && s.pairs <= s.filled * 0.25 && s.len <= 60
}

/** Rows that are either kind. */
export const eitherJunk = (a: Junk, b: Junk): Junk => ({ drop: `(${a.drop} OR ${b.drop})`, keep: `(${a.keep} AND ${b.keep})` })

/* ------------------------------ Detection ------------------------------ */

/** Text columns are the ones worth cleaning (numbers and dates already have a type). Lists are not text. */
export const isTextColumn = (type: string) => /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)(\s*\(\s*\d+\s*\))?$/i.test(type.trim())

/** Names of columns that hold codes made of digits (PIN, phone, account): text on purpose. */
const CODE_NAME = /(^|_)(id|code|zip|zipcode|pin|pincode|postcode|post_code|postal|phone|mobile|tel|telephone|contact|account|acct|ifsc|pan|aadhaar|uid|sku|ref|no|num|number)(_|$)/

/** Conversions safe to offer for a whole table at once: every sampled value converts, one way only. */
export function confidentConversion(suggestions: CleanSuggestion[]): Clean | null {
  const convert = suggestions.filter((s) => isConversion(s.clean))
  if (convert.length !== 1 || convert[0].note || CODE_NAME.test(nameKey(convert[0].clean.column))) return null
  return convert[0].clean
}

export interface CleanStats {
  /** Non-empty values in the sample. */
  values: number
  /** Values that read as numbers with a decimal point, and with a decimal comma. */
  numbers: number
  commaNumbers: number
  /** Values only one of the readings can explain (12.5 / 12,5). */
  pointOnly: number
  commaOnly: number
  percents: number
  commaPercents: number
  /** Values that parse with each of DATE_FORMATS, in order. */
  dates: number[]
  /** Values with spaces at either end or doubled inside. */
  untrimmed: number
  blanks: number
  /** Values with a leading zero (007): codes, which a number would change. */
  zeros: number
  /** Values that read as numbers with Cr as plus and Dr as minus; and how many are marked Dr. */
  drcrNumbers: number
  debits: number
}

/** The counts for one column (refs are SQL for the column), as select-list items prefixed `p`. */
function statsItems(ref: string, p: string): string[] {
  const v = textOf(ref)
  const parses = (expr: string) => `count(TRY_CAST(${expr} AS DOUBLE))::DOUBLE`
  const pct = `rtrim(${v}, '%')`
  // For telling 12.5 from 12,5: the value without currency signs and spaces.
  const bare = `regexp_replace(${v}, '[₹$€£¥\\s]', '', 'g')`
  return [
    `count(nullif(${v}, ''))::DOUBLE AS ${p}values`,
    `${parses(numberText(v, false))} AS ${p}numbers`,
    `${parses(numberText(v, true))} AS ${p}comma_numbers`,
    `count(*) FILTER (WHERE regexp_full_match(${bare}, '[-+(]?[0-9]*\\.[0-9]{1,2}%?\\)?|[-+(]?[0-9]{1,3}(,[0-9]{2,3})+\\.[0-9]+%?\\)?'))::DOUBLE AS ${p}point_only`,
    `count(*) FILTER (WHERE regexp_full_match(${bare}, '[-+(]?[0-9]*,[0-9]{1,2}%?\\)?|[-+(]?[0-9]{1,3}(\\.[0-9]{3})+,[0-9]+%?\\)?'))::DOUBLE AS ${p}comma_only`,
    `count(*) FILTER (WHERE ${v} LIKE '%\\%' ESCAPE '\\' AND TRY_CAST(${numberText(pct, false)} AS DOUBLE) IS NOT NULL)::DOUBLE AS ${p}percents`,
    `count(*) FILTER (WHERE ${v} LIKE '%\\%' ESCAPE '\\' AND TRY_CAST(${numberText(pct, true)} AS DOUBLE) IS NOT NULL)::DOUBLE AS ${p}comma_percents`,
    ...DATE_FORMATS.map((f, i) => {
      const hit = `try_strptime(${v}, ${quoteLiteral(f.format)}) IS NOT NULL`
      return `count(*) FILTER (WHERE ${hit}${f.format.includes('%Y') ? ` AND regexp_matches(${v}, '[0-9]{4}')` : ''})::DOUBLE AS ${p}d${i}`
    }),
    `count(*) FILTER (WHERE ${ref}::VARCHAR <> regexp_replace(${v}, '\\s+', ' ', 'g'))::DOUBLE AS ${p}untrimmed`,
    `count(*) FILTER (WHERE ${ref} IS NOT NULL AND ${v} = '')::DOUBLE AS ${p}blanks`,
    // 007, 0456: codes, not quantities (converting would drop the zeros).
    `count(*) FILTER (WHERE regexp_full_match(${v}, '0[0-9]+'))::DOUBLE AS ${p}zeros`,
    `${parses(numberText(v, false, true))} AS ${p}drcr_numbers`,
    `count(*) FILTER (WHERE regexp_matches(${v}, '[0-9)]\\s*[dD][rR]\\.?$'))::DOUBLE AS ${p}debits`,
  ]
}

/**
 * One query over one sample of the table (up to `sampleRows` rows) with the counts for every column
 * given (refs are the columns as SQL). Read each column's counts with readStats(row, i).
 */
export function statsSql(table: string, refs: string[], sampleRows = 5000): string {
  const items = refs.flatMap((ref, i) => statsItems(ref, `c${i}_`))
  return `SELECT\n  ${items.join(',\n  ')}\nFROM (SELECT * FROM ${table} USING SAMPLE ${sampleRows} ROWS)`
}

export function readStats(row: Record<string, unknown>, i = 0): CleanStats {
  const n = (k: string) => Number(row[`c${i}_${k}`] ?? 0)
  return {
    values: n('values'),
    numbers: n('numbers'),
    commaNumbers: n('comma_numbers'),
    pointOnly: n('point_only'),
    commaOnly: n('comma_only'),
    percents: n('percents'),
    commaPercents: n('comma_percents'),
    dates: DATE_FORMATS.map((_, j) => n(`d${j}`)),
    untrimmed: n('untrimmed'),
    blanks: n('blanks'),
    zeros: n('zeros'),
    drcrNumbers: n('drcr_numbers'),
    debits: n('debits'),
  }
}

export interface CleanSuggestion {
  clean: Clean
  label: string
  /** e.g. "3 of 40 sampled values aren't numbers and become empty" */
  note?: string
}

const MOST = 0.9
/** Enough to offer converting "anyway" (in the column menu only, with how many values are lost). */
const SOME = 0.5


/** Locales that write 12,5 for twelve and a half (de, fr, es, it, pt, ru, id, nl, tr, …). */
export const usesDecimalComma = (locale: string) => {
  try {
    return (1.5).toLocaleString(locale).includes(',')
  } catch {
    return false
  }
}

/**
 * What to offer for a text column. Numbers and dates need at least 90% of values to parse (the rest
 * become empty, and the note says how many). Whether "1,234" is a thousand or one-point-something is
 * settled by values only one reading explains ("12,5", "3.25"), then by the reader's locale. When a
 * date could be DD/MM or MM/DD (no day above 12), the locale decides which is offered first.
 */
export function suggestCleaning(column: string, s: CleanStats, locale = 'en-IN', whole = true): CleanSuggestion[] {
  const out: CleanSuggestion[] = []
  if (!s.values) return s.blanks ? [{ clean: { column, kind: 'blank' }, label: 'Treat blanks as empty' }] : []
  const nf = (n: number) => n.toLocaleString(LOCALE)
  // Counts over every value when the sample was the whole table; else said as what they are (of those checked).
  const of = whole ? '' : ' checked'
  const lost = (ok: number, what: string) => {
    const bad = s.values - ok
    return bad > 0 ? `${nf(bad)} of ${nf(s.values)} values${of} aren’t ${what} and become empty` : undefined
  }
  /** "1 value has" / "3 values have" (or "3 of 5,000 values checked have"). */
  const sampled = (n: number, one: string, many: string) => `${nf(n)}${whole ? '' : ` of ${nf(s.values)}`} ${n === 1 && whole ? 'value' : 'values'}${of} ${n === 1 ? one : many}`
  const comma = s.commaOnly > 0 && s.pointOnly === 0 ? true : s.pointOnly > 0 ? false : usesDecimalComma(locale)
  const mixed = s.commaOnly > 0 && s.pointOnly > 0
  const numbers = comma ? s.commaNumbers : s.numbers
  const percents = comma ? s.commaPercents : s.percents
  const sep = comma ? ' (decimal comma)' : ''
  if (percents / s.values >= MOST) {
    out.push({ clean: { column, kind: 'percent', comma }, label: `Convert to number (12% → 0.12)${sep}`, note: lost(percents, 'percentages') })
  } else if (numbers / s.values >= MOST) {
    const note = s.zeros
      ? `${sampled(s.zeros, 'starts', 'start')} with 0 (like a code): the zeros would be dropped`
      : mixed
        ? 'Some values use a decimal point and others a decimal comma: check the result'
        : lost(numbers, 'numbers')
    out.push({ clean: { column, kind: 'number', comma }, label: `Convert to number${sep}`, note })
  } else if (s.debits > 0 && s.drcrNumbers / s.values >= SOME) {
    // A bank statement's balances: "50,000.00 Cr", "1,200.00 Dr". Some Dr: so Cr isn't crore here.
    const lostNote = lost(s.drcrNumbers, 'amounts')
    out.push({
      clean: { column, kind: 'number', drcr: true },
      label: 'Convert to number (Cr +, Dr −)',
      note: `Cr counts as plus and Dr as minus, as on a bank statement: check that’s what this file means${lostNote ? `. ${lostNote}` : ''}`,
    })
  } else if (numbers / s.values >= SOME) {
    // A footer or a few notes among the amounts (a bank statement's summary lines): still offered, saying what's lost.
    out.push({ clean: { column, kind: 'number', comma }, label: `Convert to number anyway${sep}`, note: lost(numbers, 'numbers') })
  }
  const dateHits = s.dates
    .map((hits, i) => ({ hits, f: DATE_FORMATS[i] }))
    .filter((d) => d.hits / s.values >= MOST)
    .sort((a, b) => b.hits - a.hits)
  if (dateHits.length && !out.length) {
    const best = dateHits[0].hits
    // 03/04/2024: April 3rd in most of the world, March 4th in the US.
    const usFirst = /^en-US$/i.test(locale)
    const tied = dateHits
      .filter((d) => d.hits === best)
      .sort((a, b) => Number(/^%m/.test(b.f.format) === usFirst) - Number(/^%m/.test(a.f.format) === usFirst))
    for (const d of tied.slice(0, 2)) {
      out.push({ clean: { column, kind: 'date', format: d.f.format }, label: `Convert to date (${d.f.label})`, note: lost(d.hits, `dates like ${d.f.label}`) })
    }
  } else if (!out.length) {
    const some = s.dates.map((hits, i) => ({ hits, f: DATE_FORMATS[i] })).filter((d) => d.hits / s.values >= SOME).sort((a, b) => b.hits - a.hits)[0]
    if (some) out.push({ clean: { column, kind: 'date', format: some.f.format }, label: `Convert to date anyway (${some.f.label})`, note: lost(some.hits, `dates like ${some.f.label}`) })
  }
  if (s.untrimmed) out.push({ clean: { column, kind: 'trim' }, label: 'Trim extra spaces', note: `${sampled(s.untrimmed, 'has', 'have')} extra spaces` })
  if (s.blanks) out.push({ clean: { column, kind: 'blank' }, label: 'Treat blanks as empty', note: `${sampled(s.blanks, 'is', 'are')} blank` })
  return out
}
