import { useState } from 'react'
import type { AgeingColumns } from '../engine/statement'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

/** Today in the reader's own calendar, as YYYY-MM-DD. */
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Ageing as on a day: today to start with, or the month's last day for month-end (the ages are counted to
 * it, and it's in the result's name).
 */
export function AgeingDialog({ columns, onRun, onClose }: { columns: AgeingColumns; onRun: (asOf: string) => void; onClose: () => void }) {
  const [asOf, setAsOf] = useState(today)
  const dialog = useDialog<HTMLDivElement>(onClose)
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(asOf)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="ageing-title" className="modal-wrap">
        <form
          className="shell modal"
          onSubmit={(e) => {
            e.preventDefault()
            if (ok) onRun(asOf)
          }}
        >
          <div className="core">
            <span className="eyebrow">Ageing</span>
            <h2 id="ageing-title">
              {columns.amount} by {columns.party}
            </h2>
            <p className="muted">
              Each {columns.party}’s {columns.amount}, by how long it has been {columns.by === 'due' ? `due (from ${columns.date})` : `since the bill (${columns.date})`}: not
              yet due, 0–30 days, 31–60… over 180. An advance the other way round shows on account.
            </p>
            <label className="field-label" htmlFor="ageing-as-on">
              As on
            </label>
            <input id="ageing-as-on" className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} autoFocus required />
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!ok}>
                Show the ageing
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
