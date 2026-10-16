import { useRef, useState } from 'react'
import type { ColumnInfo } from '../engine/result'
import { quoteIdent } from '../engine/db'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  columns: ColumnInfo[]
  onAdd: (name: string, expr: string) => void
  onClose: () => void
}

/** "Formula" columns: a spreadsheet-style expression that becomes a SQL column. */
export function AddColumn({ columns, onAdd, onClose }: Props) {
  const [name, setName] = useState('')
  const [expr, setExpr] = useState('')
  const exprRef = useRef<HTMLInputElement>(null)
  const numeric = columns.filter((c) => c.numeric && !/(^|_)id$/i.test(c.name)).map((c) => c.name)
  const example = numeric.length >= 2 ? `${numeric[0]} * ${numeric[1]}` : columns[0] ? `upper(${columns[0].name})` : '1 + 1'

  const dialog = useDialog<HTMLDivElement>(onClose)

  const insert = (col: string) => {
    const el = exprRef.current
    const token = /^[a-z_][a-z0-9_]*$/.test(col) ? col : quoteIdent(col)
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
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && expr.trim()) onAdd(name.trim(), expr.trim())
        }}
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
            onChange={(e) => setExpr(e.target.value)}
            placeholder={example}
            required
          />
          <div className="chips" aria-label="Insert a column">
            {columns.slice(0, 16).map((c) => (
              <button type="button" key={c.name} className="chip" onClick={() => insert(c.name)}>
                {c.name}
              </button>
            ))}
          </div>
          <p className="fine">
            Ideas: <code>round(total / quantity, 2)</code> · <code>year(ordered_at)</code> · <code>CASE WHEN total &gt; 5000 THEN 'big' ELSE 'small' END</code>
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary">
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
