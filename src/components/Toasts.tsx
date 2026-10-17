import { BusyToast } from './BusyToast'
import { Icon } from './Icon'

export interface Offer {
  label: string
  action: string
  run: () => void
}

interface Props {
  /** A new version is waiting: reload to use it. */
  onUpdate?: () => void
  busy: string | null
  onCancelBusy?: (() => void) | null
  /** Something just deleted, with a way back. */
  undo?: { label: string; run: () => void } | null
  onUndone?: () => void
  /** A suggestion with an action ("sales_nov looks like a newer sales_oct · Compare"). */
  nudge?: Offer | null
  onNudgeDone?: () => void
  message?: string | null
}

/** One stack of notices at the bottom, so an undo offer and a suggestion never sit on top of each other. */
export function Toasts({ onUpdate, busy, onCancelBusy, undo, onUndone, nudge, onNudgeDone, message }: Props) {
  return (
    <div className="toast-stack">
      {onUpdate && (
        <p className="toast" role="status">
          <Icon name="spark" /> <span className="toast-text">A new version of Sheetah is ready.</span>
          <button className="toast-action" onClick={onUpdate} title="Reloads the page. Open tables are cleared unless you keep them in this browser.">
            Reload
          </button>
        </p>
      )}
      {busy && <BusyToast key={busy.replace(/ \d+%$/, '')} label={busy} onCancel={onCancelBusy ?? null} />}
      {undo && !busy && (
        <p className="toast" role="status">
          <span className="toast-text">{undo.label}</span>
          <button
            className="toast-action"
            onClick={() => {
              undo.run()
              onUndone?.()
            }}
          >
            Undo
          </button>
        </p>
      )}
      {nudge && (
        <p className="toast" role="status">
          <Icon name="compare" /> <span className="toast-text">{nudge.label}</span>
          <button
            className="toast-action"
            onClick={() => {
              nudge.run()
              onNudgeDone?.()
            }}
          >
            {nudge.action}
          </button>
          <button className="toast-close" aria-label="Dismiss" onClick={onNudgeDone}>
            <Icon name="close" size={12} />
          </button>
        </p>
      )}
      {message && (
        <p className="toast" role="status">
          <Icon name="spark" /> {message}
        </p>
      )}
    </div>
  )
}
