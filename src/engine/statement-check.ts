/*
 * A statement's running balance, checked against its amounts (loaded when a signed amount is added).
 */
import { sqlName } from './sql'
import type { StatementColumns } from './statement'

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
