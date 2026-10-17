import { describeFilter, emptyOps, filterSql, hasOps, type Ops } from '../engine/compose'
import { useState } from 'react'
import { cleanExpr, describeClean, isConversion } from '../engine/clean'
import { sqlName } from '../engine/sql'
import { describeLookup } from '../engine/lookup'
import { thenKeepFocus } from './focus'
import { Icon } from './Icon'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

interface Props {
  ops: Ops
  onApply: (next: Ops) => void
  /** The steps without clean-up step i (and without filters its removal makes meaningless). */
  withoutClean: (i: number) => Ops
  /** The steps without several clean-up steps at once (a group of conversions). */
  withoutCleans?: (indices: number[]) => Ops
  /** The steps without look-up i (and without everything that used its columns). */
  withoutLookup: (i: number) => Ops
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** These rows were made from others (counted, unpivoted…): what was done, from what, and the way back. */
  origin?: { label: string; source: string; onBack: () => void } | null
}

/** The steps applied to the rows on screen, each a chip that removes it; Undo, Redo and Clear all. */
export function StepChips({ ops, onApply, withoutClean, withoutCleans, withoutLookup, canUndo, canRedo, onUndo, onRedo, origin }: Props) {
  // Three or more columns converted (usually one click on "Convert"): one chip for them, opened on demand.
  const [open, setOpen] = useState(false)
  const conversions = (ops.clean ?? []).flatMap((c, i) => (isConversion(c) ? [i] : []))
  const grouped = !!withoutCleans && conversions.length >= 3 && !open
  return (
    <span className="op-chips">
      {origin && (
        <button className="origin-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', origin.onBack)} title={`Back to ${origin.source}, with the steps it had`}>
          <Icon name="arrowLeft" size={13} /> {origin.label}, from {origin.source}
        </button>
      )}
      {ops.sort && (
        <button className="op-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, sort: undefined }))} title={`Remove sort · ORDER BY ${sqlName(ops.sort.column)} ${ops.sort.dir.toUpperCase()}`}>
          <Icon name={ops.sort.dir === 'asc' ? 'sortAsc' : 'sortDesc'} size={14} /> {ops.sort.column}, {ops.sort.dir === 'asc' ? 'ascending' : 'descending'}
          <Icon name="close" size={12} />
        </button>
      )}
      {ops.filters.map((f, i) => (
        <button key={i} className="op-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, filters: ops.filters.filter((_, j) => j !== i) }))} title={`Remove filter · WHERE ${filterSql(f)}`}>
          <Icon name="filter" size={14} /> {describeFilter(f)}
          <Icon name="close" size={12} />
        </button>
      ))}
      {ops.search && (
        <button className="op-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, search: undefined }))} title="Remove search">
          <Icon name="search" size={14} /> Contains “{ops.search}”
          <Icon name="close" size={12} />
        </button>
      )}
      {ops.dedupe && (
        <button className="op-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, dedupe: undefined }))} title="Show all rows again">
          <Icon name="copy" size={14} /> {ops.dedupe.mode === 'show' ? `Duplicates in ${ops.dedupe.column}` : `First of each ${ops.dedupe.column}`}
          <Icon name="close" size={12} />
        </button>
      )}
      {grouped && (
        <span className="op-group">
          <button
            className="op-chip"
            onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(withoutCleans!(conversions)))}
            title={`Undo these conversions · ${conversions.map((i) => describeClean(ops.clean![i])).join(' · ')}`}
          >
            <Icon name="spark" size={14} /> {conversions.length} columns converted
            <Icon name="close" size={12} />
          </button>
          <button className="link-btn op-group-toggle" aria-expanded={false} onClick={() => setOpen(true)}>
            Show each
          </button>
        </span>
      )}
      {ops.clean?.map((c, i) =>
        grouped && conversions.includes(i) ? null : (
          <button key={`clean:${i}:${c.column}`} className="op-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(withoutClean(i)))} title={`Undo this cleaning · ${cleanExpr(c)}`}>
            <Icon name="spark" size={14} /> {describeClean(c)}
            <Icon name="close" size={12} />
          </button>
        ),
      )}
      {open && conversions.length >= 3 && (
        <button className="link-btn op-group-toggle" aria-expanded onClick={() => setOpen(false)}>
          Group conversions
        </button>
      )}
      {ops.drop?.map((d, i) => (
        <button
          key={`drop:${i}`}
          className="op-chip"
          onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, drop: ops.drop!.length > 1 ? ops.drop!.filter((_, j) => j !== i) : undefined }))}
          title="Show these rows again"
        >
          <Icon name="filter" size={14} /> Without {d.label}
          <Icon name="close" size={12} />
        </button>
      ))}
      {ops.hidden?.map((h) => (
        <button
          key={`hidden:${h}`}
          className="op-chip"
          onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, hidden: ops.hidden!.length > 1 ? ops.hidden!.filter((x) => x !== h) : undefined }))}
          title={`Show this column again · EXCLUDE (${sqlName(h)})`}
        >
          <Icon name="column" size={14} /> Hidden: {h}
          <Icon name="close" size={12} />
        </button>
      ))}
      {ops.lookups?.map((l, i) => (
        <button key={`lookup:${i}`} className="op-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(withoutLookup(i)))} title="Remove these columns">
          <Icon name="link" size={14} /> {describeLookup(l)}
          <Icon name="close" size={12} />
        </button>
      ))}
      {ops.computed.map((c, i) => (
        <button key={c.name} className="op-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, computed: ops.computed.filter((_, j) => j !== i) }))} title={`Remove column · ${c.expr}`}>
          <Icon name="column" size={14} /> {c.name}
          <Icon name="close" size={12} />
        </button>
      ))}
      {canUndo && (
        <button className="link-btn" onClick={onUndo} title={`Undo (${isMac ? '⌘' : 'Ctrl'}+Z)`}>
          Undo
        </button>
      )}
      {canRedo && (
        <button className="link-btn" onClick={onRedo} title={`Redo (${isMac ? '⌘⇧Z' : 'Ctrl+Y'})`}>
          Redo
        </button>
      )}
      {hasOps(ops) && (
        <button className="link-btn" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(emptyOps()))}>
          Clear all
        </button>
      )}
    </span>
  )
}
