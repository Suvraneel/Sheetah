import { useEffect, useState } from 'react'
import { getEngine } from '../engine/db'
import { LOCALE } from '../engine/sql'
import type { TableColumns } from '../engine/compare-sql'
import { sourceName, stackCandidates, stackLossSql, stackOverlapSql, stackReport, stackSql, textColumns, type StackLoss } from '../engine/stack'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  tables: (TableColumns & { rows: number | null })[]
  /** A table to start from: the ones like it are pre-selected. */
  around?: string
  onStack: (sql: string) => void
  onClose: () => void
}

const nf = new Intl.NumberFormat(LOCALE)
const list = (names: string[]) => (names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '))
/** Cells looked over for rows in two tables, at most: past this, the check would hold the engine (and the stack) up. */
const OVERLAP_CELLS = 4_000_000

interface Found {
  key: string
  /** Text read as numbers that isn't one: becomes empty (a few), or the column stacks as text (more). */
  lost: StackLoss[]
  /** Pairs of tables sharing whole rows. */
  twice: { tables: string[]; n: number }[]
}

/** What reading the tables' text as numbers would leave empty (asked of the engine). */
async function lossesOf(picked: TableColumns[]): Promise<StackLoss[]> {
  const sql = stackLossSql(picked)
  if (!sql) return []
  const { conn } = await getEngine()
  return (await conn.query(sql)).toArray().map((r) => {
    const o = r.toJSON() as { tbl: string; col: string; filled: number; lost: number; example: string }
    return { table: o.tbl, column: o.col, filled: Number(o.filled), lost: Number(o.lost), example: String(o.example) }
  })
}

/** Several exports of the same kind (one per month, per branch…) into one table. */
export function StackDialog({ tables, around, onStack, onClose }: Props) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  const [chosen, setChosen] = useState<string[]>(() => {
    const like = stackCandidates(around ?? tables[tables.length - 1]?.name ?? '', tables)
    return like.length >= 2 ? like : tables.map((t) => t.name)
  })
  const [withSource, setWithSource] = useState(true)
  const picked = tables.filter((t) => chosen.includes(t.name))
  // Views (Parquet read in place) have no stored row count.
  const rows = picked.some((t) => t.rows === null) ? null : picked.reduce((n, t) => n + (t.rows ?? 0), 0)
  const ready = picked.length >= 2
  // Before stacking: what reading text as numbers would leave empty, and rows in two tables (a month and
  // its revision both ticked), so neither is found only in the totals.
  const key = picked.map((t) => t.name).join('\u0000')
  const [found, setFound] = useState<Found | null>(null)
  useEffect(() => {
    if (!ready) return
    let live = true
    const t = window.setTimeout(async () => {
      try {
        const lost = await lossesOf(picked)
        if (!live) return
        setFound({ key, lost, twice: [] })
        // Once the picks have settled, and only while it's quick: every column of every row is grouped.
        const columns = new Set(picked.flatMap((p) => p.columns.map((c) => c.name.toLowerCase()))).size
        if (rows === null || rows * columns > OVERLAP_CELLS) return
        const { conn } = await getEngine()
        const twice = (await conn.query(stackOverlapSql({ tables: picked.map((p) => p.name), source: null }, picked))).toArray().map((r) => {
          const o = r.toJSON() as { tables: { toArray: () => string[] }; n: number }
          return { tables: [...o.tables.toArray()], n: Number(o.n) }
        })
        if (live) setFound({ key, lost, twice })
      } catch {
        /* a check, not the stack: it stacks either way */
      }
    }, 600)
    return () => {
      live = false
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures the tables picked
  }, [key])
  const shown = found?.key === key ? found : null
  // Columns with more than a few values that aren't numbers: stacked as text, nothing emptied.
  const asText = shown ? textColumns(shown.lost) : []
  const report = stackReport(picked, asText)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="stack-title" className="modal-wrap">
        <form
          className="shell modal"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!ready) return
            // Stacked before the look-over said what reading text as numbers would lose: asked now.
            const text = shown ? asText : textColumns(await lossesOf(picked).catch(() => []))
            onStack(stackSql({ tables: picked.map((t) => t.name), source: withSource ? sourceName(picked) : null, text }, picked))
          }}
        >
          <div className="core">
            <span className="eyebrow">Stack</span>
            <h2 id="stack-title">Stack tables into one</h2>
            <p className="muted">For several exports of the same kind (one per month, per branch). Columns are matched by name.</p>
            <fieldset className="pivot-zone">
              <legend>Tables to stack</legend>
              <div className="compare-cols">
                {tables.map((t) => (
                  <label className="inline" key={t.name}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(t.name)}
                      onChange={(e) => setChosen(e.target.checked ? [...chosen, t.name] : chosen.filter((c) => c !== t.name))}
                    />
                    {t.name}
                    {t.rows !== null && <span className="fine"> · {nf.format(t.rows)} rows</span>}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="inline">
              <input type="checkbox" checked={withSource} onChange={(e) => setWithSource(e.target.checked)} /> Add a column saying which table each row came from
            </label>
            <p className="fine stack-report" role="status">
              {!ready ? (
                'Pick at least two tables.'
              ) : (
                <>
                  {rows !== null && `${nf.format(rows)} rows · `}
                  {report.columns + (withSource ? 1 : 0)} columns.
                  {report.partial.length > 0 && ` Not in every table (empty where missing): ${list(report.partial)}.`}
                  {report.asText.length > 0 && ` Stacked as text because the type differs: ${list(report.asText)}.`}
                  {report.asNumbers.map((a) => ` ${a.column} is text in ${list(a.tables)}: read as numbers.`).join('')}
                  {shown?.lost
                    .filter((l) => !asText.includes(l.column))
                    .map((l) => ` ${nf.format(l.lost)} ${l.lost === 1 ? 'value' : 'values'} of ${l.column} in ${l.table} ${l.lost === 1 ? 'isn’t a number and becomes' : 'aren’t numbers and become'} empty (“${l.example}”).`)
                    .join('')}
                  {shown?.twice.map((d) => (
                    <strong key={d.tables.join()} className="stack-twice">
                      {' '}
                      {nf.format(d.n)} {d.n === 1 ? 'row is' : 'rows are'} in {d.tables.length === 2 ? `both ${d.tables[0]} and ${d.tables[1]}` : list(d.tables)}: stacked, {d.n === 1 ? 'it would' : 'they would'} count twice.
                    </strong>
                  ))}
                </>
              )}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!ready}>
                Stack {picked.length >= 2 ? picked.length : ''} tables
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
