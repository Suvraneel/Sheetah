import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { makeFormatter } from '../grid/format'
import { parseNumber, type Filter, type FilterOp } from '../engine/compose'
import type { ColumnInfo, ResultSet } from '../engine/result'
import { cleaningFor, distinctValues, profileColumn, splitParts, topValues, type ColumnProfile } from '../engine/scan'
import { lookAlikes, type Alike } from '../engine/alike'
import { isIdLike, LOCALE, quoteLiteral, sqlName } from '../engine/sql'
import { describeClean, isConversion, visibleSpaces, type Clean } from '../engine/clean'
import { isTextColumn, type CleanSuggestion } from '../engine/clean-scan'
import { Icon } from './Icon'
import { Chart } from './Chart'
import { histogram, isTemporal, type Point } from '../engine/chart'

interface Props {
  result: ResultSet
  column: ColumnInfo
  anchor: DOMRect
  sortDir?: 'asc' | 'desc'
  onSort: (dir: 'asc' | 'desc' | null) => void
  onFilter: (f: Filter) => void
  /** Values already picked for this column (shown checked; clicking one again un-picks it). */
  picked?: (string | null)[]
  /** SQL for the rows without this column's own pick, so the list still offers the other values. */
  valuesSql?: string | null
  onUnpick?: (value: string | null) => void
  /** Show only rows whose value repeats, or keep the first row of each value. */
  onDedupe?: (mode: 'show' | 'remove') => void
  /** Convert or tidy this column in place (number stored as text, dates, spaces, case). */
  onClean?: (c: Clean) => void
  /** Several clean-ups as one step (merging every look-alike value at once). */
  onCleans?: (cs: Clean[]) => void
  /** How this column is already cleaned, if it is (offered for undoing). */
  cleaned?: Clean[]
  onUnclean?: () => void
  onInsert: () => void
  /** Look up values from another table, matched by this column. */
  onLookup?: () => void
  /** Leave this column out of the result. */
  onHide?: () => void
  /** Add formula columns made from this one (date parts, split pieces). */
  onAddColumns?: (cols: { name: string; expr: string }[]) => void
  /** A new query: how many rows have each value of this column. */
  onCountBy?: () => void
  /** Turn this column (and others like it) into rows. */
  onUnpivot?: () => void
  /** Group the rows into categories by words in this column (or, if it's such a column, edit its rules). */
  onCategorize?: () => void
  categorized?: boolean
  onClose: () => void
}

const fmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })

/** Filters that make sense for each kind of column, in the order people reach for them. */
const OPS: Record<'number' | 'time' | 'text', { op: FilterOp; label: string }[]> = {
  number: [
    { op: 'gt', label: 'greater than' },
    { op: 'gte', label: 'at least' },
    { op: 'lt', label: 'less than' },
    { op: 'lte', label: 'at most' },
    { op: 'equals', label: 'equals' },
    { op: 'not_equals', label: 'is not' },
    { op: 'between', label: 'between' },
    { op: 'is_null', label: 'is empty' },
    { op: 'not_null', label: 'is not empty' },
  ],
  time: [
    { op: 'gte', label: 'on or after' },
    { op: 'lt', label: 'before' },
    { op: 'between', label: 'between' },
    { op: 'equals', label: 'is exactly' },
    { op: 'is_null', label: 'is empty' },
    { op: 'not_null', label: 'is not empty' },
  ],
  text: [
    { op: 'contains', label: 'contains' },
    { op: 'not_contains', label: 'doesn’t contain' },
    { op: 'starts_with', label: 'starts with' },
    { op: 'equals', label: 'is' },
    { op: 'not_equals', label: 'is not' },
    { op: 'is_null', label: 'is empty' },
    { op: 'not_null', label: 'is not empty' },
  ],
}

export function ColumnMenu({ result, column, anchor, sortDir, onSort, onFilter, picked = [], valuesSql, onUnpick, onDedupe, onClean, onCleans, cleaned, onUnclean, onInsert, onLookup, onHide, onCountBy, onUnpivot, onCategorize, categorized, onAddColumns, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [profile, setProfile] = useState<ColumnProfile | null>(null)
  const [hist, setHist] = useState<Point[] | null>(null)
  const [delim, setDelim] = useState(',')
  const [splitNote, setSplitNote] = useState<string | null>(null)
  const [swapFrom, setSwapFrom] = useState('')
  const [swapTo, setSwapTo] = useState('')
  const taken = new Set(result.columns.map((c) => c.name.toLowerCase()))
  const fresh = (name: string) => {
    let n = name
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name}_${i}`
    return n
  }
  const col = sqlName(column.name)
  const datePart = (label: string, expr: string) => onAddColumns?.([{ name: fresh(`${column.name}_${label}`), expr }])
  const split = async () => {
    if (!delim) return
    const n = await splitParts(result, column, delim).catch(() => 0)
    if (n < 2) return setSplitNote(`No value has “${delim}” in it.`)
    setSplitNote(null)
    onAddColumns?.(
      Array.from({ length: n }, (_, i) => ({ name: fresh(`${column.name}_${i + 1}`), expr: `nullif(trim(split_part(${col}::VARCHAR, ${quoteLiteral(delim)}, ${i + 1})), '')` })),
    )
  }
  // Exact, unlike the distinct estimate: the most common value occurs more than once.
  const repeats = !!profile?.top.some((t) => t.value !== null && t.count > 1)
  // Exact for most results; for huge ones, exact anyway when every value fits in the top list.
  const exactDistinct = !profile ? null : profile.distinctExact ? profile.distinct : profile.top.length < 8 ? profile.top.filter((t) => t.value !== null).length : null
  const show = useMemo(() => makeFormatter(column, [profile?.min, profile?.max]), [column, profile])
  const kind = column.numeric ? 'number' : isTemporal(column) ? 'time' : 'text'
  const [op, setOp] = useState<FilterOp>(OPS[kind][0].op)
  const [value, setValue] = useState('')
  const [value2, setValue2] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [choices, setChoices] = useState<{ value: string | null; count: number }[] | null>(null)
  const [cleanings, setCleanings] = useState<CleanSuggestion[] | null>(null)
  const [alikes, setAlikes] = useState<Alike[]>([])
  const text = isTextColumn(column.type)
  // A text column that really holds numbers or dates: offered as the first thing to fix.
  const convert = cleanings?.find((s) => isConversion(s.clean))
  // Words, not codes or numbers: where case and splitting make sense.
  const wordy = text && !convert && !isIdLike(column.name)
  // Empty cells among filled ones (NULL, or blank text): what "fill down" is for.
  const hasEmpty = !!profile && profile.nonNull > 0 && (profile.nulls > 0 || !!cleanings?.some((s) => s.clean.kind === 'blank'))
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 8 })

  useEffect(() => {
    let live = true
    profileColumn(result, column)
      .then((p) => live && setProfile(p))
      .catch(() => live && setFailed(true))
    if (column.numeric && result.table) histogram(result.table, column).then((h) => live && setHist(h)).catch(() => {})
    if (valuesSql) topValues(valuesSql, column.name).then((v) => live && setChoices(v)).catch(() => {})
    if (onClean && isTextColumn(column.type)) cleaningFor(result, column).then((c) => live && setCleanings(c)).catch(() => {})
    if (onClean && isTextColumn(column.type)) distinctValues(result, column).then((v) => live && setAlikes(lookAlikes(v))).catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClean only gates the request
  }, [result, column, valuesSql])

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
  }, [anchor, profile, hist, cleanings])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    let tabbing = false
    const onKey = (e: KeyboardEvent) => {
      tabbing = e.key === 'Tab'
      if (e.key === 'Escape') onClose()
    }
    // Tabbing out of the menu closes it, so keyboard focus never wanders behind an open popover.
    // (Only for Tab: the click that opened the menu also moves focus, and must not close it.)
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (tabbing && next && ref.current && !ref.current.contains(next)) onClose()
    }
    const el = ref.current
    // Defer: the mousedown that opened this menu is still bubbling to window.
    const t = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    window.addEventListener('keydown', onKey)
    el?.addEventListener('focusout', onFocusOut)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      el?.removeEventListener('focusout', onFocusOut)
    }
  }, [onClose])

  const needsValue = op !== 'is_null' && op !== 'not_null'
  const between = op === 'between'
  const apply = (e: React.FormEvent) => {
    e.preventDefault()
    if (needsValue && !value.trim()) return
    if (between && !value2.trim()) return
    // A percentage column holds fractions: "12" or "12%" typed there means 0.12.
    const typed = (v: string) => (column.percent ? v.trim().replace(/\s*%$/, '') : v)
    const fraction = (v: string) => String(Number(parseNumber(typed(v))) / 100)
    if (needsValue && column.numeric) {
      const a = parseNumber(typed(value))
      const b = between ? parseNumber(typed(value2)) : '0'
      if (a === null || b === null) {
        setInvalid(column.percent ? 'Enter a percentage, like 12 or 12.5%' : 'Enter a number, like 5000 or 1,250.50')
        return
      }
    }
    onFilter({
      column: column.name,
      op,
      value: needsValue ? (column.percent ? fraction(value) : value.trim()) : undefined,
      value2: between ? (column.percent ? fraction(value2) : value2.trim()) : undefined,
      numeric: column.numeric,
      type: column.type,
      percent: column.percent || undefined,
    })
  }
  const placeholder = column.percent ? 'e.g. 12%' : kind === 'number' ? 'e.g. 5000' : kind === 'time' ? 'e.g. 2024-01-31' : 'value'
  const top = (valuesSql ? choices : profile?.top) ?? []
  const maxTop = Math.max(1, ...top.map((t) => t.count))

  return (
    <div className="popover colmenu" ref={ref} style={{ left: pos.left, top: pos.top, maxHeight: window.innerHeight - pos.top - 12 }} role="dialog" aria-label={`Column ${column.name}`}>
      <div className="colmenu-head">
        <strong>{column.name}</strong>
        <span className="type-tag">{column.type.toLowerCase()}</span>
        <button type="button" className="icon-btn colmenu-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {onClean && convert && !cleaned?.some(isConversion) && (
        <div className="colmenu-convert" role="note">
          <span>
            <b>{convert.clean.kind === 'date' ? 'Dates stored as text.' : 'Numbers stored as text.'}</b> Sorting follows the text (
            {convert.clean.kind === 'date' ? '01/02 before 31/01' : '10 before 9'}) and sums don’t work until it’s converted.
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => onClean(convert.clean)}>
            <Icon name="spark" size={13} /> {convert.label}
          </button>
          {convert.note && <span className="fine">{convert.note}.</span>}
        </div>
      )}

      <div className="colmenu-actions">
        <button className={`seg${sortDir === 'asc' ? ' is-on' : ''}`} onClick={() => onSort(sortDir === 'asc' ? null : 'asc')}>
          <Icon name="sortAsc" /> {column.numeric ? 'Low → high' : kind === 'time' ? 'Oldest first' : 'A → Z'}
        </button>
        <button className={`seg${sortDir === 'desc' ? ' is-on' : ''}`} onClick={() => onSort(sortDir === 'desc' ? null : 'desc')}>
          <Icon name="sortDesc" /> {column.numeric ? 'High → low' : kind === 'time' ? 'Newest first' : 'Z → A'}
        </button>
      </div>

      <form className={`colmenu-filter${between ? ' is-between' : ''}`} onSubmit={apply} noValidate>
        <select
          value={op}
          onChange={(e) => {
            setOp(e.target.value as FilterOp)
            setInvalid(null)
          }}
          aria-label="Filter type"
        >
          {OPS[kind].map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
        {needsValue && (
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setInvalid(null)
            }}
            placeholder={placeholder}
            aria-label={between ? 'From' : 'Filter value'}
            aria-invalid={!!invalid || undefined}
            aria-describedby={invalid ? 'filter-error' : undefined}
            inputMode={kind === 'number' ? 'decimal' : undefined}
            autoFocus
          />
        )}
        {between && (
          <input
            value={value2}
            onChange={(e) => {
              setValue2(e.target.value)
              setInvalid(null)
            }}
            placeholder={kind === 'number' ? 'e.g. 9000' : 'e.g. 2024-12-31'}
            aria-label="To"
            aria-invalid={!!invalid || undefined}
            inputMode={kind === 'number' ? 'decimal' : undefined}
          />
        )}
        <button className="btn btn-primary btn-sm">
          <Icon name="filter" /> Filter
        </button>
      </form>
      {invalid && (
        <p className="colmenu-error" id="filter-error" role="alert">
          {invalid}
        </p>
      )}

      <div className="colmenu-profile">
        {failed ? (
          <p className="muted small">Couldn’t profile this column.</p>
        ) : !profile ? (
          <p className="muted small">Profiling {result.rowCount.toLocaleString(LOCALE)} rows…</p>
        ) : (
          <>
            <p className="label">
              {picked.length
                ? 'Showing the checked values · click to add or remove'
                : top.length > 1 && top.every((t) => t.count === 1)
                  ? 'Every value here is different · click to filter'
                  : 'Most common · click to filter'}
            </p>
            <ul className="topvals">
              {top.map((t) => {
                const on = picked.includes(t.value)
                return (
                <li key={t.value ?? '∅'}>
                  <button
                    aria-pressed={picked.length ? on : undefined}
                    className={on ? 'is-picked' : undefined}
                    onClick={() =>
                      on
                        ? onUnpick?.(t.value)
                        : onFilter({ column: column.name, op: 'equals', value: t.value ?? undefined, numeric: column.numeric, type: column.type, exact: true, percent: column.percent || undefined })
                    }
                  >
                    <span className="bar" style={{ transform: `scaleX(${t.count / maxTop})` }} />
                    {picked.length > 0 && <span className="tcheck" aria-hidden>{on ? '✓' : ''}</span>}
                    <span className="tv">{t.value === null ? 'empty' : t.value === '' ? '(blank)' : kind === 'text' ? t.value : show(t.value)}</span>
                    <span className="tc">{fmt.format(t.count)}</span>
                  </button>
                </li>
                )
              })}
            </ul>
            <dl className="facts">
              <div>
                <dt>Distinct</dt>
                <dd>{exactDistinct !== null ? fmt.format(exactDistinct) : `≈${fmt.format(profile.distinct)}`}</dd>
              </div>
              <div>
                <dt>Empty</dt>
                <dd>{fmt.format(profile.nulls)}</dd>
              </div>
              {/* A sum of rates means nothing. */}
              {profile.sum !== null && !column.percent ? (
                <div>
                  <dt>Sum</dt>
                  <dd title={fmt.format(profile.sum)}>{fmt.format(profile.sum)}</dd>
                </div>
              ) : null}
              {profile.avg !== null ? (
                <div>
                  <dt>Average</dt>
                  <dd>{column.percent ? show(String(profile.avg)) : fmt.format(profile.avg)}</dd>
                </div>
              ) : null}
              {/* Min and max of text (alphabetical) tell people nothing; of numbers and dates they do. */}
              {kind !== 'text' && (
                <div>
                  <dt>{kind === 'time' ? 'Earliest' : 'Min'}</dt>
                  <dd title={profile.min ?? ''}>{profile.min === null ? '—' : show(profile.min)}</dd>
                </div>
              )}
              {kind !== 'text' && (
                <div>
                  <dt>{kind === 'time' ? 'Latest' : 'Max'}</dt>
                  <dd title={profile.max ?? ''}>{profile.max === null ? '—' : show(profile.max)}</dd>
                </div>
              )}
            </dl>
            {/* Repeats are news in a column that's mostly unique (IDs, emails), not in a category column. */}
            {onDedupe && repeats && (exactDistinct ?? profile.distinct) >= profile.nonNull * 0.5 && (
              <div className="colmenu-dupes">
                <span>
                  {exactDistinct !== null ? (
                    <>
                      <b>{fmt.format(profile.nonNull - exactDistinct)}</b> {profile.nonNull - exactDistinct === 1 ? 'row repeats' : 'rows repeat'} a value
                    </>
                  ) : profile.nonNull > profile.distinct ? (
                    <>
                      <b>{fmt.format(profile.nonNull - profile.distinct)}</b> rows repeat a value{profile.distinct > 1000 ? ' (about)' : ''}
                    </>
                  ) : (
                    'Some rows repeat a value'
                  )}
                </span>
                <span className="colmenu-dupes-actions">
                  <button className="link-btn" onClick={() => onDedupe('show')}>
                    Show duplicates
                  </button>
                  <button className="link-btn" onClick={() => onDedupe('remove')}>
                    Keep first of each
                  </button>
                </span>
              </div>
            )}
            {(!!cleaned?.length || (onClean && (text || hasEmpty || !!cleanings?.some((s) => s !== convert)))) && (
              <div className="colmenu-clean" role="group" aria-label="Clean up this column">
                {!!cleaned?.length && (
                  <span className="colmenu-clean-row">
                    <span>Cleaned: {cleaned.map((c) => describeClean(c).slice(c.column.length + 1)).join(', then ')}</span>
                    <button className="link-btn" onClick={onUnclean}>
                      Undo
                    </button>
                  </span>
                )}
                {onClean &&
                  cleanings
                    ?.filter((s) => s !== convert)
                    .map((s) => (
                    <span className="colmenu-clean-row" key={`${s.clean.kind}${s.clean.format ?? ''}`}>
                      <button className="link-btn" onClick={() => onClean(s.clean)}>
                        <Icon name="spark" size={13} /> {s.label}
                      </button>
                      {s.note && <span className="fine">{s.note}</span>}
                    </span>
                  ))}
                {onClean && hasEmpty && !cleaned?.some((c) => c.kind === 'filldown') && (
                  <span className="colmenu-clean-row">
                    <button className="link-btn" onClick={() => onClean({ column: column.name, kind: 'filldown' })}>
                      <Icon name="spark" size={13} /> Fill empty cells with the value above
                    </button>
                    <span className="fine">For reports that name a group only on its first row</span>
                  </span>
                )}
                {onClean && wordy && (
                  <span className="colmenu-clean-row colmenu-case">
                    <span className="fine">Case:</span>
                    {(['upper', 'lower', 'title'] as const).map((k) => (
                      <button key={k} className="link-btn" aria-pressed={cleaned?.some((c) => c.kind === k) || undefined} onClick={() => onClean({ column: column.name, kind: k })}>
                        {k === 'upper' ? 'UPPER' : k === 'lower' ? 'lower' : 'Title'}
                      </button>
                    ))}
                  </span>
                )}
                {onClean && wordy && alikes.length > 0 && (
                  <span className="colmenu-clean-row colmenu-alike" role="group" aria-label="Values that look alike">
                    <span className="fine">Look alike:</span>
                    {alikes.map((a) => (
                      <button
                        key={a.from}
                        className="link-btn"
                        onClick={() => onClean({ column: column.name, kind: 'replace', from: a.from, to: a.to })}
                        title={`Replace “${visibleSpaces(a.from)}” (${fmt.format(a.fromRows)} ${a.fromRows === 1 ? 'row' : 'rows'}) with “${visibleSpaces(a.to)}” (${fmt.format(a.toRows)})`}
                      >
                        {visibleSpaces(a.from)} → {visibleSpaces(a.to)}
                      </button>
                    ))}
                    {onCleans && alikes.length > 1 && (
                      <button className="link-btn colmenu-alike-all" onClick={() => onCleans(alikes.map((a) => ({ column: column.name, kind: 'replace', from: a.from, to: a.to })))}>
                        Merge all {alikes.length}
                      </button>
                    )}
                  </span>
                )}
                {onClean && text && (
                  <form
                    className="colmenu-replace"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (swapFrom.trim()) onClean({ column: column.name, kind: 'replace', from: swapFrom, to: swapTo.trim() ? swapTo : null })
                    }}
                  >
                    <label className="fine" htmlFor="swap-from">
                      Replace
                    </label>
                    <input
                      id="swap-from"
                      className="colmenu-delim colmenu-swap"
                      list="swap-values"
                      value={swapFrom}
                      onChange={(e) => setSwapFrom(e.target.value)}
                      placeholder="value"
                      aria-label="Value to replace"
                      title="Matched ignoring upper / lower case and spaces around it"
                    />
                    <datalist id="swap-values">
                      {top.filter((t) => t.value !== null && t.value !== '').map((t) => (
                        <option key={t.value} value={t.value!} />
                      ))}
                    </datalist>
                    <label className="fine colmenu-replace-with" htmlFor="swap-to">
                      with
                    </label>
                    <input id="swap-to" className="colmenu-delim colmenu-swap" value={swapTo} onChange={(e) => setSwapTo(e.target.value)} placeholder="empty" aria-label="Replace with" />
                    <button className="link-btn" disabled={!swapFrom.trim()}>
                      Replace
                    </button>
                  </form>
                )}
              </div>
            )}
            {onAddColumns && (kind === 'time' || wordy) && (
              <div className="colmenu-derive" role="group" aria-label="Add columns from this one">
                {kind === 'time' ? (
                  <span className="colmenu-clean-row colmenu-case">
                    <span className="fine">Add a column:</span>
                    <button className="link-btn" onClick={() => datePart('year', `year(${col})`)}>
                      Year
                    </button>
                    <button className="link-btn" onClick={() => datePart('month', `strftime(${col}, '%Y-%m')`)}>
                      Month
                    </button>
                    <button className="link-btn" onClick={() => datePart('weekday', `dayname(${col})`)}>
                      Weekday
                    </button>
                    {/^TIMESTAMP/i.test(column.type) && (
                      <button className="link-btn" onClick={() => datePart('hour', `hour(${col})`)}>
                        Hour
                      </button>
                    )}
                  </span>
                ) : (
                  <form
                    className="colmenu-clean-row colmenu-split"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void split()
                    }}
                  >
                    <label className="fine" htmlFor="split-delim">
                      Split into columns at
                    </label>
                    <input id="split-delim" className="colmenu-delim" value={delim} maxLength={5} onChange={(e) => setDelim(e.target.value)} aria-describedby={splitNote ? 'split-note' : undefined} />
                    <button className="link-btn">Split</button>
                    {splitNote && (
                      <span className="fine" id="split-note" role="status">
                        {splitNote}
                      </span>
                    )}
                  </form>
                )}
              </div>
            )}
            {hist && hist.length > 1 && (
              <div className="colmenu-hist">
                <p className="label">Distribution</p>
                <Chart kind="hist" points={hist} label={`Distribution of ${column.name}`} valueName="rows" compact />
              </div>
            )}
          </>
        )}
      </div>

      <div className="colmenu-links">
        {onCountBy && (
          <button className="link-btn" onClick={onCountBy}>
            {kind === 'time' ? `Count rows by month of “${column.name}”` : `Count rows by “${column.name}”`}
          </button>
        )}
        {onCategorize && (
          <button className="link-btn" onClick={onCategorize}>
            {categorized ? 'Edit these categories…' : `Group into categories by words in “${column.name}”…`}
          </button>
        )}
        {onLookup && (
          <button className="link-btn" onClick={onLookup}>
            Look up values by “{column.name}”…
          </button>
        )}
        {onUnpivot && (
          <button className="link-btn" onClick={onUnpivot}>
            Turn columns into rows (unpivot)…
          </button>
        )}
        {onHide && (
          <button className="link-btn" onClick={onHide}>
            Hide this column
          </button>
        )}
        <button className="link-btn" onClick={onInsert}>
          Insert “{column.name}” into the SQL editor
        </button>
      </div>
    </div>
  )
}
