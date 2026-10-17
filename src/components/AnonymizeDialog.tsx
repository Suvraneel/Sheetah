import { useEffect, useMemo, useState } from 'react'
import { keepPseudonymKey, keepsPseudonymKey } from '../engine/db'
import { SAMPLE_ROWS, detectPii, previewValues, type Detection } from '../engine/pii'
import { ACTION_LABEL, RULES, actionHelp, actionSql, anonymizeSql, ruleFor, type Choice, type PiiAction, type PiiKind } from '../engine/pii-rules'
import { isTemporal } from '../engine/chart'
import { LOCALE, splitStatements } from '../engine/sql'
import type { ColumnInfo, ResultSet } from '../engine/result'
import { BtnIcon, Icon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  result: ResultSet
  /** Name used in the SQL comment ("Anonymized copy of customers"). */
  label: string
  onCreate: (sql: string, summary: string) => void
  onClose: () => void
}

const pct = (r: number | null | undefined) => (r == null ? null : `${Math.round(r * 100)}%`)
const ALL_ACTIONS: PiiAction[] = ['keep', 'mask', 'pseudonym', 'label', 'generalize', 'remove']

export function AnonymizeDialog({ result, label, onCreate, onClose }: Props) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  const [found, setFound] = useState<Detection[] | null>(null)
  const [choices, setChoices] = useState<Record<string, { kind: PiiKind | null; action: PiiAction }>>({})
  const [keepKey, setKeepKey] = useState(keepsPseudonymKey)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let live = true
    detectPii(result)
      .then((d) => {
        if (!live) return
        setFound(d)
        setChoices(Object.fromEntries(d.map((x) => [x.column, { kind: x.kind, action: ruleFor(x.kind).defaultAction }])))
      })
      .catch(() => live && setFound([]))
    return () => {
      live = false
    }
  }, [result])

  const flagged = useMemo(() => new Set((found ?? []).map((d) => d.column)), [found])
  const others = result.columns.filter((c) => !flagged.has(c.name))
  const choiceFor = (c: ColumnInfo) => choices[c.name] ?? { kind: null, action: 'keep' as PiiAction }
  const set = (c: ColumnInfo, patch: Partial<{ kind: PiiKind | null; action: PiiAction }>) =>
    setChoices((all) => ({ ...all, [c.name]: { ...choiceFor(c), ...patch } }))

  const list: Choice[] = result.columns
    .map((c) => ({ column: c.name, ...choiceFor(c), temporal: isTemporal(c) }))
    .filter((c) => c.action !== 'keep')
  const changed = list.length

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!changed) return
    const source = splitStatements(result.sql).at(-1) ?? result.sql
    const sql = anonymizeSql(source, list, label)
    const removed = list.filter((c) => c.action === 'remove').length
    onCreate(sql, `${changed - removed} ${changed - removed === 1 ? 'column' : 'columns'} changed${removed ? `, ${removed} removed` : ''}`)
  }

  const row = (c: ColumnInfo, d?: Detection) => {
    const ch = choiceFor(c)
    const actions = ch.kind ? ruleFor(ch.kind).actions : ALL_ACTIONS
    return (
      <li key={c.name} className={`anon-row${ch.action !== 'keep' ? ' is-on' : ''}`}>
        <div className="anon-col">
          <span className="anon-name">{c.name}</span>
          <span className="anon-kind">
            {d ? (
              <>
                <Icon name="shield" size={13} /> {ruleFor(d.kind).label}
                {d.ratio != null ? ` · ${pct(d.ratio)} of values` : ' · by its name'}
                {d.verified != null ? `, ${pct(d.verified)} with valid checksums` : ''}
              </>
            ) : (
              <select aria-label={`What kind of data is ${c.name}?`} value={ch.kind ?? ''} onChange={(e) => set(c, { kind: (e.target.value || null) as PiiKind | null, action: e.target.value ? ruleFor(e.target.value as PiiKind).defaultAction : 'keep' })}>
                <option value="">Not personal</option>
                {RULES.map((r) => (
                  <option key={r.kind} value={r.kind}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </span>
        </div>
        <div className="anon-action">
          <select aria-label={`What to do with ${c.name}`} value={ch.action} onChange={(e) => set(c, { action: e.target.value as PiiAction })}>
            {actions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </select>
          <span className="anon-help">{actionHelp(ch.kind, ch.action)}</span>
        </div>
        <Preview result={result} column={c} kind={ch.kind} action={ch.action} />
      </li>
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="anon-title" className="modal-wrap modal-wrap-wide">
        <form className="shell modal modal-wide" onSubmit={submit}>
          <div className="core">
            <span className="eyebrow">Anonymize</span>
            <h2 id="anon-title">Remove personal data before you share</h2>
            <p className="muted">
              Checked {Math.min(SAMPLE_ROWS, result.rowCount).toLocaleString(LOCALE)} sample rows in this tab. Detection helps, but check
              free-text columns like notes or addresses yourself.
            </p>

            {!found ? (
              <p className="muted small">Looking for emails, phone numbers, Aadhaar, PAN, card numbers, IP addresses and names…</p>
            ) : (
              <>
                {found.length ? (
                  <ul className="anon-list" aria-label="Columns with personal data">
                    {found.map((d) => row(result.columns.find((c) => c.name === d.column)!, d))}
                  </ul>
                ) : (
                  <p className="anon-none">No personal data found in the sample. You can still pick columns below.</p>
                )}
                {others.length > 0 && (
                  <>
                    <button type="button" className="link-btn anon-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                      {showAll ? 'Hide' : 'Show'} the other {others.length} {others.length === 1 ? 'column' : 'columns'}
                    </button>
                    {showAll && (
                      <ul className="anon-list" aria-label="Other columns">
                        {others.map((c) => row(c))}
                      </ul>
                    )}
                  </>
                )}
                <label className="inline anon-key">
                  <input
                    type="checkbox"
                    checked={keepKey}
                    onChange={(e) => {
                      setKeepKey(e.target.checked)
                      void keepPseudonymKey(e.target.checked)
                    }}
                  />
                  Use the same pseudonyms next time (keeps the secret key in this browser)
                </label>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!changed}>
                Create anonymized result
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

function Preview({ result, column, kind, action }: { result: ResultSet; column: ColumnInfo; kind: PiiKind | null; action: PiiAction }) {
  const expr = action === 'keep' || action === 'remove' ? null : actionSql(column.name, kind, action, isTemporal(column))
  const key = `${column.name}\u0000${expr}`
  const [state, setState] = useState<{ key: string; rows: { before: string; after: string | null }[] } | null>(null)
  useEffect(() => {
    if (action === 'keep') return
    let live = true
    const t = window.setTimeout(() => {
      previewValues(result, column, expr, 2)
        .then((rows) => live && setState({ key, rows }))
        .catch(() => live && setState({ key, rows: [] }))
    }, 120)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [result, column, expr, key, action])
  if (action === 'keep') return <div className="anon-preview" aria-hidden />
  const rows = state?.key === key ? state.rows : null
  return (
    <div className="anon-preview" role="group" aria-label={`Example: ${column.name}`}>
      {rows === null
        ? '…'
        : rows.map((r, i) => (
            <span key={i}>
              <s>{r.before}</s> → <b>{action === 'remove' ? 'removed' : (r.after ?? '–')}</b>
            </span>
          ))}
    </div>
  )
}
