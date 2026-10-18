/*
 * The checks a month's statement gets as its steps are taken, and the reconciliation from a match: the
 * queries and what they found, run against the engine (loaded when a check is first run, not with the
 * page). The app decides where what's found is shown and what's kept with a saved view.
 */
import { numberedRows, bankOf, brsSql } from './brs'
import {
  balanceCheckSql,
  balanceText,
  continuityText,
  endsSql,
  readBalanceCheck,
  readEnds,
  readOrder,
  readTieOutRow,
  rollForwardSql,
  rollForwardText,
  tieOutSql,
  tieOutText,
  type Check,
} from './checks'
import type { DropRows } from './clean'
import type { Ops } from './compose'
import { getEngine } from './db'
import type { MatchSide, MatchSpec } from './match'
import { colRef, type ResultSet } from './result'
import { isNumericType, isTemporal, LOCALE, quoteIdent } from './sql'
import { isBalanceName, statementColumns, type StatementColumns } from './statement'
import type { SavedView } from './views'

/** A check, and the step it's about (shown while that step is). */
export type Found = Check & { step?: string }
type Period = NonNullable<SavedView['periods']>[number]
interface Col {
  name: string
  type: string
}

const nf = new Intl.NumberFormat(LOCALE).format
const money = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format
const first = async (sql: string) => {
  const { conn } = await getEngine()
  return ((await conn.query(sql)).toArray()[0]?.toJSON() ?? {}) as Record<string, number | null>
}

/** Whether each running balance follows from the one before, over rows in a result table, in their order. */
export async function balanceOf(rows: ResultSet, s: StatementColumns & { balance: string }): Promise<Check | null> {
  if (!rows.table) return null
  const col = (n: string) => rows.columns.find((c) => c.name === n)!
  const check = readBalanceCheck(await first(balanceCheckSql(rows.table, s, (n) => !!col(n).numeric, (n) => colRef(col(n)))))
  return balanceText(check, s.balance, nf, money)
}

/**
 * A statement's roll-forward, when steps leave out its opening and closing balance lines: the opening line
 * plus money in less money out (the rows kept) against the closing line. Tied to the balance lines' step.
 */
export async function rollForward(table: string, columns: Col[], drop: DropRows[]): Promise<Found | null> {
  const lines = drop.find((d) => (d.kind ? d.kind === 'balance' : /balance line/.test(d.label)))
  const st = statementColumns(columns)
  if (!lines || !st?.balance) return null
  const numeric = (n: string) => isNumericType(columns.find((c) => c.name === n)?.type ?? '')
  const text = columns.filter((c) => /CHAR|TEXT|STRING/i.test(c.type)).map((c) => c.name)
  const sql = rollForwardSql(table, { ...st, balance: st.balance }, text, numeric, `(${drop.map((d) => `(${d.keep})`).join(' AND ')})`)
  const found = sql ? rollForwardText(await first(sql), money) : null
  return found && { ...found, step: lines.keep }
}

/**
 * Everything a statement's rows can be checked for, as a saved view runs on them: the total lines against
 * the rows, the running balance, the opening and closing lines, and where it opens against the period just
 * before it (from the view's periods). Also where it closes, and the period it covers, to keep.
 */
export async function checkRows({ table, columns, ops: o, rows, saved }: { table: string; columns: Col[]; ops: Ops; rows: ResultSet; saved?: SavedView }): Promise<{
  found: (Found | null)[]
  closing?: number
  period?: Period
}> {
  const found: (Found | null)[] = []
  const cols = columns.filter((c) => !isBalanceName(c.name)).map((c) => ({ name: c.name, numeric: isNumericType(c.type) }))
  const totals = o.drop?.find((d) => (d.kind ? d.kind === 'totals' : /total line/.test(d.label)))
  const tie = o.drop?.length ? tieOutSql(table, cols, o.drop) : null
  const tied = tie ? tieOutText(readTieOutRow(cols, await first(tie)), money) : null
  if (tied && totals) found.push({ ...tied, step: totals.keep })
  const st = statementColumns(rows.columns)
  let closing: number | undefined
  let period: Period | undefined
  if (st?.balance && rows.table && !o.sort && !o.filters.length && !o.search && !o.dedupe) {
    const col = (n: string) => rows.columns.find((c) => c.name === n)!
    const s = { ...st, balance: st.balance }
    const isN = (n: string) => !!col(n).numeric
    const ref = (n: string) => colRef(col(n))
    const counts = await first(balanceCheckSql(rows.table, s, isN, ref))
    found.push(balanceText(readBalanceCheck(counts), st.balance, nf, money))
    // Where it starts and ends, read the way round the rows run (not at all if they don't run either way).
    const order = readOrder(counts)
    const ends = order && readEnds(await first(endsSql(rows.table, s, isN, ref)), order)
    // The period these rows cover (by their dates), so each month is checked against the one before it,
    // whatever ran last: May again after June, or April after both, isn't a statement gone missing.
    const date = rows.columns.find(isTemporal)
    const span = date && ((await first(`SELECT min(${colRef(date)})::DATE::VARCHAR AS a, max(${colRef(date)})::DATE::VARCHAR AS b FROM ${rows.table}`)) as unknown as { a: string | null; b: string | null })
    if (ends && span?.a && span.b) {
      // Run again on the same month, it's checked against the month before, as it was the first time.
      const before = (saved?.periods ?? []).filter((p) => p.to < span.a!).sort((x, y) => (x.to < y.to ? 1 : -1))[0]
      if (before) found.push(continuityText(ends.opening, { table: before.table === table ? `the statement to ${before.to}` : before.table, closing: before.closing }, money))
      period = { from: span.a, to: span.b, closing: ends.closing, table, rows: rows.rowCount }
    } else if (ends && saved?.last?.closing !== undefined && saved.last.table.toLowerCase() !== table.toLowerCase()) {
      // No dates to tell the months apart (left as text): against the file it ran on last, if that's another.
      found.push(continuityText(ends.opening, { table: saved.last.table, closing: saved.last.closing }, money))
    }
    closing = ends?.closing ?? undefined
  }
  if (o.drop?.length) found.push(await rollForward(table, columns, o.drop).catch(() => null))
  return { found, closing, period }
}

/**
 * The bank reconciliation statement for a match, as a query: the bank's closing balance (where its running
 * balance ends, read the way round its rows run) and the lines left over on each side. Also which table is
 * the bank, and whether its closing balance was found: 'none' without a running balance, 'unread' when the
 * balance doesn't follow its rows either way round.
 */
export async function reconcileQuery({ sql, spec }: { sql: string; spec: MatchSpec }): Promise<{ sql: string; bank: string; closing: 'found' | 'none' | 'unread' }> {
  const { conn } = await getEngine()
  const describe = async (s: MatchSide) =>
    (await conn.query(`DESCRIBE SELECT * FROM ${numberedRows(s)}`)).toArray().map((r) => {
      const j = r.toJSON()
      return { name: String(j.column_name), type: String(j.column_type) }
    })
  const [ca, cb] = await Promise.all([describe(spec.a), describe(spec.b)])
  const { bank, statement } = bankOf({ a: ca, b: cb })
  let closing: number | null = null
  let asOf: string | null = null
  if (statement) {
    const side = spec[bank]
    const rows = numberedRows(side)
    const types = bank === 'a' ? ca : cb
    const isN = (n: string) => isNumericType(types.find((c) => c.name === n)?.type ?? '')
    const counts = await first(balanceCheckSql(rows, statement, isN))
    const order = readOrder(counts)
    const ends = order && readEnds(await first(endsSql(rows, statement, isN)), order)
    if (ends) {
      closing = Math.round(ends.closing * 100) / 100
      asOf = ((await first(`SELECT max(${quoteIdent(side.date)})::DATE::VARCHAR AS d FROM ${rows}`)) as unknown as { d: string | null }).d
    }
  }
  return { sql: brsSql({ match: sql, spec, bank, closing, asOf }), bank: spec[bank].table, closing: !statement ? 'none' : closing === null ? 'unread' : 'found' }
}
