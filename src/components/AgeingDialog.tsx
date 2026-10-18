import { useState } from 'react'
import type { AgeingColumns } from '../engine/statement'
import { LOCALE, WORDS } from '../engine/sql'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** Today in the reader's own calendar, as YYYY-MM-DD. */
const today = () => iso(new Date())
/** The days a month-end asks about: today, the last day of last month, the last 31 March (a financial year's end). */
function quickDays(): { label: string; day: string }[] {
  const now = new Date()
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0)
  const march = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 2, 31)
  const name = (d: Date) => d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })
  return [
    { label: 'Today', day: today() },
    { label: `Month end (${name(monthEnd)})`, day: iso(monthEnd) },
    { label: `Year end (${name(march)})`, day: iso(march) },
  ]
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
            <span className="eyebrow">{WORDS.ageing}</span>
            <h2 id="ageing-title">
              {columns.amount} by {columns.party}
            </h2>
            <p className="muted">
              What’s open with each {columns.party} ({columns.amount}), by how long it has been {columns.by === 'due' ? `due (from ${columns.date})` : `since the bill (${columns.date})`}: not
              yet due, 0–30 days, 31–60… over 180. An advance the other way round shows on account
              {columns.bill ? `; a bill dated (${columns.bill}) after the day isn’t counted` : ''}.
            </p>
            <label className="field-label" htmlFor="ageing-as-on">
              {WORDS.asOn}
            </label>
            <input id="ageing-as-on" className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} autoFocus required />
            <div className="chips ageing-days" role="group" aria-label="Pick a day">
              {quickDays().map((q) => (
                <button key={q.label} type="button" className={`chip${asOf === q.day ? ' is-on' : ''}`} aria-pressed={asOf === q.day} onClick={() => setAsOf(q.day)}>
                  {q.label}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!ok}>
                Show the {WORDS.ageing.toLowerCase()}
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
