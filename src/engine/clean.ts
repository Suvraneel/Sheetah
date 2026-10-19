import { quoteLiteral, sqlName } from './sql'

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
  /** For 'date': more layouts, each tried after the one before (a column in two: 2024-04-01 and 01/04/2024). */
  formats?: string[]
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
export const textOf = (ref: string) => `trim(${ref}::VARCHAR)`

/**
 * A number written the way people write them, as SQL text DuckDB can cast. Currency signs go, "(250)"
 * means −250, and separators must be where a thousands separator can be (groups of three): otherwise
 * the value is left unreadable, so "12,5" can't turn into 125. Spaces inside go when they group threes
 * (1 234 567; any, when commas mark decimals: 1 234,56), so a phone number like "98200 12345" isn't
 * mistaken for one. A statistics office's marks after a figure go too: 1,234[note 3], 108,021 (p), 56*.
 */
/** A figure without a statistics office's marks after it: [note 3], [x], (p) provisional, (r) revised, (e), *; one or several. */
export const marksOff = (t: string) => `regexp_replace(${t}, '(\\s*(\\[[^\\]]{1,20}\\]|\\((p|r|e|f|est|prov|provisional|revised|estimated?)\\)|\\*+))+\\s*$', '', 'i')`

export function numberText(t: string, comma: boolean, drcr = false): string {
  // "50,000.00 Cr" / "1,200.00 Dr": a bank statement's credit and debit, plus and minus. Only when asked
  // for: on its own, "₹12 Cr" is twelve crore.
  const debit = drcr ? `regexp_matches(${t}, '[0-9)]\\s*[dD][rR]\\.?$')` : 'false'
  const crdr = drcr ? `regexp_replace(${t}, '([0-9)])\\s*([cC][rR]|[dD][rR])\\.?$', '\\1')` : t
  // The currency in letters too: "Rs. 25,000", "INR 7,500", "1,200/-" (as cheques write it).
  const unmarked = `regexp_replace(${marksOff(crdr)}, '^\\s*(rs\\.|rs\\s|inr|usd|eur|gbp)\\s*|\\s*(inr|usd|eur|gbp|/-)\\s*$', '', 'gi')`
  const noCurrency = `regexp_replace(${unmarked}, '[₹$€£¥${comma ? '\\s\u00a0\u202f' : ''}]', '', 'g')`
  const grouped = comma
    ? noCurrency
    : `CASE WHEN regexp_full_match(trim(${noCurrency}), '[-+(]?[0-9]{1,3}([ \u00a0\u202f][0-9]{3})+(\\.[0-9]+)?\\)?') THEN regexp_replace(${noCurrency}, '[ \u00a0\u202f]', '', 'g') ELSE ${noCurrency} END`
  // (1,200.00) and 1,200.00- (a trailing minus, as SAP and some ledgers write it) are negative: with a
  // separator in it, so 2024- or 60- (a range, a year) isn't read as minus anything.
  const negative = `regexp_replace(regexp_replace(trim(${grouped}), '^\\(\\s*(.*?)\\s*\\)$', '-\\1'), '^([0-9][0-9.,]*[.,][0-9]+)\\s*-$', '-\\1')`
  // A separator followed by anything but three digits isn't a thousands separator (two are allowed
  // before another comma: Indian grouping, 1,00,000).
  const badGroup = comma ? `'\\.([0-9]{0,2}([^0-9]|$)|[0-9]{4})'` : `',([0-9]?([^0-9]|$)|[0-9]{2}([^0-9,]|$)|[0-9]{4})'`
  const plain = comma ? `replace(replace(${negative}, '.', ''), ',', '.')` : `replace(${negative}, ',', '')`
  // A figure has a digit in it: NaN, inf and Infinity (which the engine would read as numbers) are no
  // figure, and 1_000 (which it reads as a thousand) isn't how anyone writes one.
  const ok = `regexp_matches(${negative}, '[0-9]') AND NOT contains(${negative}, '_') AND NOT regexp_matches(${negative}, ${badGroup})`
  return drcr ? `CASE WHEN ${ok} THEN (CASE WHEN ${debit} THEN '-' ELSE '' END) || ${plain} END` : `CASE WHEN ${ok} THEN ${plain} END`
}

/*
 * The conversions are macros, defined in every connection when the engine starts (and in the unit
 * tests' engine), so the SQL a clean-up writes stays short enough to read:
 *   number_from_text(amount)  ·  date_from_text(paid_on, '%d/%m/%Y')  ·  title_case(name)
 */
const T = textOf('x')
const GRAND_OR_SUB = '(grand|sub)[ -]*totals?:?'
// "North Total", "Total:"; and a report's "Total for Acme Corp" (QuickBooks), "Total of Region" — not "Total Gym".
const ANY_TOTAL = '(.*[^ ] +)?totals?:?|totals? (for|of) .+'

export const CLEAN_MACROS: string[] = [
  `CREATE OR REPLACE TEMP MACRO number_from_text(x) AS TRY_CAST(${numberText(T, false)} AS DOUBLE)`,
  `CREATE OR REPLACE TEMP MACRO number_from_text_comma(x) AS TRY_CAST(${numberText(T, true)} AS DOUBLE)`,
  `CREATE OR REPLACE TEMP MACRO number_from_cr_dr(x) AS TRY_CAST(${numberText(T, false, true)} AS DOUBLE)`,
  `CREATE OR REPLACE TEMP MACRO percent_from_text(x) AS TRY_CAST(${numberText(`rtrim(trim(${marksOff(T)}), '%')`, false)} AS DOUBLE) / 100`,
  `CREATE OR REPLACE TEMP MACRO percent_from_text_comma(x) AS TRY_CAST(${numberText(`rtrim(trim(${marksOff(T)}), '%')`, true)} AS DOUBLE) / 100`,
  // %Y also reads "24" as the year 24: only values with a four-digit year qualify. Two-digit years are
  // read as spreadsheets read them: 30–99 are 1930–1999, 00–29 are 2000–2029.
  // (A date has a digit in it: "-Infinity" reads as one to the engine, and isn't.)
  `CREATE OR REPLACE TEMP MACRO date_from_text(x, fmt) AS CASE
    WHEN NOT regexp_matches(${T}, '[0-9]') THEN NULL
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
    case 'date': {
      const all = [c.format ?? '%Y-%m-%d', ...(c.formats ?? [])]
      const one = (f: string) => `date_from_text(${col}, ${quoteLiteral(f)})`
      return all.length > 1 ? `coalesce(${all.map(one).join(', ')})` : one(all[0])
    }
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
  trim: 'spaces tidied',
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
      ? `as date (${[c.format, ...(c.formats ?? [])].map(formatLabel).join(' or ')})`
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
  kind?: 'totals' | 'balance' | 'undated' | 'notes' | 'empty'
}

export interface TieOut {
  /** Columns whose total lines come to exactly the rows kept (the largest sum first). */
  ok: { column: string; sum: number }[]
  /** Columns whose total lines don't: what the lines say, and what the rows come to. */
  off: { column: string; says: number; rows: number }[]
}
