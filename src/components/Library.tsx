import { useState } from 'react'
import type { TableMeta } from '../engine/tables'
import { LOCALE, sqlName } from '../engine/sql'
import { friendlyType } from '../grid/format'
import { Icon } from './Icon'

/*
 * The library's three tabs (the sidebar on desktop, a bottom sheet on phones): the open tables here;
 * saved views and the history of queries run in SidePanels (loaded when first opened).
 */

const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 })

export interface HistoryItem {
  sql: string
  at: number
  rows: number
}

interface TablesProps {
  tables: TableMeta[]
  /** The table the query on screen reads (lower case), if it reads one. */
  openName: string | null
  onOpen: (name: string) => void
  onInsert: (text: string) => void
  onCompare: () => void
  onStack: () => void
  /** "Keep my tables in this browser", where the browser can. */
  keep?: { on: boolean; onChange: (on: boolean) => void }
  /** Column lists shown or hidden by hand (otherwise: the open table's, or all of a few); kept across tabs. */
  colsOpen: Record<string, boolean>
  onToggleCols: (table: string, open: boolean) => void
  /** The open table's columns as its steps leave them (a date column converted): said as they now are. */
  converted?: Record<string, string>
}

/** Columns listed for a table before "Show all": a 5,000-column file listed whole made the sidebar crawl. */
const COLS_SHOWN = 200

export function TablesPanel({ tables, openName, onOpen, onInsert, onCompare, onStack, keep, colsOpen, onToggleCols, converted }: TablesProps) {
  const [allCols, setAllCols] = useState<Set<string>>(() => new Set())
  return (
    <ul className="side-list">
      {tables.map((t) => {
        const open = colsOpen[t.name] ?? (tables.length <= 3 || t.name.toLowerCase() === openName)
        return (
          <li key={t.name}>
            <span className="side-row">
              <button className="side-table" aria-current={t.name.toLowerCase() === openName || undefined} onClick={() => onOpen(t.name)}>
                <Icon name={t.kind === 'view' ? 'layers' : 'table'} />
                <span className="side-name">{t.name}</span>
                <span className="side-count">{t.rows === null ? 'view' : compact.format(t.rows)}</span>
              </button>
              <button
                className="side-toggle"
                aria-expanded={open}
                aria-label={`Columns of ${t.name}`}
                title={open ? 'Hide columns' : 'Show columns'}
                onClick={() => onToggleCols(t.name, !open)}
              >
                <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
              </button>
            </span>
            {open && (
              <ul className="side-cols">
                {/* A wide table's first 200, then the rest on request: thousands of rows here would slow every scroll. */}
                {(t.columns.length > COLS_SHOWN && !allCols.has(t.name) ? t.columns.slice(0, COLS_SHOWN) : t.columns).map((c) => (
                  <li key={c.name}>
                    <button onClick={() => onInsert(sqlName(c.name))} title="Insert into SQL">
                      <span>{c.name}</span>
                      {/* As a spreadsheet would say it; the database's own type on hover (and in the column menu). */}
                      <span className="side-type" title={c.type.toLowerCase()}>
                        {t.name.toLowerCase() === openName && converted?.[c.name] && friendlyType(converted[c.name]) !== friendlyType(c.type)
                          ? `${friendlyType(converted[c.name])} (converted)`
                          : friendlyType(c.type)}
                      </span>
                    </button>
                  </li>
                ))}
                {t.columns.length > COLS_SHOWN && !allCols.has(t.name) && (
                  <li>
                    <button className="link-btn" onClick={() => setAllCols((m) => new Set(m).add(t.name))}>
                      Show all {t.columns.length.toLocaleString(LOCALE)} columns
                    </button>
                  </li>
                )}
              </ul>
            )}
          </li>
        )
      })}
      {tables.length >= 2 && (
        <li className="side-tools">
          <button className="btn btn-ghost btn-sm" onClick={onCompare}>
            <Icon name="compare" /> Compare two tables
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onStack}>
            <Icon name="layers" /> Stack tables into one
          </button>
        </li>
      )}
      {keep && (
        <li className="history-controls side-keep">
          <label className="inline">
            <input type="checkbox" checked={keep.on} onChange={(e) => keep.onChange(e.target.checked)} />
            Keep my tables in this browser
          </label>
          <span className="fine">Stored on this device only, unencrypted. Turn off to delete them.</span>
        </li>
      )}
    </ul>
  )
}
