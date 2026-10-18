/*
 * The books exported whole (a day book: each voucher's lines, each to its ledger), summed by ledger: what
 * went through each account over the period, debits against credits, and where each one ends up (loaded
 * only when asked for).
 */
import { commentText, quoteIdent, sqlName } from './sql'
import type { StatementColumns } from './statement'

/**
 * Each ledger's debits and credits, and its net as Dr or Cr (as a trial balance writes it), then the
 * total: the debits equal the credits when every voucher balances. `rows` is the day book as a query;
 * `s` its columns as statementColumns reads books (money in is the Debit column).
 */
export function ledgerTotalsSql(rows: string, s: StatementColumns, ledger: string, numeric: (name: string) => boolean): string {
  const n = (c: string) => (numeric(c) ? `${sqlName(c)}::DOUBLE` : `number_from_text(${sqlName(c)}::VARCHAR)`)
  // The books' own Debit and Credit (statementColumns turns them round to the bank's money in and out).
  const [dr, cr] = s.books ? [s.credit, s.debit] : [s.debit, s.credit]
  const [L, D, C, ND, NC] = [ledger, dr, cr, `Net ${dr}`, `Net ${cr}`].map(quoteIdent)
  return `${commentText(`-- Totals by ${ledger}: each one's ${dr} and ${cr} over the period, and its net`)}
WITH t AS (
  SELECT coalesce(nullif(trim(${sqlName(ledger)}::VARCHAR), ''), '(none)') AS l, sum(coalesce(${n(dr)}, 0)) AS d, sum(coalesce(${n(cr)}, 0)) AS c
  FROM (
${rows}
  )
  GROUP BY 1
)
SELECT ${L}, round(d, 2) AS ${D}, round(c, 2) AS ${C}, round(nd, 2) AS ${ND}, round(nc, 2) AS ${NC} FROM (
  SELECT 0 AS o, l AS ${L}, d, c, greatest(d - c, 0) AS nd, greatest(c - d, 0) AS nc FROM t
  UNION ALL
  SELECT 1, 'Total', sum(d), sum(c), sum(greatest(d - c, 0)), sum(greatest(c - d, 0)) FROM t
)
ORDER BY o, ${L}`
}
