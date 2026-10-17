import { useRef, useState } from 'react'
import { LOCALE } from '../engine/sql'
import type { SavedView } from '../engine/views'
import { Icon } from './Icon'
import type { HistoryItem } from './Library'

/*
 * The library's Saved and History tabs: loaded when one is first opened (the Tables tab comes first).
 */

const nf = new Intl.NumberFormat(LOCALE)

interface SavedProps {
  views: SavedView[]
  tableNames: string[]
  onRun: (view: SavedView) => void
  onCopy: (view: SavedView) => void
  onDelete: (view: SavedView) => void
  /** Download every view as a file, and add the views from one. */
  onExport: () => void
  onImport: (file: File) => void
  /** The open table a view would run on in place of its own (next month's file), if any. */
  fitsOn?: (view: SavedView) => string | null
}

export function SavedPanel({ views, tableNames, onRun, onCopy, onDelete, onExport, onImport, fitsOn }: SavedProps) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <ul className="side-list">
      {!views.length && (
        <li className="muted small pad">
          Save a query with <b>Save view</b> to re-run it later, even on next month’s file.
        </li>
      )}
      {views.map((v) => {
        const missing = v.tables.some((t) => !tableNames.some((n) => n.toLowerCase() === t.toLowerCase()))
        const fits = missing ? fitsOn?.(v) : null
        return (
          <li key={v.id} className="view-item">
            <button className="side-view" onClick={() => onRun(v)} title={v.sql}>
              <span className="side-view-name">
                <Icon name="bookmark" size={14} /> {v.name}
              </span>
              <span className="side-type">
                {v.tables.length ? v.tables.join(', ') : 'no tables'}
                {fits ? ` · fits ${fits}` : missing ? ' · pick a table' : ''}
              </span>
            </button>
            <span className="view-actions">
              <button className="icon-btn" title="Copy SQL" aria-label={`Copy SQL of ${v.name}`} onClick={() => onCopy(v)}>
                <Icon name="copy" size={14} />
              </button>
              <button className="icon-btn" title="Delete" aria-label={`Delete ${v.name}`} onClick={() => onDelete(v)}>
                <Icon name="trash" size={14} />
              </button>
            </span>
          </li>
        )
      })}
      <li className="history-controls view-files">
        <span className="fine">Hand your views to someone, or move them to another browser: only names, SQL and the steps behind it travel, never your data.</span>
        <span className="view-file-actions">
          <button className="link-btn" onClick={onExport} disabled={!views.length}>
            Export views
          </button>
          <button className="link-btn" onClick={() => picker.current?.click()}>
            Import views…
          </button>
        </span>
        <input
          ref={picker}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Views file to import"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) onImport(file)
          }}
        />
      </li>
    </ul>
  )
}

interface HistoryProps {
  history: HistoryItem[]
  remember: boolean
  onRemember: (on: boolean) => void
  /** Deletes everything stored in this browser (after the user confirms). */
  onWipe: () => Promise<void>
  onRun: (sql: string) => void
}

export function HistoryPanel({ history, remember, onRemember, onWipe, onRun }: HistoryProps) {
  const [confirmWipe, setConfirmWipe] = useState(false)
  return (
    <ul className="side-list">
      <li className="history-controls">
        <label className="inline">
          <input type="checkbox" checked={remember} onChange={(e) => onRemember(e.target.checked)} />
          Remember queries in this browser
        </label>
        {confirmWipe ? (
          <span className="wipe-confirm">
            Delete history, saved views and kept tables?{' '}
            <button
              className="link-btn danger-link"
              onClick={async () => {
                await onWipe()
                setConfirmWipe(false)
              }}
            >
              Yes, clear
            </button>{' '}
            <button className="link-btn" onClick={() => setConfirmWipe(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="link-btn" onClick={() => setConfirmWipe(true)}>
            Clear all local data
          </button>
        )}
      </li>
      {!history.length && <li className="muted small pad">{remember ? 'Queries you run will show up here.' : 'History is kept for this tab only.'}</li>}
      {history.map((h) => (
        <li key={h.at}>
          <button className="side-history" onClick={() => onRun(h.sql)}>
            <code>{h.sql}</code>
            <span className="side-type">
              {nf.format(h.rows)} rows · {new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
