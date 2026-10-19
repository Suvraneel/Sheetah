import { useEffect, useMemo, useState } from 'react'
import { AGGS, isTemporal, type Agg } from '../engine/chart'
import {
  GRAINS,
  MAX_PIVOT_COLUMNS,
  TooManyColumnsError,
  cardinalities,
  columnValues,
  defaultPivot,
  fieldFor,
  groupable,
  pivotSql,
  type Field,
  type PivotSpec,
} from '../engine/pivot'
import type { ColumnInfo } from '../engine/result'
import { isIdLike, LOCALE } from '../engine/sql'
import { BtnIcon, Icon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  /** The query being summarised and its columns. */
  sourceSql: string
  columns: ColumnInfo[]
  rowCount: number
  initial?: PivotSpec
  /** A pivot to start from (not one being edited): categories by month, say. */
  start?: PivotSpec
  /** Number columns stored as text (not offered as values until converted), and the one-click conversion. */
  textNumbers?: string[]
  onConvert?: () => void
  onCreate: (sql: string, spec: PivotSpec) => void
  onClose: () => void
}

const nf = new Intl.NumberFormat(LOCALE)
const MAX_VALUES = 3

export function PivotDialog({ sourceSql, columns, rowCount, initial, start, textNumbers, onConvert, onCreate, onClose }: Props) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  // A pivot to start from only if its fields are here (the rows may have changed since it was offered).
  const fits = (s: PivotSpec) => [...s.rows, ...(s.columns ? [s.columns] : [])].every((f) => columns.some((c) => c.name === f.column)) && s.values.every((v) => !v.column || columns.some((c) => c.name === v.column && c.numeric))
  const [edited, setEdited] = useState<PivotSpec | null>(initial ?? (start && fits(start) ? start : null))
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let live = true
    cardinalities(sourceSql, columns, rowCount)
      .then((c) => live && setCounts(c))
      .catch(() => live && setCounts({}))
    return () => {
      live = false
    }
  }, [sourceSql, columns, rowCount])

  const spec = edited ?? (counts ? defaultPivot(columns, counts) : null)
  // Once the fields are there, start on the first of them: not on Cancel (all the dialog had while it
  // looked), nor on a field's remove button.
  const ready = spec !== null
  useEffect(() => {
    const el = dialog.current
    if (!ready || !el) return
    const at = document.activeElement as HTMLElement | null
    if (!at?.closest('.pivot-grid') || at.tagName === 'BUTTON') el.querySelector<HTMLElement>('.pivot-grid select')?.focus({ preventScroll: true })
  }, [ready, dialog])
  const fields = useMemo(() => groupable(columns), [columns])
  const numeric = columns.filter((c) => c.numeric)
  const measures = numeric.filter((c) => !isIdLike(c.name)) // never "Sum of Voucher No."
  const nextMeasure = (used: (string | null)[]) => measures.find((c) => !used.includes(c.name)) ?? measures[0] ?? numeric[0]
  const update = (patch: Partial<PivotSpec>) => {
    if (!spec) return
    setError(null)
    setEdited({ ...spec, ...patch })
  }
  const colInfo = (name: string) => columns.find((c) => c.name === name)
  // How many different values (an estimate past a thousand): a field with 3 goes across, one with 3,000 down.
  const size = (name: string) => (counts?.[name] ? ` (${counts[name] > 1000 ? 'about ' : ''}${nf.format(counts[name])} ${counts[name] === 1 ? 'value' : 'values'})` : '')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!spec) return
    if (!spec.rows.length && !spec.columns) {
      setError('Pick at least one field for rows or columns.')
      return
    }
    setWorking(true)
    setError(null)
    try {
      const values = await columnValues(sourceSql, spec, columns)
      onCreate(pivotSql(sourceSql, spec, columns, values), spec)
    } catch (err) {
      setError(
        err instanceof TooManyColumnsError
          ? `${err.message} Put it in Rows instead, pick a coarser date grain, or filter the result first.`
          : err instanceof Error
            ? err.message
            : String(err),
      )
      setWorking(false)
    }
  }

  const grainSelect = (f: Field, onChange: (f: Field) => void, label: string) => {
    const col = colInfo(f.column)
    if (!col || !isTemporal(col)) return null
    return (
      <select className="pivot-grain" aria-label={label} value={f.grain} onChange={(e) => onChange({ ...f, grain: e.target.value as Field['grain'] })}>
        {GRAINS.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label}
          </option>
        ))}
      </select>
    )
  }

  const unusedForRows = spec ? fields.filter((c) => !spec.rows.some((r) => r.column === c.name)) : []

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pivot-title" className="modal-wrap modal-wrap-wide">
        <form className="shell modal modal-wide" onSubmit={(e) => void submit(e)}>
          <div className="core">
            <span className="eyebrow">Pivot table</span>
            <h2 id="pivot-title">Summarize this result</h2>
            <p className="muted">
              Totals over all {nf.format(rowCount)} rows. The pivot opens like any result: chart it, export it or save it as a view.
            </p>

            {!spec ? (
              <p className="muted small">Looking at the columns…</p>
            ) : (
              <div className="pivot-grid">
                <fieldset className="pivot-zone">
                  <legend>Rows</legend>
                  {spec.rows.map((f, i) => (
                    <div className="pivot-field" key={f.column}>
                      <span className="pivot-name">{f.column}</span>
                      {grainSelect(f, (nf2) => update({ rows: spec.rows.map((r, j) => (j === i ? nf2 : r)) }), `Group ${f.column} by`)}
                      <button type="button" className="icon-btn" aria-label={`Remove ${f.column} from rows`} onClick={() => update({ rows: spec.rows.filter((_, j) => j !== i) })}>
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  ))}
                  {spec.rows.length < 3 && unusedForRows.length > 0 && (
                    <select
                      className="pivot-add"
                      aria-label="Add a row field"
                      value=""
                      onChange={(e) => {
                        const col = colInfo(e.target.value)
                        if (col) update({ rows: [...spec.rows, fieldFor(col)] })
                      }}
                    >
                      <option value="">+ Add a field</option>
                      {unusedForRows.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                          {size(c.name)}
                        </option>
                      ))}
                    </select>
                  )}
                </fieldset>

                <fieldset className="pivot-zone">
                  <legend>Columns</legend>
                  <div className="pivot-field">
                    <select
                      aria-label="Column field"
                      value={spec.columns?.column ?? ''}
                      onChange={(e) => {
                        const col = colInfo(e.target.value)
                        update({ columns: col ? fieldFor(col) : null })
                      }}
                    >
                      <option value="">None</option>
                      {fields.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                          {size(c.name)}
                        </option>
                      ))}
                    </select>
                    {spec.columns && grainSelect(spec.columns, (f) => update({ columns: f }), `Group ${spec.columns.column} by`)}
                  </div>
                  <p className="fine">One column per value, up to {MAX_PIVOT_COLUMNS}.</p>
                </fieldset>

                <fieldset className="pivot-zone">
                  <legend>Values</legend>
                  {spec.values.map((v, i) => (
                    <div className="pivot-field" key={i}>
                      <select
                        aria-label={`Value ${i + 1} calculation`}
                        value={v.agg}
                        onChange={(e) => {
                          const agg = e.target.value as Agg
                          update({
                            values: spec.values.map((x, j) => (j === i ? { agg, column: agg === 'count' ? null : (x.column ?? nextMeasure([])?.name ?? null) } : x)),
                          })
                        }}
                      >
                        {AGGS.filter((a) => a.id === 'count' || numeric.length).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                      {v.agg !== 'count' && (
                        <select
                          aria-label={`Value ${i + 1} column`}
                          value={v.column ?? ''}
                          onChange={(e) => update({ values: spec.values.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}
                        >
                          {numeric.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      )}
                      {spec.values.length > 1 && (
                        <button type="button" className="icon-btn" aria-label={`Remove value ${i + 1}`} onClick={() => update({ values: spec.values.filter((_, j) => j !== i) })}>
                          <Icon name="close" size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                  {spec.values.length < MAX_VALUES && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        const m = nextMeasure(spec.values.map((v) => v.column))
                        update({ values: [...spec.values, m ? { agg: 'avg', column: m.name } : { agg: 'count', column: null }] })
                      }}
                    >
                      + Add a value
                    </button>
                  )}
                  {onConvert && !!textNumbers?.length && (
                    <p className="fine">
                      {textNumbers.slice(0, 2).join(', ')}
                      {textNumbers.length > 2 ? ` and ${textNumbers.length - 2} more` : ''} {textNumbers.length === 1 ? 'is' : 'are'} stored as text, so not listed.{' '}
                      <button type="button" className="link-btn" onClick={onConvert}>
                        Convert to numbers
                      </button>
                    </p>
                  )}
                </fieldset>

                <fieldset className="pivot-zone">
                  <legend>Options</legend>
                  <label className="inline">
                    <input type="checkbox" checked={spec.totals} onChange={(e) => update({ totals: e.target.checked })} /> Grand total row
                  </label>
                  <div className="pivot-field">
                    <select aria-label="Sort rows" value={spec.sort} onChange={(e) => update({ sort: e.target.value as PivotSpec['sort'] })}>
                      <option value="label">Sort rows by name</option>
                      <option value="value">Sort rows by total, high to low</option>
                    </select>
                  </div>
                </fieldset>
              </div>
            )}

            {error && (
              <p className="pivot-error" role="alert">
                {error}
              </p>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!spec || working}>
                {working ? 'Building…' : initial ? 'Update pivot' : 'Create pivot'}
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
