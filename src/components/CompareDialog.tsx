import { useEffect, useMemo, useState } from 'react'
import { compareSql, defaultCompare, keyHealth, schemaDiff, type CompareSpec, type KeyHealth, type TableColumns } from '../engine/compare'
import { onTidiedRows } from '../engine/compose'
import { getEngine } from '../engine/db'
import { isNumericType, LOCALE } from '../engine/sql'
import { sideFor } from '../engine/match'
import { statementColumns } from '../engine/statement'
import { BtnIcon, Icon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  tables: TableColumns[]
  /** Pre-selected tables (e.g. the file just opened and its likely previous version). */
  before?: string
  after?: string
  initial?: CompareSpec
  onCompare: (sql: string, spec: CompareSpec) => void
  /** Matching payments instead (a bank statement against the books): a dialog of its own. */
  onMatch?: (a: string, b: string) => void
  /** Tables tidied by their steps, as SQL: their columns as tidied (dates converted) say whether they can be matched. */
  sources?: Record<string, string>
  onClose: () => void
}
const NO_SOURCES: Record<string, string> = {}

const nf = new Intl.NumberFormat(LOCALE)
const list = (names: string[]) => (names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '))

export function CompareDialog({ tables, before, after, initial, onCompare, onMatch, sources = NO_SOURCES, onClose }: Props) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  const [pair, setPair] = useState(() => ({
    before: initial?.before ?? before ?? tables[0]?.name ?? '',
    after: initial?.after ?? after ?? tables.find((t) => t.name !== (before ?? tables[0]?.name))?.name ?? '',
  }))
  const [suggested, setSuggested] = useState<{ for: string; spec: CompareSpec } | null>(null)
  const [edited, setEdited] = useState<CompareSpec | null>(initial ?? null)
  const [health, setHealth] = useState<{ for: string; rows: KeyHealth[] } | null>(null)
  // The key picked before switching to whole rows, restored when switching back.
  const [savedKeys, setSavedKeys] = useState<string[]>([])

  const rawA = tables.find((t) => t.name === pair.before)
  const rawB = tables.find((t) => t.name === pair.after)
  // A tidied table's columns as tidied (its dates converted by a step): what the match would read.
  // (null: the tidied rows couldn't be read, so the table as it is.)
  const [tidied, setTidied] = useState<Record<string, TableColumns['columns'] | null>>({})
  useEffect(() => {
    let live = true
    for (const name of [pair.before, pair.after]) {
      if (!sources[name] || tidied[name] !== undefined) continue
      void getEngine()
        .then(({ conn }) => conn.query(`DESCRIBE SELECT * FROM (\n${sources[name]}\n)`))
        .then((res) => {
          const columns = res.toArray().map((r) => ({ name: String(r.toJSON().column_name), type: String(r.toJSON().column_type) }))
          if (live) setTidied((t) => ({ ...t, [name]: columns }))
        })
        .catch(() => live && setTidied((t) => ({ ...t, [name]: null })))
    }
    return () => {
      live = false
    }
    // The two tables' tidied SQL is what's looked at (a new object each time the app draws isn't).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.before, pair.after, sources[pair.before], sources[pair.after]])
  // A table tidied by steps is compared as tidied (its total lines left out, its text converted): not its file
  // as it is, where every converted value would read as changed.
  const asMatched = (t: TableColumns): TableColumns => {
    const cols = tidied[t.name]
    return cols ? { ...t, columns: cols, source: sources[t.name] } : t
  }
  const waiting = (t?: TableColumns) => !!t && !!sources[t.name] && tidied[t.name] === undefined
  const A = useMemo(() => (rawA && !waiting(rawA) ? asMatched(rawA) : undefined), [rawA, tidied]) // eslint-disable-line react-hooks/exhaustive-deps
  const B = useMemo(() => (rawB && !waiting(rawB) ? asMatched(rawB) : undefined), [rawB, tidied]) // eslint-disable-line react-hooks/exhaustive-deps
  const pairKey = `${pair.before}\u0000${pair.after}`
  const diff = useMemo(() => (A && B ? schemaDiff(A, B) : null), [A, B])

  // Defaults for this pair of tables: a key that identifies rows in both, every shared column.
  useEffect(() => {
    if (!A || !B || A.name === B.name || (edited && edited.before === A.name && edited.after === B.name)) return
    let live = true
    defaultCompare(A, B)
      .then((spec) => live && setSuggested({ for: `${A.name}\u0000${B.name}`, spec }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [A, B, edited])

  const spec: CompareSpec | null =
    edited && edited.before === pair.before && edited.after === pair.after ? edited : suggested?.for === pairKey ? suggested.spec : null

  const healthKey = spec ? `${spec.before}\u0000${spec.after}\u0000${spec.keys.join('\u0000')}` : ''
  useEffect(() => {
    if (!spec || spec.mode !== 'key' || !spec.keys.length) return
    let live = true
    keyHealth(spec, sources)
      .then((rows) => live && setHealth({ for: healthKey, rows }))
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healthKey])
  const keyRows = health?.for === healthKey ? health.rows : null

  const update = (patch: Partial<CompareSpec>) => spec && setEdited({ ...spec, ...patch })
  const same = pair.before === pair.after
  const sharedNonKey = diff ? diff.shared.filter((c) => !spec?.keys.includes(c)) : []
  const toRows = () => {
    if (!spec) return
    setSavedKeys(spec.keys)
    // Whole-row matching compares the key columns too.
    update({ mode: 'row', keys: [], columns: [...spec.keys, ...spec.columns.filter((c) => !spec.keys.includes(c))] })
  }
  const toKey = () => {
    if (!spec) return
    const keys = savedKeys.filter((k) => diff?.shared.includes(k))
    update({ mode: 'key', keys, columns: spec.columns.filter((c) => !keys.includes(c)) })
  }
  const ready = !!spec && !same && (spec.mode === 'key' ? spec.keys.length > 0 : spec.columns.length > 0)
  // A bank statement and books (or two statements): their lines are matched by amount and date, not compared.
  const payments =
    !!onMatch && !same && !!A && !!B && !!sideFor(A) && !!sideFor(B) && (!!statementColumns(A.columns) || !!statementColumns(B.columns))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="compare-title" className="modal-wrap modal-wrap-wide">
        <form
          className="shell modal modal-wide"
          onSubmit={(e) => {
            e.preventDefault()
            if (spec && A && B && ready) onCompare([B, A].reduce((sql, t) => (t.source ? onTidiedRows(sql, t.name, t.source, 0) : sql), compareSql(spec, A, B)), spec)
          }}
        >
          <div className="core">
            <span className="eyebrow">Compare</span>
            <h2 id="compare-title">What changed between two tables?</h2>
            <p className="muted">
              Finds rows that were added, removed or changed, and which columns changed. Runs on every row, here in this tab.
              {onMatch && !payments && (
                <>
                  {' '}
                  Bank against books?{' '}
                  <button type="button" className="link-btn" onClick={() => onMatch(pair.before, pair.after)}>
                    Match payments by amount and date
                  </button>
                </>
              )}
            </p>

            {payments && (
              <p className="compare-match">
                <span>
                  {pair.before} and {pair.after} look like a statement and its books: payments are matched by amount and date, not compared row by row.
                </span>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onMatch!(pair.before, pair.after)}>
                  Match payments
                </button>
              </p>
            )}
            <div className="compare-pair">
              <label>
                <span>Before</span>
                <select value={pair.before} onChange={(e) => setPair({ ...pair, before: e.target.value })}>
                  {tables.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="icon-btn compare-swap"
                aria-label="Swap the two tables"
                title="Swap"
                onClick={() => {
                  setPair({ before: pair.after, after: pair.before })
                  if (spec) setEdited({ ...spec, before: pair.after, after: pair.before })
                }}
              >
                ⇄
              </button>
              <label>
                <span>After</span>
                <select value={pair.after} onChange={(e) => setPair({ ...pair, after: e.target.value })}>
                  {tables.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {same ? (
              <p className="pivot-error" role="alert">
                Pick two different tables.
              </p>
            ) : diff && (diff.onlyBefore.length || diff.onlyAfter.length || diff.typeChanged.length) ? (
              <ul className="compare-schema">
                {diff.onlyBefore.length > 0 && (
                  <li>
                    Only in {pair.before}: <b>{list(diff.onlyBefore)}</b>
                  </li>
                )}
                {diff.onlyAfter.length > 0 && (
                  <li>
                    Only in {pair.after}: <b>{list(diff.onlyAfter)}</b>
                  </li>
                )}
                {diff.typeChanged.map((c) => (
                  <li key={c.name}>
                    <b>{c.name}</b> changed type ({c.before.toLowerCase()} → {c.after.toLowerCase()}): compared as{' '}
                    {isNumericType(c.before) && isNumericType(c.after) ? 'numbers' : 'text'}
                  </li>
                ))}
              </ul>
            ) : diff ? (
              <p className="fine compare-ok">Both tables have the same {diff.shared.length} columns.</p>
            ) : null}

            {!spec || same ? (
              !same && <p className="muted small">Looking for a column that identifies each row…</p>
            ) : (
              <div className="pivot-grid">
                <fieldset className="pivot-zone">
                  <legend>Match rows by</legend>
                  <label className="inline">
                    <input type="radio" name="mode" checked={spec.mode === 'key'} onChange={toKey} disabled={!diff?.shared.length} /> A key
                    column
                  </label>
                  {spec.mode === 'key' && (
                    <>
                      {spec.keys.map((k) => (
                        <div className="pivot-field" key={k}>
                          <span className="pivot-name">{k}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Remove ${k} from the key`}
                            onClick={() => update({ keys: spec.keys.filter((x) => x !== k), columns: [...spec.columns, k] })}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                      {spec.keys.length < 3 && (
                        <select
                          className="pivot-add"
                          aria-label="Add a key column"
                          value=""
                          onChange={(e) => e.target.value && update({ keys: [...spec.keys, e.target.value], columns: spec.columns.filter((c) => c !== e.target.value) })}
                        >
                          <option value="">{spec.keys.length ? '+ Add another column' : '+ Pick the column that identifies a row'}</option>
                          {sharedNonKey.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                      <KeyHealthLine rows={keyRows} keys={spec.keys} />
                    </>
                  )}
                  <label className="inline">
                    <input type="radio" name="mode" checked={spec.mode === 'row'} onChange={toRows} /> Whole rows (no key)
                  </label>
                  {spec.mode === 'row' && (
                    <p className="fine">
                      A row counts as unchanged only if every compared column matches exactly; edits show as one removed and one added row. To ignore case,
                      spaces or rounding, match by a key.
                    </p>
                  )}
                </fieldset>

                <fieldset className="pivot-zone">
                  <legend>Compare these columns</legend>
                  <div className="compare-cols">
                    {sharedNonKey.map((c) => (
                      <label className="inline" key={c}>
                        <input
                          type="checkbox"
                          checked={spec.columns.includes(c)}
                          onChange={(e) => update({ columns: e.target.checked ? [...spec.columns, c] : spec.columns.filter((x) => x !== c) })}
                        />
                        {c}
                      </label>
                    ))}
                    {!sharedNonKey.length && <p className="fine">No other shared columns.</p>}
                    {spec.mode === 'row' && !spec.columns.length && <p className="fine">Pick at least one column to compare.</p>}
                  </div>
                </fieldset>

                {spec.mode === 'key' && (
                  <fieldset className="pivot-zone compare-options">
                    <legend>Options</legend>
                    <label className="inline">
                      <input type="checkbox" checked={spec.trimSpaces} onChange={(e) => update({ trimSpaces: e.target.checked })} /> Ignore extra spaces in text
                    </label>
                    <label className="inline">
                      <input type="checkbox" checked={spec.ignoreCase} onChange={(e) => update({ ignoreCase: e.target.checked })} /> Ignore upper / lower case
                    </label>
                    <label className="inline">
                      <input type="checkbox" checked={spec.tolerance !== null} onChange={(e) => update({ tolerance: e.target.checked ? 0.01 : null })} /> Ignore differences under
                      0.01 in numbers with decimals
                    </label>
                    <label className="inline">
                      <input type="checkbox" checked={spec.includeSame} onChange={(e) => update({ includeSame: e.target.checked })} /> Include unchanged rows
                    </label>
                  </fieldset>
                )}
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!ready}>
                Compare
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

function KeyHealthLine({ rows, keys }: { rows: KeyHealth[] | null; keys: string[] }) {
  if (!keys.length) return <p className="fine">Without a key, rows are matched by all their values (switch to Whole rows).</p>
  if (!rows) return <p className="fine">Checking {keys.join(' + ')}…</p>
  const bad = rows.filter((r) => r.duplicates || r.empty)
  if (!bad.length) return <p className="fine compare-ok">✓ {keys.join(' + ')} is unique and never empty in both tables.</p>
  return (
    <p className="fine compare-warn" role="status">
      {bad
        .map((r) =>
          [
            r.duplicates ? `${keys.join(' + ')} repeats ${nf.format(r.duplicates)} times in ${r.table}` : '',
            r.empty ? `${nf.format(r.empty)} rows in ${r.table} have no ${keys.join(' + ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        )
        .join('. ')}
      . Add another key column, or compare whole rows.
    </p>
  )
}
