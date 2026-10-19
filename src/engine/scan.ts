/*
 * Looking a table over, after it opens (and for the column menu): total lines and empty rows, columns to
 * fill down or convert, dates that read both ways, a column's profile and values. Loaded when first needed,
 * so the first screen doesn't wait for it.
 */
import { getEngine, quoteIdent, quoteLiteral } from './db'
import { cleanExpr, isConversion, type Clean, type DropRows } from './clean'
import { confidentConversion, lossesSql, dataSumsSql, eitherJunk, fillDownSql, isTextColumn, looksFilledDown, junkPredicates, labelSumsSql, readTieOut, totalsAgree, readStats, statsSql, suggestCleaning, decimalsSql, fileDecimalComma, type CleanStats, type CleanSuggestion } from './clean-scan'
import { LOCALE, nameKey } from './sql'
import { balanceLineSql, isBalanceName, statementColumns } from './statement'
import { closingLineSql } from './checks'
import { colRef, type ColumnInfo, type ResultSet } from './result'

export interface ColumnProfile {
  column: ColumnInfo
  nonNull: number
  nulls: number
  distinct: number
  /** False when `distinct` is an estimate (very large results). */
  distinctExact: boolean
  min: string | null
  max: string | null
  sum: number | null
  avg: number | null
  top: { value: string | null; count: number }[]
}

export async function profileColumn(result: ResultSet, column: ColumnInfo): Promise<ColumnProfile | null> {
  if (!result.table) return null
  const { conn } = await getEngine()
  const c = colRef(column)
  // Exact up to a million rows (fast enough); beyond that an estimate, which can be off by a fifth.
  const exact = result.rowCount <= 1_000_000
  const distinct = exact ? `count(DISTINCT ${c})` : `least(approx_count_distinct(${c}), count(${c})) /* the estimate can overshoot */`
  const stats = (
    await conn.query(`SELECT count(${c})::DOUBLE AS non_null, (count(*) - count(${c}))::DOUBLE AS nulls,
      ${distinct}::DOUBLE AS distinct_n, min(${c})::VARCHAR AS min, max(${c})::VARCHAR AS max
      ${column.numeric ? `, avg(${c})::DOUBLE AS avg, sum(${c})::DOUBLE AS sum` : ''} FROM ${result.table}`)
  ).toArray()[0]?.toJSON() as Record<string, unknown>
  const top = (
    await conn.query(`SELECT ${c}::VARCHAR AS v, count(*)::DOUBLE AS n FROM ${result.table} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`)
  )
    .toArray()
    .map((r) => {
      const o = r.toJSON() as { v: string | null; n: number }
      return { value: o.v, count: Number(o.n) }
    })
  return {
    column,
    nonNull: Number(stats.non_null ?? 0),
    nulls: Number(stats.nulls ?? 0),
    distinct: Number(stats.distinct_n ?? 0),
    distinctExact: exact,
    min: (stats.min as string | null) ?? null,
    max: (stats.max as string | null) ?? null,
    sum: column.numeric && stats.sum != null ? Number(stats.sum) : null,
    avg: column.numeric && stats.avg != null ? Number(stats.avg) : null,
    top,
  }
}

/** Rows that aren't data in a freshly opened table: completely empty rows and total lines. */
/**
 * Date columns that could have been read the other way round: every day is the 12th or before, so
 * 01/02/2024 could be 1 February or January 2nd.
 */
export async function ambiguousDates(result: ResultSet): Promise<string[]> {
  const dates = result.columns.filter((c) => c.type === 'DATE')
  if (!result.table || !dates.length) return []
  const { conn } = await getEngine()
  const row = (await conn.query(`SELECT ${dates.map((c, i) => `max(day(${colRef(c)}))::DOUBLE AS d${i}, count(${colRef(c)})::DOUBLE AS n${i}`).join(', ')} FROM ${result.table}`)).toArray()[0]?.toJSON() as
    | Record<string, number | null>
    | undefined
  return row ? dates.filter((_, i) => Number(row[`n${i}`]) > 1 && Number(row[`d${i}`]) <= 12).map((c) => c.name) : []
}

const emptyScans = new WeakMap<ResultSet, Promise<string[]>>()

/**
 * Text columns with nothing in any row (an export's empty first column, a spacer): no use as labels or
 * data. Never every column (that's an empty table, not empty columns). Looked for in a sample first, then
 * confirmed on every row for the few candidates; asked once per result (several scans want it).
 */
export function emptyTextColumns(result: ResultSet): Promise<string[]> {
  const known = emptyScans.get(result)
  if (known) return known
  const scan = (async () => {
    const texts = result.columns.filter((c) => isTextColumn(c.type))
    if (!result.table || !texts.length || result.columns.length < 2 || result.rowCount === 0) return []
    const { conn } = await getEngine()
    const filled = async (cols: ColumnInfo[], from: string) => {
      const row = (await conn.query(`SELECT ${cols.map((c, i) => `count(nullif(trim(${colRef(c)}::VARCHAR), ''))::DOUBLE AS f${i}`).join(', ')} FROM ${from}`)).toArray()[0]?.toJSON() as
        | Record<string, number>
        | undefined
      return row ? cols.filter((_, i) => Number(row[`f${i}`]) === 0) : []
    }
    const sampled = result.rowCount > 100_000 ? await filled(texts, `(SELECT * FROM ${result.table} USING SAMPLE 20000 ROWS)`) : texts
    const empty = sampled.length ? await filled(sampled, result.table) : []
    return empty.length < result.columns.length ? empty.map((c) => c.name) : []
  })()
  emptyScans.set(result, scan)
  return scan
}

/**
 * Total lines in a big table (a year of a register, half a million rows and more): only the rows that
 * mention "total" are looked at (one quick pass), for "Sub-total" and "Grand Total" lines and short
 * "Total" lines. Empty rows and full "Total" lines that need their sums checked are left to smaller tables.
 */
async function bigTableTotals(result: ResultSet): Promise<DropRows[]> {
  const texts = result.columns.filter((c) => isTextColumn(c.type))
  if (!result.table || !texts.length) return []
  const { conn } = await getEngine()
  const p = junkPredicates(result.columns.map((c) => ({ ref: colRef(c), text: isTextColumn(c.type), name: c.name })))
  if (!p.strong || !p.weak) return []
  const mentions = texts.map((c) => `${colRef(c)}::VARCHAR ILIKE '%total%'`).join(' OR ')
  const row = (
    await conn.query(`SELECT count(*) FILTER (WHERE ${p.strong.drop})::DOUBLE AS strong, count(*) FILTER (WHERE ${eitherJunk(p.strong, p.weak).drop})::DOUBLE AS total FROM (SELECT * FROM ${result.table} WHERE ${mentions})`)
  ).toArray()[0]?.toJSON() as { strong: number; total: number } | undefined
  const named = junkPredicates(result.columns.map((c) => ({ ref: quoteIdent(c.name), text: isTextColumn(c.type), name: c.name })))
  if (!row || !named.strong || !named.weak) return []
  const strong = Number(row.strong)
  const total = Number(row.total)
  const weakOk = total - strong <= Math.max(3, result.rowCount * 0.1)
  const n = weakOk ? total : strong
  if (!n) return []
  return [{ label: `${n.toLocaleString(LOCALE)} total line${n === 1 ? '' : 's'}`, keep: (weakOk ? eitherJunk(named.strong, named.weak) : named.strong).keep, kind: 'totals' }]
}

export async function junkRows(result: ResultSet): Promise<DropRows[]> {
  if (!result.table || !result.columns.length) return []
  // Scanning every value of a big table would hold the engine for seconds: a quick check for total lines only.
  if (result.rowCount > 500_000) return result.rowCount <= 5_000_000 ? bigTableTotals(result) : []
  const { conn } = await getEngine()
  // An empty first column (some exports start with one) would hide the labels in the next: left out.
  const empty = new Set(await emptyTextColumns(result))
  const columns = result.columns.filter((c) => !empty.has(c.name))
  if (!columns.length) return []
  const refs = columns.map((c) => ({ ref: colRef(c), text: isTextColumn(c.type), numeric: c.numeric, name: c.name }))
  const p = junkPredicates(refs)
  const counts = [`count(*) FILTER (WHERE ${p.blank.drop})::DOUBLE AS blank`]
  if (p.strong && p.weak && p.label)
    counts.push(
      `count(*) FILTER (WHERE ${p.strong.drop})::DOUBLE AS strong`,
      `count(*) FILTER (WHERE ${eitherJunk(p.strong, p.weak).drop})::DOUBLE AS total`,
      `count(*) FILTER (WHERE ${eitherJunk(p.strong, p.label).drop})::DOUBLE AS labelled`,
    )
  const row = (await conn.query(`SELECT ${counts.join(', ')} FROM ${result.table}`)).toArray()[0]?.toJSON() as
    | { blank: number; strong?: number; total?: number; labelled?: number }
    | undefined
  if (!row) return []
  // The same predicates written against the columns' own names, for the composed query.
  const named = junkPredicates(columns.map((c) => ({ ref: quoteIdent(c.name), text: isTextColumn(c.type), name: c.name })))
  const out: DropRows[] = []
  const n = (x: number, one: string) => `${x.toLocaleString(LOCALE)} ${one}${x === 1 ? '' : 's'}`
  const strong = Number(row.strong ?? 0)
  let total = Number(row.total ?? 0)
  let totals = named.strong && named.weak ? eitherJunk(named.strong, named.weak) : null
  let totalsHere = p.strong && p.weak ? eitherJunk(p.strong, p.weak) : null // the same, on the result table
  // "Total" lines with nothing empty in them (Region, Sales / Total, 2000): trusted when they add up, and
  // while they're at most a quarter of the rows (a census's both-sexes rows add up too, by construction).
  const labelled = Number(row.labelled ?? 0)
  let verified = false
  const labelSql = p.label && p.first ? labelSumsSql(result.table, refs, p.label, p.first) : null
  if (labelled > total && labelled <= result.rowCount * 0.25 && labelSql && p.strong && p.label && p.first && named.strong && named.label) {
    const t = (await conn.query(labelSql)).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
    const which = Object.keys(t ?? {})
      .filter((k) => typeof t![k] === 'number')
      .map((k) => Number(k.slice(1)))
    if (t && which.length) {
      const keep = `${p.label.keep} AND ${p.strong.keep} AND ${p.blank.keep}`
      const d = (await conn.query(dataSumsSql(result.table, refs, p.first, which, keep))).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
      const pairs = which.filter((i) => typeof d?.[`d${i}`] === 'number').map((i) => ({ t: t[`t${i}`] as number, d: d![`d${i}`] as number }))
      if (totalsAgree(pairs)) {
        verified = true
        total = labelled
        totals = eitherJunk(named.strong, named.label)
        totalsHere = eitherJunk(p.strong, p.label)
      }
    }
  }
  // Plain "Total" lines are trusted while they're a few, or when they add up (a QuickBooks report's "Total
  // for Acme Corp" under each customer, however many); a lot of them that don't add up is a real value (a
  // category called Total).
  let weakOk = verified || total - strong <= Math.max(3, result.rowCount * 0.1)
  if (!weakOk && totalsHere && p.first && total <= result.rowCount * 0.5) {
    const sums = labelSumsSql(result.table, refs, totalsHere, p.first)
    const t = sums ? ((await conn.query(sums)).toArray()[0]?.toJSON() as Record<string, number | null> | undefined) : undefined
    const which = Object.keys(t ?? {}).filter((k) => typeof t![k] === 'number').map((k) => Number(k.slice(1)))
    if (t && which.length) {
      const d = (await conn.query(dataSumsSql(result.table, refs, p.first, which, `${totalsHere.keep} AND ${p.blank.keep}`))).toArray()[0]?.toJSON() as
        | Record<string, number | null>
        | undefined
      weakOk = totalsAgree(which.filter((i) => typeof d?.[`d${i}`] === 'number').map((i) => ({ t: t[`t${i}`] as number, d: d![`d${i}`] as number })))
    }
  }
  if (totals && named.strong && (weakOk ? total : strong)) {
    // Tie-out: the total lines' numbers against the rows they'd leave (sub-totals and a grand total
    // come to twice them). Said on the suggestion, so leaving them out is a checked step, not a guess.
    let checked: DropRows['checked']
    let measured = 0 // columns with numbers on both sides, to check the lines against
    const here = weakOk ? totalsHere : p.strong
    if (here && p.first) {
      const sums = labelSumsSql(result.table, refs, here, p.first)
      const t = sums ? ((await conn.query(sums)).toArray()[0]?.toJSON() as Record<string, number | null> | undefined) : undefined
      const which = Object.keys(t ?? {}).filter((k) => typeof t![k] === 'number').map((k) => Number(k.slice(1)))
      if (t && which.length) {
        // Not the closing balance line (the books write it in Debit or Credit, below their total).
        const closing = closingLineSql(columns.filter((c) => isTextColumn(c.type)).map(colRef))
        const d = (await conn.query(dataSumsSql(result.table, refs, p.first, which, `${here.keep} AND ${p.blank.keep} AND NOT ${closing}`))).toArray()[0]?.toJSON() as
          | Record<string, number | null>
          | undefined
        const pairs = which.filter((i) => typeof d?.[`d${i}`] === 'number').map((i) => ({ i, t: t[`t${i}`] as number, d: d![`d${i}`] as number }))
        const others = columns.filter((_, k) => refs[k].ref !== p.first)
        // A running balance isn't something total lines add up.
        const sums = pairs.filter((x) => others[x.i] && !isBalanceName(others[x.i].name))
        measured = sums.filter((x) => typeof x.t === 'number' && typeof x.d === 'number' && x.d !== 0).length
        checked = readTieOut(sums.map((x) => ({ column: others[x.i].name, t: x.t, d: x.d }))) ?? undefined
      }
    }
    // Lines only called "Total" (no Grand or Sub-), with numbers that add up to nothing the other rows come to:
    // a value named Total (a fuel brand, a vendor), not a total line. Left alone.
    // (Nowhere near: not even half or one and a half times the other rows, in any column.)
    const named0 = !verified && strong === 0 && measured > 0 && !checked
    if (!named0) out.push({ label: n(weakOk ? total : strong, 'total line'), keep: (weakOk ? totals : named.strong).keep, kind: 'totals', ...(checked ? { checked } : {}) })
  }
  // A statement's opening and closing balance lines: not transactions (an empty month in a pivot).
  const st = statementColumns(columns)
  if (st) {
    const isNum = (name: string) => !!columns.find((c) => c.name === name)?.numeric
    const text = columns.filter((c) => isTextColumn(c.type)).map((c) => c.name)
    const here = balanceLineSql(st, text, isNum, (name) => colRef(columns.find((c) => c.name === name)!))
    const keep = balanceLineSql(st, text, isNum, quoteIdent)
    const k = here && keep ? Number((await conn.query(`SELECT count(*) FILTER (WHERE ${here})::DOUBLE AS n FROM ${result.table}`)).toArray()[0]?.toJSON().n ?? 0) : 0
    if (k && keep) out.push({ label: n(k, 'balance line'), keep: `NOT ${keep}`, kind: 'balance' })
  }
  // A date column (dates not converted yet) holding something else on a few lines: a statement's summary
  // below its transactions ("STATEMENT SUMMARY :-", its figures), "Generated on…" notes. Not transactions.
  // (Not a date something may not have happened by yet: a Payment or Due Date's "Pending" is an open item.)
  const dateCol = columns.find((c) => isTextColumn(c.type) && /(^|_)(date|dt)(_|$)|^date/.test(nameKey(c.name)) && !/(^|_)(paid|payment|due|delivery|delivered|ship|shipped|expiry|cleared|clearing|realised|realized|maturity|closing|close)(_|$)/.test(nameKey(c.name)))
  if (dateCol) {
    const looks = (ref: string) => `regexp_matches(trim(${ref}::VARCHAR), ${DATE_LIKE})`
    const [has, dated] = [`has_value(${colRef(dateCol)})`, looks(colRef(dateCol))]
    const u = (await conn.query(
      `SELECT count(*) FILTER (WHERE ${has})::DOUBLE AS filled, count(*) FILTER (WHERE ${has} AND NOT ${dated})::DOUBLE AS other,
        min(rowid) FILTER (WHERE ${has} AND ${dated})::DOUBLE AS first_dated, max(rowid) FILTER (WHERE ${has} AND ${dated})::DOUBLE AS last_dated,
        min(rowid) FILTER (WHERE ${has} AND NOT ${dated})::DOUBLE AS first_other, max(rowid) FILTER (WHERE ${has} AND NOT ${dated})::DOUBLE AS last_other
      FROM ${result.table}`,
    )).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
    const [filled, other] = [Number(u?.filled ?? 0), Number(u?.other ?? 0)]
    // A statement's summary is one block, above its transactions or below them: then it may be nearly as long
    // as they are (a short statement). Lines scattered among the dates ("Pending" in a Payment Date column)
    // are left alone unless they're few.
    const block = !!u && (Number(u.first_other) > Number(u.last_dated) || Number(u.last_other) < Number(u.first_dated))
    if (other >= 1 && other <= 20 && filled - other >= 3 && (filled - other >= 2 * other || (block && filled - other > other))) {
      const q = quoteIdent(dateCol.name)
      out.push({ label: n(other, 'undated line'), keep: `(NOT has_value(${q}) OR ${looks(q)})`, kind: 'undated' })
    }
  }
  // Notes in the table, a line each with nothing else on it: "Source: ONS", "[note 3] Figure revised…",
  // "Notes", a legend, a copyright, QuickBooks' "Accrual Basis …" footer. Only above the table or below it
  // (not an account named "Notes Payable" heading its rows in a report grouped by account).
  if (columns.length >= 2) {
    const one = (ref: (c: ColumnInfo) => string) => `(${columns.map((c) => `has_value(${ref(c)})::INTEGER`).join(' + ')}) = 1`
    const says = (ref: (c: ColumnInfo) => string) => `regexp_matches(concat_ws(' ', ${columns.map((c) => `${ref(c)}::VARCHAR`).join(', ')}), ${NOTE_LINE}, 'i')`
    const several = `(${columns.map((c) => `has_value(${colRef(c)})::INTEGER`).join(' + ')}) >= 2`
    const at = (await conn.query(
      `SELECT count(*) FILTER (WHERE ${one(colRef)} AND ${says(colRef)})::DOUBLE AS n,
        min(rowid) FILTER (WHERE ${one(colRef)} AND ${says(colRef)})::DOUBLE AS first_note, max(rowid) FILTER (WHERE ${one(colRef)} AND ${says(colRef)})::DOUBLE AS last_note,
        min(rowid) FILTER (WHERE ${several})::DOUBLE AS first_row, max(rowid) FILTER (WHERE ${several})::DOUBLE AS last_row
      FROM ${result.table}`,
    )).toArray()[0]?.toJSON() as Record<string, number | null> | undefined
    const k = Number(at?.n ?? 0)
    // All of them above the first row of figures, or all below the last.
    const ends = !!at && (Number(at.first_note) > Number(at.last_row) || Number(at.last_note) < Number(at.first_row))
    const q = (c: ColumnInfo) => quoteIdent(c.name)
    if (k && ends && k <= Math.max(20, result.rowCount * 0.2)) out.push({ label: n(k, 'note line'), keep: `NOT (${one(q)} AND ${says(q)})`, kind: 'notes' })
  }
  if (row.blank) out.push({ label: n(Number(row.blank), 'empty row'), keep: named.blank.keep, kind: 'empty' })
  return out
}

/** A note's first words: a source, a licence, a footnote ("[note 3]", "1) …", "* …"), a legend, a report's footer. */
const NOTE_LINE = `'^\\s*(notes?(\\s*\\d+)?\\s*([:.)\\]]|$)|\\[note|\\[x\\]|sources?\\s*:|©|\\(c\\)\\s|copyright\\s*(:|©|\\(c\\)|\\d{4})|licen[cs]e\\s*:|footnotes?\\s*([:.]|$)|symbols?\\s*:|zeichenerkl|quelle\\s*:|stand\\s*:|legend\\s*:|key\\s*:|accrual basis|cash basis|\\*+\\s|\\d\\)\\s|(data|figures?|this table|these figures)\\s+(are|is|have|were|was|may|do|does)\\b)'`

/** A date as statements write one (01/04/24, 2024-04-01, 1-Apr-26, 01 Apr 2026, Apr 1, 2026), a time after it or not. */
// However a date is written: 15/08/2024, 2024-08-15, 15-Aug-24, 1st April 2024, Apr-15-2024, April 15th, 2024.
const DATE_LIKE = `'^(\\d{1,2}(st|nd|rd|th)?[/.,\\- ]*([A-Za-z]{3,9}\\.?|\\d{1,2})[/.,\\- ]*\\d{2,4}|\\d{4}[/.-]\\d{1,2}[/.-]\\d{1,2}|[A-Za-z]{3,9}\\.?[/.,\\- ]*\\d{1,2}(st|nd|rd|th)?[/.,\\- ]+\\d{2,4})([ T].*)?$'`

/**
 * Columns to fill down: a report's group names, written once at the top of each group. Only the first
 * columns, from the left (Region, then Branch within it): group names lead, and a column further right
 * with gaps is more likely filled in now and then.
 */
export async function fillDownColumns(result: ResultSet): Promise<string[]> {
  if (!result.table || result.columns.length < 2 || result.rowCount < 6 || result.rowCount > 500_000) return []
  const { conn } = await getEngine()
  const refs = result.columns.map(colRef)
  // An empty leading column (some exports start with one) doesn't count as one of the first.
  const empty = new Set(await emptyTextColumns(result))
  const out: string[] = []
  for (const c of result.columns.filter((x) => !empty.has(x.name)).slice(0, 3)) {
    const i = result.columns.indexOf(c)
    if (!isTextColumn(c.type) || i === result.columns.length - 1) break
    const s = (await conn.query(fillDownSql(result.table, refs[i], refs))).toArray()[0]?.toJSON() as Parameters<typeof looksFilledDown>[0] | undefined
    if (!s || !looksFilledDown({ ...s, n: Number(s.n), filled: Number(s.filled), pairs: Number(s.pairs), len: Number(s.len) })) break
    out.push(c.name)
  }
  return out
}

/**
 * The row the column names are really on, when the file reader didn't find them: most columns got
 * made-up names (column1, column_2: their header cells were empty, because titles sat above the
 * names), and one of the first rows is all different words (Invoice, Customer, Amount), not numbers.
 */
export async function namesRow(result: ResultSet): Promise<number | null> {
  const made = result.columns.filter((c) => /^column_?\d+$/i.test(c.name)).length
  if (result.columns.length < 2 || made < Math.ceil((result.columns.length - 1) / 2) || !result.rowCount) return null
  // A column the reader typed as dates or yes/no can't hold a column name: this file has no names row
  // (a headerless file of data, whose columns got numbered).
  if (result.columns.some((c) => /^(DATE|TIMESTAMP|BOOLEAN|TIME)/i.test(c.type.trim()))) return null
  const rows = await result.fetch(0, Math.min(10, result.rowCount))
  const year = (v: string) => /^(19|20)\d{2}$/.test(v)
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((v) => (v ?? '').trim())
    const filled = cells.filter(Boolean)
    // Words in text columns; in number columns only a year (Region, 2022, 2023, 2024) can be a name.
    const nameLike = cells.every((c, i) => !c || (result.columns[i].numeric ? year(c) : !/^[-+₹$€£¥(]?[\d.,\s]+%?\)?$/.test(c) || year(c)))
    const enough = filled.length >= Math.max(2, Math.ceil(cells.length / 2))
    if (nameLike && enough && new Set(filled.map((c) => c.toLowerCase())).size === filled.length) return r
  }
  return null
}

/** Which of these columns of a query have nothing in them (an export's months not reached yet). */
export async function emptyColumns(sql: string, columns: string[]): Promise<string[]> {
  if (!columns.length) return []
  const { conn } = await getEngine()
  const row = (await conn.query(`SELECT ${columns.map((c, i) => `count(${quoteIdent(c)})::DOUBLE AS c${i}`).join(', ')} FROM (\n${sql}\n)`)).toArray()[0]?.toJSON() as
    | Record<string, number>
    | undefined
  return row ? columns.filter((_, i) => Number(row[`c${i}`]) === 0) : []
}

/** How many pieces a text column splits into at `delim` (the most in any row, capped at 8). */
export async function splitParts(result: ResultSet, column: ColumnInfo, delim: string): Promise<number> {
  if (!result.table || !delim) return 0
  const { conn } = await getEngine()
  const row = (
    await conn.query(`SELECT max(len(string_split(${colRef(column)}::VARCHAR, ${quoteLiteral(delim)})))::DOUBLE AS n FROM ${result.table}`)
  ).toArray()[0]?.toJSON() as { n: number | null } | undefined
  return Math.min(8, Number(row?.n ?? 0))
}

/** Ways to clean a text column (convert to number or date, trim…), judged on a sample of its values. */
export async function cleaningFor(result: ResultSet, column: ColumnInfo, locale = LOCALE): Promise<CleanSuggestion[]> {
  if (!result.table || !isTextColumn(column.type)) return []
  const { conn } = await getEngine()
  const row = (await conn.query(statsSql(result.table, [colRef(column)]))).toArray()[0]?.toJSON() as Record<string, unknown> | undefined
  if (!row) return []
  // How the other columns write decimals, for values this one can't settle (1,500: a thousand and a half, or 1.5).
  const others = result.columns.filter((c) => isTextColumn(c.type) && c.name !== column.name).slice(0, 40)
  const decimals = others.length
    ? ((await conn.query(decimalsSql(result.table, others.map(colRef)))).toArray()[0]?.toJSON() as Record<string, unknown> | undefined)
    : undefined
  const fileComma = decimals ? fileDecimalComma(others.map((c, i) => ({ name: c.name, s: readStats(decimals, i) }))) : undefined
  const list = suggestCleaning(column.name, readStats(row, 0), locale, result.rowCount <= 5000, fileComma)
  // A big table's sample found nothing a conversion would lose: checked whole, so one written another way
  // further down is said, not quietly emptied.
  const unsaid = list.filter((x) => isConversion(x.clean) && (!x.note || x.quiet))
  if (result.rowCount > 5000 && unsaid.length) {
    const ref = colRef(column)
    const lost = (await conn.query(lossesSql(result.table, unsaid.map((x) => ({ ref, expr: cleanExpr({ ...x.clean, column: column.ident ?? column.name }) }))))).toArray()[0]?.toJSON() as
      | Record<string, unknown>
      | undefined
    unsaid.forEach((x, i) => {
      const n = Number(lost?.[`l${i}`] ?? 0)
      if (n > 0) {
        x.note = `${n.toLocaleString(LOCALE)} ${n === 1 ? 'value doesn’t' : 'values don’t'} read this way and ${n === 1 ? 'becomes' : 'become'} empty`
        delete x.quiet
      }
    })
  }
  return list
}

/**
 * Text columns looked over once, in one query over one sample however many columns: numbers or dates
 * stored as text (typically from Excel), to convert; and names typed with stray spaces (" asha rao ",
 * "Kabir  Khan"), to tidy: they group and look up as different values.
 */
export async function textFindings(result: ResultSet, locale = LOCALE): Promise<{ convert: Clean[]; spaces: string[] }> {
  const cols = result.columns.filter((c) => isTextColumn(c.type)).slice(0, 120)
  if (!result.table || !cols.length) return { convert: [], spaces: [] }
  const { conn } = await getEngine()
  // Ten columns a query: each column's counts are a few KB of SQL, and a wide table's in one would run the
  // engine out of memory.
  const stats: { c: ColumnInfo; s: CleanStats }[] = []
  for (let i = 0; i < cols.length; i += 10) {
    const part = cols.slice(i, i + 10)
    const row = (await conn.query(statsSql(result.table, part.map(colRef)))).toArray()[0]?.toJSON() as Record<string, unknown> | undefined
    if (!row) return { convert: [], spaces: [] }
    part.forEach((c, j) => stats.push({ c, s: readStats(row, j) }))
  }
  // A column of 1,500 and 0,750 beside a price of 2,49: read the way the file writes decimals.
  const fileComma = fileDecimalComma(stats.map(({ c, s }) => ({ name: c.name, s })))
  let convert = stats.map(({ c, s }) => confidentConversion(suggestCleaning(c.name, s, locale, true, fileComma))).filter((c): c is Clean => !!c)
  // The counts are a sample's past 5,000 rows: before a chip converts in one click (as if every value reads),
  // the whole column is checked. A value written another way further down ("Rs. 25,000.00" among "₹…")
  // would quietly become empty; such a column is left to its menu, which says what doesn't convert.
  if (convert.length && result.rowCount > 5000) {
    const items = convert.map((cl) => {
      const c = cols.find((x) => x.name === cl.column)!
      return { ref: colRef(c), expr: cleanExpr({ ...cl, column: c.ident ?? c.name }) }
    })
    const lost = (await conn.query(lossesSql(result.table, items))).toArray()[0]?.toJSON() as Record<string, unknown> | undefined
    convert = convert.filter((_, i) => lost && Number(lost[`l${i}`]) === 0)
  }
  const converted = new Set(convert.map((c) => c.column))
  const spaces = stats.filter(({ c, s }) => s.untrimmed > 0 && !converted.has(c.name)).map(({ c }) => c.name)
  return { convert, spaces }
}

/** A text column's distinct values with their rows, most first (up to `limit`): for spotting one value written two ways. */
export async function distinctValues(result: ResultSet, column: ColumnInfo, limit = 400): Promise<{ value: string | null; count: number }[]> {
  if (!result.table) return []
  const { conn } = await getEngine()
  const c = colRef(column)
  const res = await conn.query(`SELECT ${c}::VARCHAR AS v, count(*)::DOUBLE AS n FROM ${result.table} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${Math.floor(limit)}`)
  return res.toArray().map((r) => {
    const o = r.toJSON() as { v: string | null; n: number }
    return { value: o.v, count: Number(o.n) }
  })
}

/** Most common values of a column in any query (used to list choices without the column's own filter). */
export async function topValues(sql: string, column: string, limit = 12): Promise<{ value: string | null; count: number }[]> {
  const { conn } = await getEngine()
  const c = quoteIdent(column)
  const res = await conn.query(`SELECT ${c}::VARCHAR AS v, count(*)::DOUBLE AS n FROM (\n${sql}\n) GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`)
  return res.toArray().map((r) => {
    const o = r.toJSON() as { v: string | null; n: number }
    return { value: o.v, count: Number(o.n) }
  })
}

