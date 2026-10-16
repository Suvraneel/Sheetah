import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Filter } from '../engine/compose'
import { profileColumn, type ColumnInfo, type ColumnProfile, type ResultSet } from '../engine/result'
import { Icon } from './Icon'
import { Chart } from './Chart'
import { histogram, type Point } from '../engine/chart'

interface Props {
  result: ResultSet
  column: ColumnInfo
  anchor: DOMRect
  sortDir?: 'asc' | 'desc'
  onSort: (dir: 'asc' | 'desc' | null) => void
  onFilter: (f: Filter) => void
  onInsert: () => void
  onClose: () => void
}

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export function ColumnMenu({ result, column, anchor, sortDir, onSort, onFilter, onInsert, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [profile, setProfile] = useState<ColumnProfile | null>(null)
  const [hist, setHist] = useState<Point[] | null>(null)
  const [op, setOp] = useState<Filter['op']>(column.numeric ? 'gt' : 'contains')
  const [value, setValue] = useState('')
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 8 })

  useEffect(() => {
    let live = true
    profileColumn(result, column).then((p) => live && setProfile(p)).catch(() => {})
    if (column.numeric && result.table) histogram(result.table, column).then((h) => live && setHist(h)).catch(() => {})
    return () => {
      live = false
    }
  }, [result, column])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const w = el.offsetWidth
      const h = Math.min(el.scrollHeight, window.innerHeight - 24) // natural height, not the capped one
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - w - 12))
      const top = Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - h - 12))
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }))
    }
    place()
    // The profile and histogram render after opening and make the menu taller: re-place as they do.
    const ro = new ResizeObserver(place)
    Array.from(el.children).forEach((c) => ro.observe(c))
    return () => ro.disconnect()
  }, [anchor, profile, hist])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // Defer: the mousedown that opened this menu is still bubbling to window.
    const t = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const needsValue = op !== 'is_null' && op !== 'not_null'
  const apply = (e: React.FormEvent) => {
    e.preventDefault()
    if (needsValue && !value.trim()) return
    onFilter({ column: column.name, op, value: needsValue ? value.trim() : undefined, numeric: column.numeric })
  }
  const maxTop = profile?.top[0]?.count ?? 1

  return (
    <div className="popover colmenu" ref={ref} style={{ left: pos.left, top: pos.top, maxHeight: window.innerHeight - pos.top - 12 }} role="dialog" aria-label={`Column ${column.name}`}>
      <div className="colmenu-head">
        <strong>{column.name}</strong>
        <span className="type-tag">{column.type.toLowerCase()}</span>
      </div>

      <div className="colmenu-actions">
        <button className={`seg${sortDir === 'asc' ? ' is-on' : ''}`} onClick={() => onSort(sortDir === 'asc' ? null : 'asc')}>
          <Icon name="sortAsc" /> {column.numeric ? 'Low → high' : 'A → Z'}
        </button>
        <button className={`seg${sortDir === 'desc' ? ' is-on' : ''}`} onClick={() => onSort(sortDir === 'desc' ? null : 'desc')}>
          <Icon name="sortDesc" /> {column.numeric ? 'High → low' : 'Z → A'}
        </button>
      </div>

      <form className="colmenu-filter" onSubmit={apply}>
        <select value={op} onChange={(e) => setOp(e.target.value as Filter['op'])} aria-label="Filter type">
          <option value="contains">contains</option>
          <option value="equals">equals</option>
          <option value="gt">greater than</option>
          <option value="lt">less than</option>
          <option value="is_null">is empty (NULL)</option>
          <option value="not_null">is not empty</option>
        </select>
        {needsValue && (
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" aria-label="Filter value" autoFocus />
        )}
        <button className="btn btn-primary btn-sm">
          <Icon name="filter" /> Filter
        </button>
      </form>

      <div className="colmenu-profile">
        {!profile ? (
          <p className="muted small">Profiling {result.rowCount.toLocaleString('en-US')} rows…</p>
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>Distinct</dt>
                <dd>≈{fmt.format(profile.distinct)}</dd>
              </div>
              <div>
                <dt>Empty</dt>
                <dd>{fmt.format(profile.nulls)}</dd>
              </div>
              {profile.avg !== null ? (
                <div>
                  <dt>Average</dt>
                  <dd>{fmt.format(profile.avg)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Min</dt>
                <dd title={profile.min ?? ''}>{profile.min ?? '—'}</dd>
              </div>
              <div>
                <dt>Max</dt>
                <dd title={profile.max ?? ''}>{profile.max ?? '—'}</dd>
              </div>
            </dl>
            {hist && hist.length > 1 && (
              <div className="colmenu-hist">
                <p className="label">Distribution</p>
                <Chart kind="hist" points={hist} label={`Distribution of ${column.name}`} valueName="rows" compact />
              </div>
            )}
            <p className="label">Most common · click to filter</p>
            <ul className="topvals">
              {profile.top.map((t) => (
                <li key={t.value ?? '∅'}>
                  <button
                    onClick={() =>
                      onFilter(
                        t.value === null
                          ? { column: column.name, op: 'is_null' }
                          : { column: column.name, op: 'equals', value: t.value, numeric: column.numeric },
                      )
                    }
                  >
                    <span className="bar" style={{ transform: `scaleX(${t.count / maxTop})` }} />
                    <span className="tv">{t.value ?? 'empty'}</span>
                    <span className="tc">{fmt.format(t.count)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <button className="link-btn" onClick={onInsert}>
        Insert “{column.name}” into the SQL editor
      </button>
    </div>
  )
}
