import { useEffect, useState } from 'react'
import { LOCALE } from '../engine/sql'
import { getEngine } from '../engine/db'
import { share } from '../grid/format'
import type { TableMeta } from '../engine/tables'
import { bestPair, lookupMissesSql, lookupNames, lookupStatsSql, suggestMatch, type Lookup } from '../engine/lookup'
import type { ColumnInfo } from '../engine/result'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  /** The result's columns that can be matched on. */
  columns: ColumnInfo[]
  /** Every column name the result has (hidden ones too): brought columns get other names. */
  taken: string[]
  /** The query the result comes from, for the match preview. */
  source: string
  /** Tables to look up from. */
  tables: TableMeta[]
  /** The column to match on, when opened from a column's menu. */
  initialHere?: string
  onApply: (l: Lookup) => void
  onClose: () => void
}

const nf = new Intl.NumberFormat(LOCALE)
const MAX_DEFAULT = 6

/** VLOOKUP without the formula: pick a table, the matching columns, and what to bring over. */
export function LookupDialog({ columns, taken, source, tables, initialHere, onApply, onClose }: Props) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  // Opened from a column: that column. From the toolbar: the likeliest column and table pair.
  const [guess] = useState(() => (initialHere ? null : bestPair(columns, tables)))
  const [here, setHere] = useState(initialHere ?? guess?.here ?? columns[0]?.name ?? '')
  // The table most likely to have this column (same or similar name), else the first.
  const [tableName, setTableName] = useState(() => guess?.table ?? (tables.find((t) => suggestMatch(here, t.columns)) ?? tables[0])?.name ?? '')
  const table = tables.find((t) => t.name === tableName)
  const [picked, setPicked] = useState<{ for: string; there: string; bring: string[] } | null>(null)
  const [loose, setLoose] = useState(true)
  const [stats, setStats] = useState<
    { key: string; rows: number; matched: number; repeated: number; misses: { value: string; rows: number }[] } | { key: string; error: string } | null
  >(null)

  // Defaults for this table: the likely matching column, and its other columns to bring.
  const pickKey = `${tableName}\u0000${here}`
  const there = picked?.for === pickKey ? picked.there : table ? (suggestMatch(here, table.columns) ?? table.columns[0]?.name ?? '') : ''
  const bring = picked?.for === pickKey ? picked.bring : table ? table.columns.map((c) => c.name).filter((c) => c !== there).slice(0, MAX_DEFAULT) : []
  const set = (patch: Partial<{ there: string; bring: string[] }>) => setPicked({ for: pickKey, there, bring, ...patch })

  const hereType = columns.find((c) => c.name === here)?.type ?? 'VARCHAR'
  const thereType = table?.columns.find((c) => c.name === there)?.type ?? 'VARCHAR'
  const spec: Lookup | null =
    table && here && there && bring.length
      ? {
            table: table.name,
            here,
            there,
            bring: lookupNames(taken, table.name, bring),
            loose,
            types: { here: hereType, there: thereType },
            view: table.kind === 'view',
          }
      : null

  // How many rows will find a match (debounced, computed on all rows in this tab).
  const statsKey = spec ? `${spec.table}\u0000${spec.here}\u0000${spec.there}\u0000${spec.loose}\u0000${source}` : ''
  useEffect(() => {
    if (!spec) return
    let live = true
    const t = window.setTimeout(async () => {
      try {
        const { conn } = await getEngine()
        const row = (await conn.query(lookupStatsSql(`(\n${source}\n)`, spec))).toArray()[0]?.toJSON() as { rows: number; matched: number; repeated: number }
        // Some rows find nothing: which values, so the reason shows (A-1 here, A1 there; a product not listed).
        const misses =
          Number(row.matched) > 0 && Number(row.matched) < Number(row.rows)
            ? (await conn.query(lookupMissesSql(`(\n${source}\n)`, spec))).toArray().map((r) => {
                const o = r.toJSON() as { v: string; n: number }
                return { value: String(o.v), rows: Number(o.n) }
              })
            : []
        if (live) setStats({ key: statsKey, rows: Number(row.rows), matched: Number(row.matched), repeated: Number(row.repeated), misses })
      } catch (e) {
        if (live) setStats({ key: statsKey, error: e instanceof Error ? e.message.replace(/^.*?Error: /, '') : String(e) })
      }
    }, 400)
    return () => {
      live = false
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statsKey captures what matters
  }, [statsKey])
  const shown = stats?.key === statsKey ? stats : null
  const renamed = spec?.bring.filter((b) => b.as !== b.column) ?? []
  const noMatch = !!shown && !('error' in shown) && shown.rows > 0 && shown.matched === 0

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="lookup-title" className="modal-wrap modal-wrap-wide">
        <form
          className="shell modal modal-wide"
          onSubmit={(e) => {
            e.preventDefault()
            if (spec) onApply(spec)
          }}
        >
          <div className="core">
            <span className="eyebrow">Look up</span>
            <h2 id="lookup-title">Bring in columns from another table</h2>
            <p className="muted">Like VLOOKUP: rows are matched by a column, every row of yours stays exactly once, and rows without a match get empty values.</p>

            {!tables.length ? (
              <p className="pivot-error" role="alert">
                Open another file first: there's no other table to look up from.
              </p>
            ) : (
              <>
                <div className="lookup-match">
                  <label>
                    <span>From table</span>
                    <select value={tableName} onChange={(e) => setTableName(e.target.value)}>
                      {tables.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Match your column</span>
                    <select value={here} onChange={(e) => setHere(e.target.value)}>
                      {columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>with its column</span>
                    <select value={there} onChange={(e) => set({ there: e.target.value, bring: bring.filter((b) => b !== e.target.value) })}>
                      {table?.columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <fieldset className="pivot-zone">
                  <legend>Bring these columns</legend>
                  <div className="compare-cols">
                    {table?.columns
                      .filter((c) => c.name !== there)
                      .map((c) => (
                        <label className="inline" key={c.name}>
                          <input
                            type="checkbox"
                            checked={bring.includes(c.name)}
                            onChange={(e) => set({ bring: e.target.checked ? [...bring, c.name] : bring.filter((b) => b !== c.name) })}
                          />
                          {c.name}
                        </label>
                      ))}
                  </div>
                  {renamed.length > 0 && (
                    <p className="fine">
                      Your result already has {renamed.map((r) => r.column).join(', ')}: they come in as {renamed.map((r) => r.as).join(', ')}.
                    </p>
                  )}
                </fieldset>

                <label className="inline">
                  <input type="checkbox" checked={loose} onChange={(e) => setLoose(e.target.checked)} /> Ignore upper / lower case and spaces at the ends when matching
                </label>

                <p className={`lookup-stats fine${noMatch ? ' is-warning' : ''}`} role="status">
                  {!spec
                    ? 'Pick at least one column to bring.'
                    : !shown
                      ? 'Checking matches…'
                      : 'error' in shown
                        ? `Can’t match these columns: ${shown.error}`
                        : shown.rows > 0 && shown.matched === 0
                          ? `No rows match: ${here} and ${there} don’t share any values. Pick the columns that hold the same thing (an ID, a code, a name).`
                          : (
                            <>
                              <b>
                                {nf.format(shown.matched)} of {nf.format(shown.rows)}
                              </b>{' '}
                              rows find a match{shown.rows ? ` (${share(shown.matched, shown.rows)})` : ''}.
                              {shown.repeated > 0 && ` ${nf.format(shown.repeated)} ${shown.repeated === 1 ? 'value repeats' : 'values repeat'} in ${tableName}: the first row is used.`}
                              {shown.misses.length > 0 && (
                                <span className="lookup-misses">
                                  {' '}
                                  Not in {tableName}: {shown.misses.map((m) => `${m.value} (${nf.format(m.rows)} ${m.rows === 1 ? 'row' : 'rows'})`).join(', ')}
                                  {shown.rows - shown.matched > shown.misses.reduce((n, m) => n + m.rows, 0) ? '…' : '.'}
                                </span>
                              )}
                            </>
                          )}
                </p>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!spec || (!!shown && 'error' in shown) || noMatch}>
                Bring {bring.length || ''} {bring.length === 1 ? 'column' : 'columns'}
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
