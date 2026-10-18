import { useState } from 'react'
import type { SavedView } from '../engine/views'
import { shapeOf, suggestTable } from '../engine/views'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

export function SaveViewDialog({
  sql,
  steps = [],
  tables,
  initialName,
  onSave,
  onClose,
}: {
  sql: string
  /** The steps in words (as their chips say them): shown instead of the SQL they make, which folds away. */
  steps?: string[]
  tables: string[]
  initialName: string
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initialName)
  const dialog = useDialog<HTMLDivElement>(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="save-title" className="modal-wrap">
      <form
        className="shell modal"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onSave(name.trim())
        }}
      >
        <div className="core">
          <span className="eyebrow">Saved view</span>
          <h2 id="save-title">Save this view</h2>
          <p className="muted">Re-run it any time, even on next month’s file. It’s kept in this browser.</p>
          <label className="field-label" htmlFor="view-name">
            Name
          </label>
          <input id="view-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          <p className="field-label">Reads from</p>
          <div className="chips">
            {tables.length ? tables.map((t) => <span key={t} className="chip static">{t}</span>) : <span className="muted small">No tables detected</span>}
          </div>
          {steps.length > 0 ? (
            <>
              <p className="field-label">Steps</p>
              <ol className="view-steps">
                {steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <details className="view-sql">
                <summary>The SQL they make</summary>
                <pre className="sql-preview">{sql}</pre>
              </details>
            </>
          ) : (
            <pre className="sql-preview">{sql}</pre>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary">
              Save view
              <BtnIcon name="bookmark" />
            </button>
          </div>
        </div>
      </form>
      </div>
    </div>
  )
}

export function RemapDialog({
  view,
  missing,
  available,
  shapes,
  prefer,
  onRun,
  onClose,
}: {
  view: SavedView
  missing: string[]
  available: string[]
  /** The open tables' column names: one that has a missing table's columns is the first guess. */
  shapes?: Record<string, string[]>
  /** The table on screen: the guess when it fits (it's what the library says the view fits). */
  prefer?: string
  onRun: (mapping: Record<string, string>, remember: boolean) => void
  onClose: () => void
}) {
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      missing.map((m) => {
        const want = shapeOf(view, m)?.map((c) => c.toLowerCase())
        const has = (t: string) => (shapes && Object.hasOwn(shapes, t) ? shapes[t] : [])
        const fits = want?.length ? available.filter((t) => want.every((c) => has(t).some((x) => x.toLowerCase() === c))) : []
        return [m, (prefer && fits.includes(prefer) ? prefer : fits.length ? suggestTable(m, fits) : suggestTable(m, available)) ?? '']
      }),
    ),
  )
  const [remember, setRemember] = useState(true)
  const dialog = useDialog<HTMLDivElement>(onClose)
  const ready = missing.every((m) => mapping[m])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="remap-title" className="modal-wrap">
      <form
        className="shell modal"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) onRun(mapping, remember)
        }}
      >
        <div className="core">
          <span className="eyebrow">{view.name}</span>
          <h2 id="remap-title">Point it at your new data</h2>
          <p className="muted">
            This view was saved for {missing.length === 1 ? 'a table' : 'tables'} that {missing.length === 1 ? 'isn’t' : 'aren’t'} open
            right now. Pick what to run it on instead.
          </p>
          {available.length === 0 ? (
            <p className="error">Open a file first, then run this view again.</p>
          ) : (
            <div className="remap">
              {missing.map((m) => (
                <label key={m} className="remap-row">
                  <span className="remap-from">{m}</span>
                  <span className="remap-arrow" aria-hidden>
                    →
                  </span>
                  <select value={mapping[m]} onChange={(e) => setMapping({ ...mapping, [m]: e.target.value })} aria-label={`Replacement for ${m}`}>
                    {available.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <label className="inline check-line">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Update the saved view to use {missing.length === 1 ? 'this table' : 'these tables'}
          </label>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready || !available.length}>
              Run view
              <BtnIcon name="play" />
            </button>
          </div>
        </div>
      </form>
      </div>
    </div>
  )
}

export function SharedQueryDialog({
  sql,
  onUse,
  onClose,
}: {
  sql: string
  onUse: () => void
  onClose: () => void
}) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="shared-title" className="modal-wrap">
        <div className="shell modal">
          <div className="core">
            <span className="eyebrow">Shared query</span>
            <h2 id="shared-title">Someone shared a query</h2>
            <p className="muted">
              Review it before running. It works on the files you open here, and Sheetah’s engine can’t send your data anywhere,
              even if the query tries.
            </p>
            <pre className="sql-preview tall">{sql}</pre>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Discard
              </button>
              <button type="button" className="btn btn-primary" onClick={onUse}>
                Put it in the editor
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
