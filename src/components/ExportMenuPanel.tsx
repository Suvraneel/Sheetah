import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Format } from './ExportMenu'
import { Icon } from './Icon'

const ITEMS: { label: string; hint: string; format: Format; excelSafe: boolean; withRows?: boolean }[] = [
  { label: 'Excel (.xlsx)', hint: 'Real numbers and dates, a frozen header with filters', format: 'xlsx', excelSafe: true },
  { label: 'Excel, with the rows behind it', hint: 'The summary on one sheet, the rows it was made from on the next', format: 'xlsx', excelSafe: true, withRows: true },
  { label: 'CSV', hint: 'Safe for Excel: cells starting with = + - @ won’t run', format: 'csv', excelSafe: true },
  { label: 'CSV, exact values', hint: 'Every value as stored, for code and databases', format: 'csv', excelSafe: false },
  { label: 'Parquet', hint: 'Smaller file that keeps column types', format: 'parquet', excelSafe: false },
]
/** Excel files are zipped with CompressionStream (Safari 16.4+, Chrome 103+, Firefox 113+). */
const canZip = typeof CompressionStream !== 'undefined'

/**
 * The Export menu's items (loaded as it first opens, or as the pointer or focus comes to the button): arrow
 * keys move, Enter picks, Escape returns focus to the button. Portalled to <body>, so the toolbar's scroll
 * fade and overflow can't clip it.
 */
export default function ExportMenuPanel({
  id,
  at,
  button,
  openedAt,
  close,
  onExport,
  onAnonymize,
  personal,
  textNumbers,
  onConvert,
  summary,
}: {
  id: string
  at: CSSProperties
  button: RefObject<HTMLButtonElement | null>
  openedAt: RefObject<number>
  close: (refocus: boolean) => void
  onExport: (format: Format, excelSafe: boolean, withRows?: boolean) => void
  onAnonymize?: () => void
  personal?: string[]
  textNumbers?: string[]
  onConvert?: () => void
  summary?: boolean
}) {
  const menu = useRef<HTMLDivElement>(null)
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])

  useEffect(() => {
    items()[0]?.focus()
    const inside = (t: EventTarget | null) => !!t && (menu.current?.contains(t as Node) || button.current?.contains(t as Node))
    const away = (e: Event) => {
      if (!inside(e.target)) close(false)
    }
    const scrolled = (e: Event) => {
      // Not the scroll that brought the button into view as it opened.
      if (!inside(e.target) && performance.now() - openedAt.current > 400) close(false)
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
    // Once per opening (where it opened): closing and the button stay what they were.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return createPortal(
          <div ref={menu} id={`${id}-menu`} className="menu-pop" role="menu" aria-label="Export this result" tabIndex={-1} style={at} onKeyDown={onMenuKey}>
            {onAnonymize && (
              <button
                role="menuitem"
                tabIndex={-1}
                className="menu-anon"
                aria-labelledby={`${id}-label-anon`}
                aria-describedby={`${id}-hint-anon`}
                onClick={() => {
                  close(false)
                  onAnonymize()
                }}
              >
                <span className="menu-label" id={`${id}-label-anon`}>
                  <Icon name="shield" size={14} /> Anonymize first…
                </span>
                <span className="menu-hint" id={`${id}-hint-anon`}>
                  {personal?.length ? `Personal data found: ${personal.slice(0, 3).join(', ')}${personal.length > 3 ? '…' : ''}` : 'Mask emails, phone numbers, IDs and names before sharing'}
                </span>
              </button>
            )}
            {onConvert && !!textNumbers?.length && (
              <button
                role="menuitem"
                tabIndex={-1}
                className="menu-anon"
                aria-labelledby={`${id}-label-convert`}
                aria-describedby={`${id}-hint-convert`}
                onClick={() => {
                  close(false)
                  onConvert()
                }}
              >
                <span className="menu-label" id={`${id}-label-convert`}>
                  <Icon name="spark" size={14} /> Convert to numbers first
                </span>
                <span className="menu-hint" id={`${id}-hint-convert`}>
                  Stored as text: {textNumbers.slice(0, 3).join(', ')}
                  {textNumbers.length > 3 ? ` and ${textNumbers.length - 3} more` : ''}. Excel can’t add them up as they are.
                </span>
              </button>
            )}
            {ITEMS.filter((it) => (canZip || it.format !== 'xlsx') && (!it.withRows || summary)).map((it, i) => (
              <button
                key={it.label}
                role="menuitem"
                tabIndex={-1}
                aria-labelledby={`${id}-label-${i}`}
                aria-describedby={`${id}-hint-${i}`}
                onClick={() => {
                  close(true)
                  onExport(it.format, it.excelSafe, it.withRows)
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
        )
}
