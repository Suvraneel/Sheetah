import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

type Format = 'csv' | 'parquet'

const ITEMS: { label: string; hint: string; format: Format; excelSafe: boolean }[] = [
  { label: 'CSV', hint: 'Safe for Excel: cells starting with = + - @ won’t run', format: 'csv', excelSafe: true },
  { label: 'CSV, exact values', hint: 'Every value as stored, for code and databases', format: 'csv', excelSafe: false },
  { label: 'Parquet', hint: 'Smaller file that keeps column types', format: 'parquet', excelSafe: false },
]
const GAP = 8
const EDGE = 12
const MENU_HEIGHT = 230 // three items + padding; only used to choose a side

/**
 * One "Export" button with a menu (WAI-ARIA menu button): arrow keys move, Enter picks, Escape
 * returns focus to the button. The menu is portalled to <body>, so the toolbar's scroll fade and
 * overflow can't clip it, and it opens upward when there's no room below.
 */
export function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (format: Format, excelSafe: boolean) => void }) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<CSSProperties | null>(null)

  const open = () => {
    if (disabled) return
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
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])

  useEffect(() => {
    if (!at) return
    items()[0]?.focus()
    const inside = (t: EventTarget | null) => !!t && (menu.current?.contains(t as Node) || button.current?.contains(t as Node))
    const away = (e: Event) => {
      if (!inside(e.target)) close(false)
    }
    const scrolled = (e: Event) => {
      if (!inside(e.target)) close(false)
    }
    const resized = () => close(false)
    document.addEventListener('pointerdown', away)
    window.addEventListener('resize', resized)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('resize', resized)
      window.removeEventListener('scroll', scrolled, true)
    }
  }, [at])

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      list[(n + list.length) % list.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') close(false)
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
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !at) {
            e.preventDefault()
            open()
          }
        }}
      >
        <Icon name="download" /> Export
      </button>
      {at &&
        createPortal(
          <div ref={menu} id={`${id}-menu`} className="menu-pop" role="menu" aria-label="Export this result" tabIndex={-1} style={at} onKeyDown={onMenuKey}>
            {ITEMS.map((it, i) => (
              <button
                key={it.label}
                role="menuitem"
                tabIndex={-1}
                aria-labelledby={`${id}-label-${i}`}
                aria-describedby={`${id}-hint-${i}`}
                onClick={() => {
                  close(true)
                  onExport(it.format, it.excelSafe)
                }}
              >
                <span className="menu-label" id={`${id}-label-${i}`}>
                  {it.label}
                </span>
                <span className="menu-hint" id={`${id}-hint-${i}`}>
                  {it.hint}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
