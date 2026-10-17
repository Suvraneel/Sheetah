import { useRef, useState } from 'react'
import type { ColumnInfo } from '../engine/result'
import { getEngine } from '../engine/db'
import { explainError } from '../engine/errors'
import { isIdLike, sqlName } from '../engine/sql'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  columns: ColumnInfo[]
  /** The rows the new column is computed on: the formula is checked against them before it's added. */
  source: string
  onAdd: (name: string, expr: string) => void
  onClose: () => void
}

/** "Formula" columns: a spreadsheet-style expression that becomes a SQL column. */
export function AddColumn({ columns, source, onAdd, onClose }: Props) {
  const [name, setName] = useState('')
  const [expr, setExpr] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const exprRef = useRef<HTMLInputElement>(null)
  const numeric = columns.filter((c) => c.numeric && !isIdLike(c.name)).map((c) => sqlName(c.name))
  const text = columns.find((c) => !c.numeric)
  const example = numeric.length >= 2 ? `${numeric[0]} * ${numeric[1]}` : text ? `upper(${sqlName(text.name)})` : '1 + 1'
  // Ideas made from this table's own columns.
  const ideas = [
    numeric[0] && `round(${numeric[0]} / 1000, 1)`,
    numeric[0] && `if(${numeric[0]} > 5000, 'big', 'small')`,
    columns.find((c) => /^(DATE|TIMESTAMP)/i.test(c.type)) && `year(${sqlName(columns.find((c) => /^(DATE|TIMESTAMP)/i.test(c.type))!.name)})`,
    text && `left(${sqlName(text.name)}, 3)`,
  ].filter((x): x is string => !!x)

  /** Spreadsheet habits: a leading "=" is dropped. Then the formula is tried on zero rows, so a mistake shows here. */
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    const f = expr.trim().replace(/^=\s*/, '')
    if (!n || !f) return
    setChecking(true)
    try {
      const { conn } = await getEngine()
      await conn.query(`SELECT (${f}\n) AS x FROM (\n${source}\n) LIMIT 0`)
      onAdd(n, f)
    } catch (err) {
      setProblem(explainError(err instanceof Error ? err.message : String(err)).text)
      exprRef.current?.focus()
    } finally {
      setChecking(false)
    }
  }

  const dialog = useDialog<HTMLDivElement>(onClose)

  const insert = (col: string) => {
    const el = exprRef.current
    const token = sqlName(col)
    const start = el?.selectionStart ?? expr.length
    const next = expr.slice(0, start) + token + expr.slice(el?.selectionEnd ?? start)
    setExpr(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="addcol-title" className="modal-wrap">
      <form
        className="shell modal"
        onSubmit={(e) => void submit(e)}
      >
        <div className="core">
          <span className="eyebrow">Formula column</span>
          <h2 id="addcol-title">Add a column</h2>
          <p className="muted">Write it like a spreadsheet formula. It runs as SQL on every row.</p>
          <label className="field-label" htmlFor="col-name">
            Name
          </label>
          <input id="col-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="revenue" autoFocus required />
          <label className="field-label" htmlFor="col-expr">
            Formula
          </label>
          <input
            id="col-expr"
            ref={exprRef}
            className="input mono"
            value={expr}
            onChange={(e) => {
              setExpr(e.target.value)
              setProblem(null)
            }}
            placeholder={example}
            aria-invalid={!!problem || undefined}
            aria-describedby={problem ? 'col-expr-problem' : undefined}
            required
          />
          {problem && (
            <p className="colmenu-error" id="col-expr-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="chips" aria-label="Insert a column">
            {columns.slice(0, 16).map((c) => (
              <button type="button" key={c.name} className="chip" onClick={() => insert(c.name)}>
                {c.name}
              </button>
            ))}
          </div>
          <p className="fine">
            Ideas:{' '}
            {ideas.map((idea, i) => (
              <span key={idea}>
                {i > 0 && ' · '}
                <code>{idea}</code>
              </span>
            ))}
            . Text goes in 'single quotes'.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={checking}>
              Add column
              <BtnIcon name="plus" />
            </button>
          </div>
        </div>
      </form>
      </div>
    </div>
  )
}
