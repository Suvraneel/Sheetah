import { useLayoutEffect, useRef } from 'react'
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
  /** The pointer or keyboard is on the notices (true) or has left them: they wait meanwhile. */
  onHold?: (held: boolean) => void
}

/**
 * One stack of notices at the bottom, so an undo offer and a suggestion never sit on top of each other.
 * What they say is announced by one live region that's always there (a region added with its text often
 * isn't read out); they wait while hovered or focused; and a notice that goes while it has focus hands
 * focus to the rows, not to the page.
 */
export function Toasts({ onUpdate, busy, onCancelBusy, undo, onUndone, nudge, onNudgeDone, message, onHold }: Props) {
  const stack = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  useLayoutEffect(() => {
    const el = stack.current
    if (!hadFocus.current || !el) return
    if (el.contains(document.activeElement)) return
    hadFocus.current = false
    onHold?.(false)
    if (document.activeElement === document.body || !document.activeElement) document.querySelector<HTMLElement>('.grid-scroll')?.focus({ preventScroll: true })
  })
  const said = [onUpdate && 'A new version of Sheetah is ready.', undo && !busy && undo.label, nudge?.label, message].filter(Boolean).join(' ')
  return (
    // A landmark of its own: what the notices say is on the page, not loose outside its regions.
    <section
      className="toast-stack"
      aria-label="Notices"
      ref={stack}
      onMouseEnter={() => onHold?.(true)}
      onMouseLeave={() => !stack.current?.contains(document.activeElement) && onHold?.(false)}
      onFocus={() => {
        hadFocus.current = true
        onHold?.(true)
      }}
      onBlur={(e) => {
        if (stack.current?.contains(e.relatedTarget as Node | null)) return
        hadFocus.current = false
        onHold?.(false)
        // Gone with the notice that had it (not tabbed or clicked away): to the rows.
        const from = e.target
        if (!e.relatedTarget)
          requestAnimationFrame(() => !from.isConnected && (document.activeElement === document.body || !document.activeElement) && document.querySelector<HTMLElement>('.grid-scroll')?.focus({ preventScroll: true }))
      }}
    >
      <p className="sr-only" role="status">
        {said}
      </p>
      {onUpdate && (
        <p className="toast">
          <Icon name="spark" /> <span className="toast-text">A new version of Sheetah is ready.</span>
          <button className="toast-action" onClick={onUpdate} title="Reloads the page. Open tables are cleared unless you keep them in this browser.">
            Reload
          </button>
        </p>
      )}
      {busy && <BusyToast key={busy.replace(/ \d+%$/, '')} label={busy} onCancel={onCancelBusy ?? null} />}
      {undo && !busy && (
        <p className="toast">
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
        <p className="toast">
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
        <p className="toast">
          <Icon name="spark" /> {message}
        </p>
      )}
    </section>
  )
}
