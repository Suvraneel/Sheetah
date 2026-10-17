import { useState } from 'react'
import { LOCALE } from '../engine/sql'
import { emptyColumns, type ColumnInfo } from '../engine/result'
import { seriesColumns, unpivotNames, unpivotSql } from '../engine/unpivot'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  columns: ColumnInfo[]
  rows: number
  /** The rows to turn (the composed query, without sorting). */
  source: string
  /** A column to start from, when opened from its menu. */
  around?: string
  onApply: (sql: string) => void
  onClose: () => void
}

const nf = new Intl.NumberFormat(LOCALE)

/** Columns → rows: Jan, Feb, … Dec become one "month" column and one "value" column. */
export function UnpivotDialog({ columns, rows, source, around, onApply, onClose }: Props) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  const series = seriesColumns(columns)
  const [chosen, setChosen] = useState<string[]>(() => {
    if (series && (!around || series.columns.includes(around))) return series.columns
    // From a column's menu: that column and the others of its kind (numbers with numbers).
    const start = columns.find((c) => c.name === around)
    if (!start) return []
    const alike = columns.filter((c) => c.numeric === start.numeric && c.type === start.type).map((c) => c.name)
    // Every column alike (all text, say): the first is probably what the rows are, so it stays a column.
    if (alike.length < columns.length) return alike
    return around === columns[0].name ? [around] : alike.filter((c) => c !== columns[0].name)
  })
  const [keepEmpty, setKeepEmpty] = useState(false)
  const [working, setWorking] = useState(false)
  const remaining = columns.filter((c) => !chosen.includes(c.name)).map((c) => c.name)
  const [names, setNames] = useState(() => unpivotNames(series && chosen.every((c) => series.columns.includes(c)) ? series.kind : null, remaining))
  const clash = [names.name, names.value].find((n) => remaining.some((r) => r.toLowerCase() === n.trim().toLowerCase()))
  const same = names.name.trim().toLowerCase() === names.value.trim().toLowerCase()
  const ready = chosen.length >= 1 && remaining.length >= 1 && !!names.name.trim() && !!names.value.trim() && !clash && !same && !working

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="unpivot-title" className="modal-wrap">
        <form
          className="shell modal"
          onSubmit={(e) => {
            e.preventDefault()
            if (!ready) return
            const ordered = columns.filter((c) => chosen.includes(c.name)).map((c) => c.name)
            const spec = { columns: ordered, name: names.name.trim(), value: names.value.trim(), keepEmpty }
            setWorking(true)
            // Empty columns (read as text) mustn't turn the numbers into text.
            void emptyColumns(source, ordered)
              .catch(() => [])
              .then((empty) => onApply(unpivotSql(`(\n${source}\n)`, spec, columns, empty)))
          }}
        >
          <div className="core">
            <span className="eyebrow">Unpivot</span>
            <h2 id="unpivot-title">Turn columns into rows</h2>
            <p className="muted">
              For reports laid out one column per month (or quarter, or year): each row becomes one row per column, so it can be filtered, charted and pivoted.
            </p>
            <fieldset className="pivot-zone">
              <legend>Columns to turn into rows</legend>
              <div className="compare-cols">
                {columns.map((c) => (
                  <label className="inline" key={c.name}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.name)}
                      onChange={(e) => setChosen(e.target.checked ? [...chosen, c.name] : chosen.filter((x) => x !== c.name))}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="unpivot-names">
              <label>
                <span className="fine">Column for their names</span>
                <input className="input" value={names.name} onChange={(e) => setNames({ ...names, name: e.target.value })} />
              </label>
              <label>
                <span className="fine">Column for their values</span>
                <input className="input" value={names.value} onChange={(e) => setNames({ ...names, value: e.target.value })} />
              </label>
            </div>
            <label className="inline">
              <input type="checkbox" checked={keepEmpty} onChange={(e) => setKeepEmpty(e.target.checked)} /> Keep empty cells as rows (so every row keeps every{' '}
              {names.name.trim() || 'column'})
            </label>
            <p className={`fine stack-report${clash || same ? ' unpivot-warning' : ''}`} role="status">
              {!chosen.length
                ? 'Pick the columns to turn into rows.'
                : !remaining.length
                  ? 'Leave at least one column as it is, to say what each row is.'
                  : clash
                  ? `“${clash}” is already a column: pick another name.`
                  : same
                    ? 'The two new columns need different names.'
                    : `${nf.format(rows)} rows × ${chosen.length} ${chosen.length === 1 ? 'column' : 'columns'} → ${keepEmpty ? '' : 'up to '}${nf.format(rows * chosen.length)} rows${keepEmpty ? '' : ' (empty cells are left out)'}, keeping ${remaining.length} ${remaining.length === 1 ? 'column' : 'columns'} as they are.`}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!ready}>
                Turn {chosen.length || ''} {chosen.length === 1 ? 'column' : 'columns'} into rows
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
