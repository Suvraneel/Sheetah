/*
 * Checks on a table's numbers, said in plain words: a statement's running balance against its amounts,
 * and a report's total lines against the rows they total. Run when the step is taken, and again each
 * time a saved view runs on next month's file (loaded when needed).
 */
import type { DropRows, TieOut } from './clean'
import { readTieOut } from './clean-scan'
import { sqlName } from './sql'
import type { StatementColumns } from './statement'

/** One check's outcome, as shown above the rows. */
export interface Check {
  kind: 'balance' | 'totals' | 'continuity' | 'rollforward' | 'match' | 'ids'
  ok: boolean
  text: string
  /** What was found, not passed or failed (a match's lines left over are what's to be reconciled, not an error). */
  note?: boolean
}

/**
 * Checking the balances, over a table in its rows' order: for each row with a balance, whether it
 * equals the one before plus this row's amount (oldest first), or the one after plus it (newest first).
 * Rows without a balance (an opening line, a summary) are skipped.
 */
/** Each row's balance (b) and amount (a, in less out), by the rows' order (r). */
function balanceRows(table: string, s: StatementColumns & { balance: string }, numeric: (name: string) => boolean, ref: (name: string) => string): string {
  const n = (name: string) => (numeric(name) ? `${ref(name)}::DOUBLE` : `number_from_text(${ref(name)})`)
  // A balance written "2,11,150.00 Cr" (in credit) or "Dr" (overdrawn), as the bank means it.
  const b = numeric(s.balance) ? `${ref(s.balance)}::DOUBLE` : `number_from_cr_dr(${ref(s.balance)}::VARCHAR)`
  return `SELECT rowid AS r, ${b} AS b, coalesce(${n(s.credit)}, 0) - coalesce(${n(s.debit)}, 0) AS a FROM ${table}`
}

export function balanceCheckSql(table: string, s: StatementColumns & { balance: string }, numeric: (name: string) => boolean, ref: (name: string) => string = sqlName): string {
  const off = (other: string) => `abs(b - ${other} - a) > 0.005 + abs(b) * 1e-9`
  return `WITH t AS (${balanceRows(table, s, numeric, ref)}),
s AS (SELECT r, b, a, lag(b) OVER (ORDER BY r) AS before, lead(b) OVER (ORDER BY r) AS after FROM t WHERE b IS NOT NULL)
SELECT count(before)::DOUBLE AS pairs,
  count(*) FILTER (WHERE before IS NOT NULL AND ${off('before')})::DOUBLE AS bad_down,
  count(*) FILTER (WHERE after IS NOT NULL AND ${off('after')})::DOUBLE AS bad_up,
  min(r) FILTER (WHERE before IS NOT NULL AND ${off('before')})::DOUBLE AS first_down,
  min(r) FILTER (WHERE after IS NOT NULL AND ${off('after')})::DOUBLE AS first_up,
  arg_min(b - before - a, r) FILTER (WHERE before IS NOT NULL AND ${off('before')})::DOUBLE AS off_down,
  arg_min(b - after - a, r) FILTER (WHERE after IS NOT NULL AND ${off('after')})::DOUBLE AS off_up
FROM s`
}

export interface BalanceCheck {
  /** Balances checked (each against its neighbour). */
  pairs: number
  /** The first row (1-based, in the rows' order) whose balance doesn't follow, and by how much. */
  firstBad?: { row: number; off: number }
  /** How many don't. */
  bad: number
  /** Oldest first (each balance follows the one above) or newest first. */
  order: 'oldest first' | 'newest first'
}

/** The check's counts read the way round that fits best (a statement newest first is checked upward). */
export function readBalanceCheck(row: Record<string, number | null>): BalanceCheck | null {
  const pairs = Number(row.pairs ?? 0)
  if (pairs < 2) return null
  const down = Number(row.bad_down ?? 0)
  const up = Number(row.bad_up ?? 0)
  const which = up < down ? 'up' : 'down'
  const bad = Math.min(up, down)
  const first = row[`first_${which}`]
  return {
    pairs,
    bad,
    order: which === 'up' ? 'newest first' : 'oldest first',
    ...(bad && first !== null && first !== undefined ? { firstBad: { row: Number(first) + 1, off: Number(row[`off_${which}`] ?? 0) } } : {}),
  }
}

/**
 * Which way round the rows are, for finding where the statement starts: from a single pair of balances
 * up (too few to report as a check). Null when no way round fits most of the balances (the rows aren't in a
 * statement's order), so its ends would mean nothing.
 */
export function readOrder(row: Record<string, number | null>): BalanceCheck['order'] | null {
  const pairs = Number(row.pairs ?? 0)
  if (!pairs) return 'oldest first' // one balance at most: either way round, the same ends
  const down = Number(row.bad_down ?? 0)
  const up = Number(row.bad_up ?? 0)
  if (Math.min(up, down) * 2 > pairs) return null
  return up < down ? 'newest first' : 'oldest first'
}

/** A statement's two ends, in its rows' order: the first and last balances, and those rows' amounts. */
export function endsSql(table: string, s: StatementColumns & { balance: string }, numeric: (name: string) => boolean, ref: (name: string) => string = sqlName): string {
  return `WITH t AS (${balanceRows(table, s, numeric, ref)})
SELECT arg_min(b, r)::DOUBLE AS b0, arg_min(a, r)::DOUBLE AS a0, arg_max(b, r)::DOUBLE AS b1, arg_max(a, r)::DOUBLE AS a1 FROM t WHERE b IS NOT NULL`
}

/** Where the statement opened (the balance before its first line) and where it closed. */
export function readEnds(row: Record<string, unknown>, order: BalanceCheck['order']): { opening: number; closing: number } | null {
  const [b0, a0, b1, a1] = ['b0', 'a0', 'b1', 'a1'].map((k) => row[k])
  if (![b0, a0, b1, a1].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const [f, fa, l, la] = [b0, a0, b1, a1] as number[]
  return order === 'newest first' ? { opening: l - la, closing: f } : { opening: f - fa, closing: l }
}

/** Whether this month's statement opens where last month's closed: a statement missing in between shows. */
export function continuityText(opening: number, last: { table: string; closing: number }, nf: (n: number) => string): Check {
  const gap = opening - last.closing
  if (Math.abs(gap) < 0.005 + Math.abs(opening) * 1e-9) return { kind: 'continuity', ok: true, text: `Opens at ${nf(opening)}, where ${last.table} closed` }
  return {
    kind: 'continuity',
    ok: false,
    text: `Opens at ${nf(opening)}, but ${last.table} closed at ${nf(last.closing)}: ${nf(Math.abs(gap))} apart. A statement missing in between?`,
  }
}

/** What the balance check found, in words (null when there was too little to check). */
export function balanceText(check: BalanceCheck | null, balance: string, nf: (n: number) => string, money: (n: number) => string = nf): Check | null {
  if (!check) return null
  const nearby = check.order === 'newest first' ? 'below' : 'above'
  if (!check.firstBad) return { kind: 'balance', ok: true, text: `Every ${balance} follows from the row ${nearby} (${nf(check.pairs)} rows checked)` }
  const more = check.bad > 1 ? ` ${nf(check.bad)} rows don’t follow.` : ''
  return {
    kind: 'balance',
    ok: false,
    text: `${balance} on row ${nf(check.firstBad.row)} doesn’t follow from the row ${nearby}: off by ${money(Math.abs(check.firstBad.off))}. A line missing or doubled?${more}`,
  }
}

/**
 * The tie-out on a table's own rows, for drop steps saved earlier (next month's file): each column's sum
 * over the rows the steps leave out (the total lines), and over the rows they keep.
 */
export function tieOutSql(table: string, cols: { name: string; numeric: boolean }[], drop: DropRows[]): string | null {
  // Only the total lines are added up (not a statement's balance lines, or empty rows); every step decides the rows kept.
  const totals = drop.filter((d) => (d.kind ? d.kind === 'totals' : /total line/.test(d.label)))
  if (!totals.length || !cols.length) return null
  const all = (ds: DropRows[]) => `(${ds.map((d) => `(${d.keep})`).join(' AND ')})`
  const n = (c: { name: string; numeric: boolean }) => (c.numeric ? `TRY_CAST(${sqlName(c.name)} AS DOUBLE)` : `number_from_text(${sqlName(c.name)}::VARCHAR)`)
  // The rows a total adds up: the books' total (Tally's Current Total) includes the opening balance written in
  // Debit or Credit, never the closing one below it. A statement's balance lines have nothing in or out anyway.
  const balance = drop.filter((d) => d.kind === 'balance' || (!d.kind && /balance line/.test(d.label)))
  const rows = `${all(drop.filter((d) => !balance.includes(d)))} AND NOT ${closingLineSql(cols.filter((c) => !c.numeric).map((c) => sqlName(c.name)))}`
  return `SELECT ${cols.map((c, i) => `sum(${n(c)}) FILTER (WHERE NOT ${all(totals)})::DOUBLE AS t${i}, sum(${n(c)}) FILTER (WHERE ${rows})::DOUBLE AS d${i}`).join(', ')} FROM ${sqlName(table)}`
}

/** SQL true for a closing balance line ("Closing Balance", "Balance c/f", "Carried forward"), by its text columns. */
export function closingLineSql(texts: string[]): string {
  return texts.length ? `(${texts.map((r) => `regexp_matches(coalesce(${r}::VARCHAR, ''), ${CLOSING}, 'i')`).join(' OR ')})` : 'false'
}

/** The tie-out query's row, read column by column. */
export const readTieOutRow = (cols: { name: string }[], row: Record<string, unknown>): TieOut | null =>
  readTieOut(cols.map((c, i) => ({ column: c.name, t: row[`t${i}`] as number | null, d: row[`d${i}`] as number | null })))

/** What the tie-out found, in words: the first column that's short or over, by how much; else the figure that matched. */
export function tieOutText(t: TieOut | null | undefined, nf: (n: number) => string): Check | null {
  if (!t) return null
  const o = t.off[0]
  if (o) {
    const gap = o.rows - o.says
    const more = t.off.length > 1 ? ` (${t.off.length - 1} more ${t.off.length === 2 ? 'column doesn’t' : 'columns don’t'} match)` : ''
    return {
      kind: 'totals',
      ok: false,
      text: `The totals say ${o.column} is ${nf(o.says)}; the rows come to ${nf(o.rows)}: ${nf(Math.abs(gap))} ${gap < 0 ? 'short' : 'over'}${more}`,
    }
  }
  // Every column that was checked (people check each against the footer by hand), the largest first.
  const listed = t.ok.slice(0, 3).map((c) => `${c.column} ${nf(c.sum)}`).join(' · ')
  return { kind: 'totals', ok: true, text: `The totals match the rows exactly: ${listed}${t.ok.length > 3 ? ` and ${t.ok.length - 3} more` : ''}` }
}

/** A statement's own opening and closing balance lines, by their labels. */
const OPENING = `'^\\s*((opening|beginning|starting)\\s+bal|bal(ance)?\\s+(b/?f|brought)|brought\\s+(forward|fwd|over))'`
const CLOSING = `'^\\s*((closing|ending)\\s+bal|bal(ance)?\\s+(c/?f|carried)|carried\\s+(forward|fwd|over))'`

/**
 * The roll-forward, from the statement's own lines: the opening balance line, plus money in, less money out
 * (over the rows the steps keep), against the closing balance line. A line missing anywhere shows here, even
 * when the total line was made to agree. `keep` is the steps' rows to keep (all of them, ANDed).
 */
export function rollForwardSql(table: string, s: StatementColumns & { balance: string }, text: string[], numeric: (name: string) => boolean, keep: string): string | null {
  const labels = text.filter((c) => c !== s.credit && c !== s.debit && c !== s.balance)
  if (!labels.length) return null
  const n = (name: string) => (numeric(name) ? `${sqlName(name)}::DOUBLE` : `number_from_text(${sqlName(name)}::VARCHAR)`)
  const is = (re: string) => `(${labels.map((c) => `regexp_matches(coalesce(${sqlName(c)}::VARCHAR, ''), ${re}, 'i')`).join(' OR ')})`
  const bal = numeric(s.balance) ? `${sqlName(s.balance)}::DOUBLE` : `number_from_cr_dr(${sqlName(s.balance)}::VARCHAR)`
  return `SELECT arg_min(${bal}, rowid) FILTER (WHERE ${is(OPENING)})::DOUBLE AS opening,
  arg_max(${bal}, rowid) FILTER (WHERE ${is(CLOSING)})::DOUBLE AS closing,
  sum(coalesce(${n(s.credit)}, 0)) FILTER (WHERE ${keep})::DOUBLE AS money_in,
  sum(coalesce(${n(s.debit)}, 0)) FILTER (WHERE ${keep})::DOUBLE AS money_out
FROM ${sqlName(table)}`
}

/** The roll-forward in words: it comes to the closing line, or how far it's off (null without both lines). */
export function rollForwardText(row: Record<string, unknown>, money: (n: number) => string): Check | null {
  const [opening, closing, i, o] = ['opening', 'closing', 'money_in', 'money_out'].map((k) => row[k])
  if (typeof opening !== 'number' || typeof closing !== 'number') return null
  const comes = opening + (Number(i) || 0) - (Number(o) || 0)
  const sum = `Opening ${money(opening)} + in ${money(Number(i) || 0)} − out ${money(Number(o) || 0)}`
  if (Math.abs(comes - closing) < 0.005 + Math.abs(closing) * 1e-9) return { kind: 'rollforward', ok: true, text: `${sum} = closing ${money(closing)}, as the file says` }
  return {
    kind: 'rollforward',
    ok: false,
    text: `${sum} comes to ${money(comes)}, but the closing balance line says ${money(closing)}: ${money(Math.abs(comes - closing))} apart. A line missing?`,
  }
}
