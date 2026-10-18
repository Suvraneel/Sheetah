/*
 * Checks on a table's numbers, said in plain words: a statement's running balance against its amounts,
 * and a report's total lines against the rows they total. Run when the step is taken, and again each
 * time a saved view runs on next month's file (loaded when needed).
 */
import { readTieOut, type DropRows, type TieOut } from './clean'
import { sqlName } from './sql'
import type { StatementColumns } from './statement'

/** One check's outcome, as shown above the rows. */
export interface Check {
  kind: 'balance' | 'totals'
  ok: boolean
  text: string
}

/**
 * Checking the balances, over a table in its rows' order: for each row with a balance, whether it
 * equals the one before plus this row's amount (oldest first), or the one after plus it (newest first).
 * Rows without a balance (an opening line, a summary) are skipped.
 */
export function balanceCheckSql(table: string, s: StatementColumns & { balance: string }, numeric: (name: string) => boolean, ref: (name: string) => string = sqlName): string {
  const n = (name: string) => (numeric(name) ? `${ref(name)}::DOUBLE` : `number_from_text(${ref(name)})`)
  const amount = `coalesce(${n(s.credit)}, 0) - coalesce(${n(s.debit)}, 0)`
  const off = (other: string) => `abs(b - ${other} - a) > 0.005 + abs(b) * 1e-9`
  return `WITH t AS (SELECT rowid AS r, ${n(s.balance)} AS b, ${amount} AS a FROM ${table}),
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

/** What the balance check found, in words (null when there was too little to check). */
export function balanceText(check: BalanceCheck | null, balance: string, nf: (n: number) => string): Check | null {
  if (!check) return null
  const nearby = check.order === 'newest first' ? 'below' : 'above'
  if (!check.firstBad) return { kind: 'balance', ok: true, text: `Every ${balance} follows from the row ${nearby} (${nf(check.pairs)} rows checked)` }
  const more = check.bad > 1 ? ` ${nf(check.bad)} rows don’t follow.` : ''
  return {
    kind: 'balance',
    ok: false,
    text: `${balance} on row ${nf(check.firstBad.row)} doesn’t follow from the row ${nearby}: off by ${nf(Math.abs(check.firstBad.off))}. A line missing or doubled?${more}`,
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
  return `SELECT ${cols.map((c, i) => `sum(${n(c)}) FILTER (WHERE NOT ${all(totals)})::DOUBLE AS t${i}, sum(${n(c)}) FILTER (WHERE ${all(drop)})::DOUBLE AS d${i}`).join(', ')} FROM ${sqlName(table)}`
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
  return { kind: 'totals', ok: true, text: `The totals match the rows exactly: ${t.ok[0].column} ${nf(t.ok[0].sum)}` }
}
