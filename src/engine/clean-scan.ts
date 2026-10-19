/*
 * Looking a table's text over (loaded with the table scans, not the first screen): which columns are
 * numbers or dates stored as text and how sure that is, total lines and empty rows, groups to fill down,
 * and the tie-out of total lines against the rows they total.
 */
import { DATE_FORMATS, isConversion, marksOff, textOf, type Clean, type TieOut } from './clean'
import { isIdLike, LOCALE, nameKey, quoteLiteral } from './sql'

/** A running balance's name ("Closing Balance", "Bal"), as statement.ts reads one. */
const balanceName = (name: string) => /(^|_)(balance|bal|closing_balance|running_balance)(_|$)/.test(nameKey(name))

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
export function junkPredicates(cols: { ref: string; text: boolean; name?: string }[]): { blank: Junk; strong: Junk | null; weak: Junk | null; label: Junk | null; first: string | null } {
  const empty = (r: string) => `NOT has_value(${r})`
  const filled = (r: string) => `has_value(${r})`
  // Each one is parenthesised, so it can be combined with AND / OR as it is.
  const all = (parts: string[], op: 'AND' | 'OR') => (parts.length > 1 ? `(${parts.join(` ${op} `)})` : (parts[0] ?? (op === 'AND' ? 'true' : 'false')))
  const blank = { drop: cols.length ? all(cols.map((c) => empty(c.ref)), 'AND') : 'false', keep: cols.length ? all(cols.map((c) => filled(c.ref)), 'OR') : 'true' }
  const texts = cols.filter((c) => c.text)
  if (!texts.length) return { blank, strong: null, weak: null, label: null, first: null }
  const first = texts[0].ref
  // A first text column that's dates or codes (dates not converted yet, a Ref. No.): the label can be in the
  // first one that names things instead (Tally's "Current Total" under Particulars, "Total" under Party).
  const names = (c: { name?: string }) => c.name === undefined || !(/(^|_)(date|dt|on)$|^date/.test(nameKey(c.name)) || isIdLike(c.name))
  const labels = [texts[0], ...(names(texts[0]) ? [] : texts.filter((c) => c !== texts[0] && names(c)).slice(0, 1))].map((c) => c.ref)
  const labelled = all(labels.map((r) => `is_total_label(${r})`), 'OR')
  const unlabelled = all(labels.map((r) => `NOT is_total_label(${r})`), 'AND')
  return {
    blank,
    strong: { drop: all(texts.map((c) => `is_grand_or_subtotal(${c.ref})`), 'OR'), keep: all(texts.map((c) => `NOT is_grand_or_subtotal(${c.ref})`), 'AND') },
    weak: {
      drop: `(${labelled} AND ${all(cols.map((c) => empty(c.ref)), 'OR')})`,
      keep: `(${unlabelled} OR ${all(cols.map((c) => filled(c.ref)), 'AND')})`,
    },
    // "Total" in the label column, however full the row: trusted once its numbers add up (see totalsAddUp).
    label: { drop: labelled, keep: unlabelled },
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
  let convert = suggestions.filter((s) => isConversion(s.clean))
  // Dates that read both ways (01/04/24, no day past the 12th): the reader's way, offered first, as the file
  // reader does (the column menu has the other).
  const swap = (f = '') => f.replace(/%d|%m/g, (x) => (x === '%d' ? '%m' : '%d'))
  if (convert.length === 2 && convert.every((s) => s.clean.kind === 'date') && convert[0].clean.format === swap(convert[1].clean.format)) convert = [convert[0]]
  if (convert.length !== 1 || (convert[0].note && !convert[0].quiet) || CODE_NAME.test(nameKey(convert[0].clean.column))) return null
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
  /** Values in groups of three either way could be thousands or decimals (1,234 / 1.234). */
  ambComma?: number
  ambPoint?: number
  /** Placeholders for a figure that isn't there: x, .., :, -, c (suppressed), n/a. */
  placeholders?: number
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

/**
 * Values only a decimal point (or only a decimal comma) explains: 12.5, 0.750 (no one writes 750 so),
 * 1.2345 (not a group of three), 1,234.5; and the same the other way round. (1234.567 too, a point only:
 * "1234,567" is as often two codes in a cell as a decimal.)
 */
/**
 * The counts are worked out over a column's distinct values in the sample, each weighted by its rows (`__n`):
 * the same numbers as counting rows, but a column of 5,000 rows and five cities works out each city once.
 * What only a number or a date can be is worked out only for values that could be one (`__num`, `__date`):
 * user_42 or a@b.c is never put through the conversions, or 22 date formats.
 */
/** `full`: false for a column none of whose sampled values could be a number (its numbers' counts are 0, unplanned). */
const counter = (full: boolean) => ({
  /** Rows where `cond` holds. */
  where: (cond: string) => `coalesce(sum(__n) FILTER (WHERE ${cond}), 0)::DOUBLE`,
  /** Rows where `expr` isn't NULL. */
  some: (expr: string) => `coalesce(sum(__n) FILTER (WHERE (${expr}) IS NOT NULL), 0)::DOUBLE`,
  // (CASE, not AND: the engine works out a CASE's THEN only for the values its WHEN lets through.)
  /** The same, among values that could be a number. */
  whereNum: (cond: string) => (full ? `coalesce(sum(__n) FILTER (WHERE CASE WHEN __num THEN (${cond}) ELSE false END), 0)::DOUBLE` : '0::DOUBLE'),
  someNum: (expr: string) => (full ? `coalesce(sum(__n) FILTER (WHERE CASE WHEN __num THEN (${expr}) IS NOT NULL ELSE false END), 0)::DOUBLE` : '0::DOUBLE'),
  /** Among values that could be a date. */
  whereDate: (cond: string) => (full ? `coalesce(sum(__n) FILTER (WHERE CASE WHEN __date THEN (${cond}) ELSE false END), 0)::DOUBLE` : '0::DOUBLE'),
})
type Count = ReturnType<typeof counter>

/**
 * The rows the counts are made on: up to `rows` of the table, the same ones each time it's asked (so a first
 * look at which columns could hold numbers and the counts after it see the same values).
 */
const sampleOf = (table: string, rows: number) => `SELECT * FROM ${table} USING SAMPLE reservoir(${rows} ROWS) REPEATABLE (7)`

/**
 * Whether a value could be a number at all, cheaply: a digit in it, none of the characters no amount is
 * written with (user_42, a@b.c, 10:30), and no more letters than "Rs. 1,200 [note 3] Dr" has. A date (as
 * DATE_FORMATS write one) is made of digits, spaces, - / . , and at most a month's name (not INV-0042).
 */
const MAYBE_NUMBER = (v: string) => {
  // Notes after a figure ([note: 3], (provisional)) are left off first, as the conversions leave them off.
  const bare = `regexp_replace(${v}, '\\[[^\\]]*\\]|\\([^)]*\\)', '', 'g')`
  return `(regexp_matches(${v}, '[0-9]') AND NOT regexp_matches(${bare}, '[_@#:;=&|"!?<>{}~^\\\\]') AND length(regexp_replace(${bare}, '[^A-Za-z]', '', 'g')) <= 12)`
}
const MAYBE_DATE = (v: string) =>
  `(length(trim(${v})) BETWEEN 4 AND 30 AND regexp_full_match(lower(trim(${v})), '[0-9\\s,./-]*((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)?[0-9\\s,./-]*'))`

/** Each column's counts over its distinct values in one sample, side by side in one row. */
function byValue(table: string, refs: string[], sampleRows: number, items: (ref: string, p: string, k: Count) => string[], lite: boolean[] = []): string {
  // Each column's values as __val (a column of the table called __n or __num can't get in the way).
  const v = '__val::VARCHAR'
  const parts = refs.map((ref, i) => {
    const values = `(SELECT *, ${MAYBE_NUMBER(v)} AS __num FROM (SELECT ${ref} AS __val, count(*) AS __n FROM s GROUP BY ALL))`
    return `(SELECT ${items('__val', `c${i}_`, counter(!lite[i])).join(', ')} FROM (SELECT *, __num AND ${MAYBE_DATE(v)} AS __date FROM ${values})) AS q${i}`
  })
  return `WITH s AS (${sampleOf(table, sampleRows)})\nSELECT * FROM ${parts.join(',\n  ')}`
}

/**
 * For each column, whether any sampled value could be a number (or a date) at all: the ones that can't (emails,
 * names) are counted without the costly readings, which take the engine longer to plan than to run.
 */
export function maybeNumbersSql(table: string, refs: string[], sampleRows = 5000): string {
  return `WITH s AS (${sampleOf(table, sampleRows)})\nSELECT ${refs.map((ref, i) => `coalesce(bool_or(${MAYBE_NUMBER(`${ref}::VARCHAR`)}), false) AS m${i}`).join(', ')} FROM s`
}

function decimalItems(ref: string, p: string, count: Count): string[] {
  // The value without currency signs and spaces.
  const bare = `regexp_replace(${textOf(ref)}, '[₹$€£¥\\s]', '', 'g')`
  const only = (dec: string, group: string) => {
    const [d, g] = [dec === '.' ? '\\.' : dec, group === '.' ? '\\.' : group]
    const lead = dec === '.' ? `|([0-9]{4,}${d}[0-9]+)` : ''
    return `'[-+(]?(([0-9]*${d}[0-9]{1,2})|(0?${d}[0-9]+)|([0-9]{1,3}${d}[0-9]{4,})${lead}|([0-9]{1,3}(${g}[0-9]${group === ',' ? '{2,3}' : '{3}'})+${d}[0-9]+))%?\\)?'`
  }
  return [
    `${count.whereNum(`regexp_full_match(${bare}, ${only('.', ',')})`)} AS ${p}point_only`,
    `${count.whereNum(`regexp_full_match(${bare}, ${only(',', '.')})`)} AS ${p}comma_only`,
  ]
}

/** What statistics offices and spreadsheets write where there's no figure: x, .., :, -, c, z, n/a, [x]. */
const PLACEHOLDER = `'(x|\\.\\.?|:|-|–|—|c|z|u|n|s|n/?a|nil|none|null|\\*|\\?|\\[[a-z]\\]|\\([a-z]\\)|tbc|tba)'`

/** The counts for one column (refs are SQL for the column), as select-list items prefixed `p`. */
function statsItems(ref: string, p: string, count: Count): string[] {
  const v = textOf(ref)
  // The clean-up steps' own macros (number_from_text…): what a conversion would do, and short SQL however
  // many columns are counted.
  return [
    `${count.some(`nullif(${v}, '')`)} AS ${p}values`,
    `${count.someNum(`number_from_text(${ref})`)} AS ${p}numbers`,
    `${count.someNum(`number_from_text_comma(${ref})`)} AS ${p}comma_numbers`,
    ...decimalItems(ref, p, count),
    `${count.whereNum(`regexp_full_match(regexp_replace(${v}, '[₹$€£¥\\s]', '', 'g'), '[-+(]?[0-9]{1,3}(,[0-9]{3})+\\)?')`)} AS ${p}amb_comma`,
    `${count.where(`regexp_full_match(lower(${v}), ${PLACEHOLDER})`)} AS ${p}placeholders`,
    `${count.whereNum(`regexp_full_match(regexp_replace(${v}, '[₹$€£¥\\s]', '', 'g'), '[-+(]?[0-9]{1,3}(\\.[0-9]{3})+\\)?')`)} AS ${p}amb_point`,
    `${count.whereNum(`trim(${marksOff(v)}) LIKE '%\\%' ESCAPE '\\' AND percent_from_text(${ref}) IS NOT NULL`)} AS ${p}percents`,
    `${count.whereNum(`trim(${marksOff(v)}) LIKE '%\\%' ESCAPE '\\' AND percent_from_text_comma(${ref}) IS NOT NULL`)} AS ${p}comma_percents`,
    ...DATE_FORMATS.map((f, i) => {
      // (As date_from_text reads: a digit in it, four together for %Y; "-Infinity" is no date.)
      const hit = `regexp_matches(${v}, ${f.format.includes('%Y') ? "'[0-9]{4}'" : "'[0-9]'"}) AND try_strptime(${v}, ${quoteLiteral(f.format)}) IS NOT NULL`
      return `${count.whereDate(hit)} AS ${p}d${i}`
    }),
    `${count.where(`${ref}::VARCHAR <> regexp_replace(${v}, '\\s+', ' ', 'g')`)} AS ${p}untrimmed`,
    `${count.where(`${ref} IS NOT NULL AND ${v} = ''`)} AS ${p}blanks`,
    // 007, 0456: codes, not quantities (converting would drop the zeros).
    `${count.whereNum(`regexp_full_match(${v}, '0[0-9]+')`)} AS ${p}zeros`,
    `${count.someNum(`number_from_cr_dr(${ref})`)} AS ${p}drcr_numbers`,
    `${count.where(`regexp_matches(${v}, '[0-9)]\\s*[dD][rR]\\.?$')`)} AS ${p}debits`,
  ]
}

/**
 * One query over one sample of the table (up to `sampleRows` rows) with the counts for every column
 * given (refs are the columns as SQL). Read each column's counts with readStats(row, i). Each distinct
 * value is worked out once (a column of five cities costs five, not 5,000).
 */
export function statsSql(table: string, refs: string[], sampleRows = 5000, lite: boolean[] = []): string {
  return byValue(table, refs, sampleRows, statsItems, lite)
}

/**
 * For each conversion, how many values it would make empty over the whole table (not blanks, and not the
 * placeholders it's meant to empty: n/a, -, x): a sample saying "all convert" is checked before a chip
 * offers it in one click.
 */
export function lossesSql(table: string, items: { ref: string; expr: string }[]): string {
  const counts = items.map(({ ref, expr }, i) => {
    const v = textOf(ref)
    return `count(*) FILTER (WHERE nullif(${v}, '') IS NOT NULL AND NOT regexp_full_match(lower(${v}), ${PLACEHOLDER}) AND (${expr}) IS NULL)::DOUBLE AS l${i}`
  })
  return `SELECT ${counts.join(', ')} FROM ${table}`
}

/** Just what says how decimals are written, for each column (read with readStats: values, numbers, commaNumbers, pointOnly, commaOnly). */
export function decimalsSql(table: string, refs: string[], sampleRows = 5000): string {
  return byValue(table, refs, sampleRows, (ref, p, count) => [
    `${count.some(`nullif(${textOf(ref)}, '')`)} AS ${p}values`,
    `${count.someNum(`number_from_text(${ref})`)} AS ${p}numbers`,
    `${count.someNum(`number_from_text_comma(${ref})`)} AS ${p}comma_numbers`,
    ...decimalItems(ref, p, count),
  ])
}

/**
 * How the file writes decimals, from the columns that say (12,5 or 3.25): a comma, a point, or undefined
 * when none says or they disagree. A column of 1,500 and 10,125 alone can't tell; the price beside it can.
 * Only a column of amounts says: not one of codes ("1001,1002" in a cell, two phone numbers), and not one
 * that is mostly something else.
 */
export function fileDecimalComma(cols: { name: string; s: Pick<CleanStats, 'values' | 'numbers' | 'commaNumbers' | 'pointOnly' | 'commaOnly'> }[]): boolean | undefined {
  const says = cols.filter(({ name }) => !CODE_NAME.test(nameKey(name)) && !isIdLike(name))
  const comma = says.some(({ s }) => s.commaOnly > 0 && s.pointOnly === 0 && s.values > 0 && s.commaNumbers / s.values >= MOST)
  const point = says.some(({ s }) => s.pointOnly > 0 && s.commaOnly === 0 && s.values > 0 && s.numbers / s.values >= MOST)
  return comma === point ? undefined : comma
}

export function readStats(row: Record<string, unknown>, i = 0): CleanStats {
  const n = (k: string) => Number(row[`c${i}_${k}`] ?? 0)
  return {
    values: n('values'),
    numbers: n('numbers'),
    commaNumbers: n('comma_numbers'),
    pointOnly: n('point_only'),
    commaOnly: n('comma_only'),
    ambComma: n('amb_comma'),
    placeholders: n('placeholders'),
    ambPoint: n('amb_point'),
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
  /** The note is for information (placeholders that become empty, as they mean): still a one-click conversion. */
  quiet?: boolean
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
 * The two layouts that between them read most of a column's values (90%), each a good part of it: one per
 * shape (DD/MM/YYYY and MM/DD/YYYY are one shape, the reader's way first), so that no value reads in both.
 */
function twoLayouts(s: CleanStats, locale: string): [{ hits: number; f: (typeof DATE_FORMATS)[number] }, { hits: number; f: (typeof DATE_FORMATS)[number] }] | null {
  const usFirst = /^en-US$/i.test(locale)
  const shape = (f: string) => f.replace(/%d|%m/g, 'n')
  const best = new Map<string, { hits: number; f: (typeof DATE_FORMATS)[number] }>()
  s.dates.forEach((hits, i) => {
    const f = DATE_FORMATS[i]
    const k = shape(f.format)
    const had = best.get(k)
    const mineFirst = /^%m/.test(f.format) === usFirst
    if (hits > 0 && (!had || hits > had.hits || (hits === had.hits && mineFirst))) best.set(k, { hits, f })
  })
  const [a, b] = [...best.values()].sort((x, y) => y.hits - x.hits)
  if (!a || !b || b.hits / s.values < 0.05 || (a.hits + b.hits) / s.values < MOST || a.hits / s.values >= MOST) return null
  return [a, b]
}

/**
 * What to offer for a text column. Numbers and dates need at least 90% of values to parse (the rest
 * become empty, and the note says how many). Whether "1,234" is a thousand or one-point-something is
 * settled by values only one reading explains ("12,5", "0,750", "3.25"), then by how the file's other
 * columns write decimals (`fileComma`), then by the reader's locale. When a date could be DD/MM or MM/DD
 * (no day above 12), the locale decides which is offered first.
 */
export function suggestCleaning(column: string, s: CleanStats, locale = 'en-IN', whole = true, fileComma?: boolean): CleanSuggestion[] {
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
  const comma = s.commaOnly > 0 && s.pointOnly === 0 ? true : s.pointOnly > 0 ? false : (fileComma ?? usesDecimalComma(locale))
  const mixed = s.commaOnly > 0 && s.pointOnly > 0
  // Nothing in the file said, and this browser's way reads the groups of three as decimals: 194,661 in a
  // German browser, 1.500 in an English one. Said, and never in the one-click conversion (1000× off if wrong).
  const byHabit = s.commaOnly === 0 && s.pointOnly === 0 && fileComma === undefined
  const amb = byHabit ? (comma ? (s.ambComma ?? 0) : (s.ambPoint ?? 0)) : 0
  const guessed = amb
    ? `${nf(amb)} ${amb === 1 ? 'value is' : 'values are'} written like ${comma ? '1,234' : '1.234'}: read with a decimal ${comma ? 'comma' : 'point'} (1 and 234 thousandths), as this browser writes numbers, not as 1234. Check that’s what the file means`
    : undefined
  const numbers = comma ? s.commaNumbers : s.numbers
  const percents = comma ? s.commaPercents : s.percents
  const sep = comma ? ' (decimal comma)' : ''
  // Placeholders count as numbers to come (they become empty, as they mean): "x" for a suppressed figure.
  const known = s.placeholders ?? 0
  const lostOnlyPlaceholders = (ok: number) => known > 0 && s.values - ok <= known && ok > 0
  const placeholderNote = `${nf(known)} ${known === 1 ? 'value is a placeholder' : 'values are placeholders'} for no figure (x, .., :, -) and ${known === 1 ? 'becomes' : 'become'} empty`
  if (percents / s.values >= MOST) {
    out.push({ clean: { column, kind: 'percent', comma }, label: `Convert to number (12% → 0.12)${sep}`, note: lost(percents, 'percentages') })
  } else if (numbers / s.values >= MOST || ((numbers + known) / s.values >= MOST && lostOnlyPlaceholders(numbers))) {
    const quiet = !s.zeros && !mixed && !guessed && lostOnlyPlaceholders(numbers)
    const note = s.zeros
      ? `${sampled(s.zeros, 'starts', 'start')} with 0 (like a code): the zeros would be dropped`
      : mixed
        ? 'Some values use a decimal point and others a decimal comma: check the result'
        : (guessed ?? (quiet ? placeholderNote : lost(numbers, 'numbers')))
    out.push({ clean: { column, kind: 'number', comma }, label: `Convert to number${sep}`, note, ...(quiet ? { quiet } : {}) })
  } else if ((s.debits > 0 && s.drcrNumbers / s.values >= SOME) || (balanceName(column) && s.drcrNumbers / s.values >= MOST)) {
    // A bank statement's balances: "50,000.00 Cr", "1,200.00 Dr". Some Dr, or a column named for a balance:
    // so Cr isn't crore here (a balance in credit all month is all Cr).
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
  } else if (!out.length && twoLayouts(s, locale)) {
    // A column in two layouts (2024-04-01 and 01/04/2024, as two exports put together write it): each value
    // read in the layout it's written in. Only layouts no value can be read in both ways (not DD/MM and MM/DD).
    const [a, b] = twoLayouts(s, locale)!
    out.push({
      clean: { column, kind: 'date', format: a.f.format, formats: [b.f.format] },
      label: `Convert to date (${a.f.label} or ${b.f.label})`,
      note: lost(a.hits + b.hits, `dates like ${a.f.label} or ${b.f.label}`),
    })
  } else if (!out.length) {
    const some = s.dates.map((hits, i) => ({ hits, f: DATE_FORMATS[i] })).filter((d) => d.hits / s.values >= SOME).sort((a, b) => b.hits - a.hits)[0]
    if (some) out.push({ clean: { column, kind: 'date', format: some.f.format }, label: `Convert to date anyway (${some.f.label})`, note: lost(some.hits, `dates like ${some.f.label}`) })
  }
  if (s.untrimmed) out.push({ clean: { column, kind: 'trim' }, label: 'Tidy spaces', note: `${sampled(s.untrimmed, 'has', 'have')} extra spaces` })
  if (s.blanks) out.push({ clean: { column, kind: 'blank' }, label: 'Treat blanks as empty', note: `${sampled(s.blanks, 'is', 'are')} blank` })
  return out
}
