import { Suspense, lazy, useId, useRef, useState, type CSSProperties } from 'react'
import { Icon } from './Icon'

// The menu's items arrive as it first opens (or as the pointer or focus comes to the button, so it's there by then).
const loadPanel = () => import('./ExportMenuPanel')
const ExportMenuPanel = lazy(loadPanel)

export type Format = 'xlsx' | 'csv' | 'parquet'

const GAP = 8
const EDGE = 12
const MENU_HEIGHT = 360 // up to five items + padding; only used to choose a side

/**
 * One "Export" button with a menu (WAI-ARIA menu button): arrow keys move, Enter picks, Escape
 * returns focus to the button. The menu is portalled to <body>, so the toolbar's scroll fade and
 * overflow can't clip it, and it opens upward when there's no room below.
 */
export function ExportMenu({
  disabled,
  onExport,
  onAnonymize,
  personal,
  textNumbers,
  onConvert,
  summary,
}: {
  disabled: boolean
  onExport: (format: Format, excelSafe: boolean, withRows?: boolean) => void
  /** The result summarizes other rows (a pivot): offer them as a second sheet. */
  summary?: boolean
  /** Offers "Anonymize first…" at the top of the menu. */
  onAnonymize?: () => void
  /** Columns that look personal (shown in the anonymize item's hint). */
  personal?: string[]
  /** Columns holding numbers (or dates) stored as text: offered for converting first. */
  textNumbers?: string[]
  onConvert?: () => void
}) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<CSSProperties | null>(null)

  const openedAt = useRef(0)
  const open = () => {
    if (disabled) return
    // On a phone the toolbar scrolls sideways: bring the button fully into view, then place the menu.
    button.current!.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    openedAt.current = performance.now()
    const r = button.current!.getBoundingClientRect()
    const right = Math.max(EDGE, window.innerWidth - r.right)
    const below = window.innerHeight - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    setAt(
      below >= MENU_HEIGHT || below >= above
        ? { top: r.bottom + GAP, right, maxHeight: below }
        : { bottom: window.innerHeight - r.top + GAP, right, maxHeight: above, transformOrigin: 'bottom right' },
    )
  }
  const close = (refocus: boolean) => {
    setAt(null)
    if (refocus) button.current?.focus()
  }
  return (
    <>
      {/* aria-disabled (not disabled) while an export runs, so keyboard focus stays on the button. */}
      <button
        ref={button}
        className="btn btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-controls={at ? `${id}-menu` : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => (at ? close(false) : open())}
        onPointerEnter={() => void loadPanel()}
        onFocus={() => void loadPanel()}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !at) {
            e.preventDefault()
            open()
          }
        }}
      >
        <Icon name="download" /> Export
      </button>
      {at && (
        <Suspense fallback={null}>
          <ExportMenuPanel
            id={id}
            at={at}
            button={button}
            openedAt={openedAt}
            close={close}
            onExport={onExport}
            onAnonymize={onAnonymize}
            personal={personal}
            textNumbers={textNumbers}
            onConvert={onConvert}
            summary={summary}
          />
        </Suspense>
      )}
    </>
  )
}
