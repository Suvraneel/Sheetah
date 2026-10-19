import { useEffect, useMemo, useRef, useState } from 'react'
import { getEngine } from '../engine/db'
import { directionSql, matchCountsSql, matchSql, sideFor, statusLabels, type MatchSide, type MatchSpec } from '../engine/match'
import { isNumericType, LOCALE } from '../engine/sql'
import { statementColumns } from '../engine/statement'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

interface Table {
  name: string
  columns: { name: string; type: string }[]
}

interface Props {
  tables: Table[]
  /** Tables tidied by steps: the rows to match are those (total lines left out, dates converted). */
  sources?: Record<string, string>
  /** The two tables to start with (the bank statement first, if it's known). */
  a?: string
  b?: string
  /** The match's query, what it found in words, and whether every line matched. */
  onMatch: (sql: string, summary: string, all: boolean, spec: MatchSpec) => void
  onClose: () => void
}

const nf = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })
const money = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format
const TWO = '\u0000in-out'
const NONE: Record<string, string> = {}

/** A table's date, amount and words, picked for matching (a guess to start with). */
function SideFields({ label, name, table, side, tables, onTable, onSide }: { label: string; name: string; table: Table | undefined; side: MatchSide | null; tables: Table[]; onTable: (name: string) => void; onSide: (s: MatchSide) => void }) {
  const cols = table?.columns ?? []
  const st = table ? statementColumns(cols) : null
  const amountValue = !side ? '' : 'column' in side.amount ? side.amount.column : TWO
  return (
    <fieldset className="pivot-zone match-side">
      <legend>{label}</legend>
      <label className="match-field">
        <span className="fine">Table</span>
        <select value={name} onChange={(e) => onTable(e.target.value)}>
          {tables.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {side ? (
        <>
          <label className="match-field">
            <span className="fine">Date</span>
            <select value={side.date} onChange={(e) => onSide({ ...side, date: e.target.value })}>
              {cols
                .filter((c) => /^(DATE|TIMESTAMP)/i.test(c.type))
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="match-field">
            <span className="fine">Amount</span>
            <select
              value={amountValue}
              onChange={(e) => onSide({ ...side, amount: e.target.value === TWO && st ? { credit: st.credit, debit: st.debit } : { column: e.target.value } })}
            >
              {st && <option value={TWO}>{`${st.credit} − ${st.debit}`}</option>}
              {cols
                .filter((c) => !/^(DATE|TIMESTAMP|BOOL)/i.test(c.type))
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="match-field">
            <span className="fine">Shown beside it</span>
            <select value={side.text ?? ''} onChange={(e) => onSide({ ...side, text: e.target.value || undefined })}>
              <option value="">Nothing</option>
              {cols.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="match-field">
            <span className="fine">Cheque or reference no.</span>
            <select value={side.ref ?? ''} onChange={(e) => onSide({ ...side, ref: e.target.value || undefined })}>
              <option value="">None</option>
              {cols
                .filter((c) => !/^(DATE|TIMESTAMP|BOOL|DOUBLE|DECIMAL|FLOAT|REAL)/i.test(c.type))
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        </>
      ) : (
        <p className="fine">
          {!table
            ? name
              ? 'Reading its columns…'
              : 'Pick a table.'
            : table.columns.some((c) => /date/i.test(c.name) && !/^(DATE|TIMESTAMP)/i.test(c.type))
              ? `${table.name}’s dates are stored as text. Open it, take its Convert suggestion (or Convert in the date column’s menu), and come back: the converted rows are what’s matched.`
              : `${table.name} needs a date column and an amount to match on.`}
        </p>
      )}
    </fieldset>
  )
}

/**
 * Matching payments, bank against books: each line to one line of the other table with the same amount,
 * dated up to a few days apart. What's left over is what to look into.
 */
export function MatchDialog({ tables, sources = NONE, a, b, onMatch, onClose }: Props) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  const [names, setNames] = useState(() => {
    // The bank statement first (it's what the books are checked against).
    const bank = (n?: string) => {
      const st = statementColumns(tables.find((t) => t.name === n)?.columns ?? [])
      return !!st && !st.books
    }
    if (a && b && bank(b) && !bank(a)) [a, b] = [b, a]
    const first = a ?? tables.find((t) => bank(t.name))?.name ?? tables[0]?.name ?? ''
    return { a: first, b: b && b !== first ? b : (tables.find((t) => t.name !== first && sideFor(t))?.name ?? tables.find((t) => t.name !== first)?.name ?? '') }
  })
  // Each table's columns as the match reads it: as tidied by its steps (dates converted), else as opened.
  const [described, setDescribed] = useState<Record<string, Table['columns']>>({})
  const asRead = (name: string): Table | undefined => {
    const t = tables.find((x) => x.name === name)
    return t && sources[name] ? (described[name] ? { name, columns: described[name] } : undefined) : t
  }
  useEffect(() => {
    let live = true
    for (const name of [names.a, names.b]) {
      if (!sources[name] || described[name]) continue
      void getEngine()
        .then(({ conn }) => conn.query(`DESCRIBE SELECT * FROM (\n${sources[name]}\n)`))
        .then((res) => {
          const cols = res.toArray().map((r) => r.toJSON() as { column_name: string; column_type: string }).map((r) => ({ name: String(r.column_name), type: String(r.column_type) }))
          if (live) setDescribed((d) => ({ ...d, [name]: cols }))
        })
        .catch(() => live && setDescribed((d) => ({ ...d, [name]: tables.find((t) => t.name === name)?.columns ?? [] })))
    }
    return () => {
      live = false
    }
  }, [names, sources, described, tables])
  const A = asRead(names.a)
  const B = asRead(names.b)
  // The fields picked by hand, for the table they were picked on.
  const [picked, setPicked] = useState<{ a?: MatchSide; b?: MatchSide }>({})
  const withSource = (s: MatchSide | null) => (s && sources[s.table] ? { ...s, source: sources[s.table] } : s)
  const sideA = withSource(picked.a?.table === names.a ? picked.a : A ? sideFor(A) : null)
  const sideB = withSource(picked.b?.table === names.b ? picked.b : B ? sideFor(B) : null)
  const [days, setDays] = useState(3)
  // Which way round the second table records money: found from the amounts (the tables and their amounts,
  // not the dates or words shown), unless the reader has said.
  const dirKey = sideA && sideB ? JSON.stringify([sideA.table, sideA.amount, sideB.table, sideB.amount]) : ''
  const [found, setFound] = useState<{ for: string; flip: boolean } | null>(null)
  const [said, setSaid] = useState<{ for: string; flip: boolean } | null>(null)
  const flip = said?.for === dirKey ? said.flip : found?.for === dirKey ? found.flip : null
  const numeric = useMemo(() => {
    const types = new Map([...tables.map((t) => [t.name, t.columns] as const), ...Object.entries(described)].flatMap(([t, cols]) => cols.map((c) => [`${t}\u0000${c.name}`, c.type])))
    return (side: MatchSide, column: string) => isNumericType(types.get(`${side.table}\u0000${column}`) ?? '')
  }, [tables, described])
  const spec: MatchSpec | null = sideA && sideB && names.a !== names.b && flip !== null ? { a: sideA, b: sideB, days, flip } : null
  const sql = spec ? matchSql(spec, numeric) : null

  useEffect(() => {
    if (!sideA || !sideB || names.a === names.b || found?.for === dirKey || said?.for === dirKey) return
    let live = true
    void getEngine()
      .then(({ conn }) => conn.query(directionSql({ a: sideA, b: sideB, days: 3, flip: false }, numeric)))
      .then((res) => {
        const r = (res.toArray()[0]?.toJSON() ?? {}) as { same?: number; flipped?: number }
        if (live) setFound({ for: dirKey, flip: Number(r.flipped ?? 0) > Number(r.same ?? 0) })
      })
      .catch(() => live && setFound({ for: dirKey, flip: false }))
    return () => {
      live = false
    }
    // The pair, as its key says it (the sides are made afresh each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirKey])

  // How many lines match, and what's left on each side, a moment after anything changes.
  const [counts, setCounts] = useState<{ sql: string; rows?: { status: string; n: number; total: number; money_in: number; money_out: number; near: number; undated: number; typos: number; near_days: number | null }[]; error?: string } | null>(null)
  useEffect(() => {
    if (!sql) return
    let live = true
    const t = window.setTimeout(() => {
      void getEngine()
        .then(({ conn }) => conn.query(matchCountsSql(sql)))
        .then((res) => live && setCounts({ sql, rows: res.toArray().map((r) => r.toJSON() as { status: string; n: number; total: number; money_in: number; money_out: number; near: number; undated: number; typos: number; near_days: number | null }) }))
        .catch((e: unknown) => live && setCounts({ sql, error: e instanceof Error ? e.message : String(e) }))
    }, 300)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [sql])
  const failed = counts?.sql === sql ? counts.error : undefined
  const shown = counts?.sql === sql ? (counts.rows ?? null) : null
  const labels = spec ? statusLabels(spec) : null
  const of = (status: string | undefined) => shown?.find((r) => r.status === status)
  // The nearest of them: a cheque presented a fortnight late, not last month's instalment of a loan a month away.
  const nearDays = labels ? Math.min(...[of(labels.a)?.near_days, of(labels.b)?.near_days].filter((d): d is number => d !== null && d !== undefined).map(Number), Infinity) : Infinity
  const daysInput = useRef<HTMLInputElement>(null)
  const summary =
    labels && shown
      ? [
          `${nf.format(of(labels.matched)?.n ?? 0)} matched`,
          // What's left on each side as money in and money out (netted, they'd mean nothing).
          ...[labels.a, labels.b].map((l) => {
            const r = of(l)
            const parts = [r?.money_in ? `in ${money(r.money_in)}` : '', r?.money_out ? `out ${money(r.money_out)}` : ''].filter(Boolean)
            return `${nf.format(r?.n ?? 0)} ${l}${parts.length ? ` (${parts.join(', ')})` : ''}`
          }),
          ...(() => {
            // (Each said beside the lines on both sides: counted on the first table's.)
            const near = of(labels.a)?.near ?? 0
            const undated = (of(labels.a)?.undated ?? 0) + (of(labels.b)?.undated ?? 0)
            // (Said beside both lines of each pair: counted once.)
            const typos = of(labels.a)?.typos ?? 0
            return [
              ...(near ? [`${nf.format(near)} with the same amount on the other side further apart (see note)`] : []),
              ...(typos ? [`${nf.format(typos)} ${typos === 1 ? 'pair' : 'pairs'} where an amount may be typed wrong on one side (see note)`] : []),
              ...(undated ? [`${nf.format(undated)} with no date`] : []),
            ]
          })(),
        ].join(' · ')
      : null

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="match-title" className="modal-wrap modal-wrap-wide">
        <form
          className="shell modal modal-wide"
          onSubmit={(e) => {
            e.preventDefault()
            if (sql && summary && labels && spec) onMatch(sql, summary, !of(labels.a)?.n && !of(labels.b)?.n, spec)
          }}
        >
          <div className="core">
            <span className="eyebrow">Match payments</span>
            <h2 id="match-title">Bank against books</h2>
            <p className="muted">
              Each line is matched to one line of the other table with the same amount, dated up to {days} {days === 1 ? 'day' : 'days'} apart
              {sideA?.ref && sideB?.ref ? ' (or with the same cheque or reference number, however late it cleared)' : ''}. What’s left on either side is what
              to look into.
            </p>
            <div className="pivot-grid">
              <SideFields
                label="First table"
                name={names.a}
                table={A}
                side={sideA}
                tables={tables}
                onTable={(name) => setNames({ ...names, a: name })}
                onSide={(s) => setPicked({ ...picked, a: s })}
              />
              <SideFields
                label="Matched against"
                name={names.b}
                table={B}
                side={sideB}
                tables={tables}
                onTable={(name) => setNames({ ...names, b: name })}
                onSide={(s) => setPicked({ ...picked, b: s })}
              />
            </div>
            <div className="match-options">
              <label className="inline">
                Dates up to
                <input ref={daysInput} className="input match-days" type="number" min={0} max={31} value={days} onChange={(e) => setDays(Math.max(0, Math.min(31, Math.floor(Number(e.target.value) || 0))))} />
                days apart
              </label>
              <label className="inline">
                <input type="checkbox" checked={!!flip} disabled={!dirKey || flip === null} onChange={(e) => setSaid({ for: dirKey, flip: e.target.checked })} />
                {names.b || 'The other table'} records money the other way round (its receipts as minus)
              </label>
            </div>
            <p className={`fine stack-report${names.a === names.b ? ' unpivot-warning' : ''}`} role="status">
              {names.a === names.b
                ? 'Pick two different tables.'
                : !sideA || !sideB
                  ? 'Each table needs a date and an amount.'
                  : failed
                    ? `Couldn’t match these: ${failed}`
                    : (summary ?? 'Matching…')}
              {/* A cheque presented a fortnight after it was written is no item to reconcile: matched, once allowed. */}
              {!failed && nearDays > days && nearDays <= 20 && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setDays(nearDays)
                      // (The button goes as the preview is worked out again: focus stays in the dialog, on the days.)
                      daysInput.current?.focus()
                    }}
                  >
                    Allow {nearDays} days
                  </button>
                </>
              )}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!sql || !summary}>
                Match them
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
