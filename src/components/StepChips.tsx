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
  /** Opens an added category column's rules to edit (its chip does; its × removes it). */
  onEditCategories?: (name: string) => void
}

/** A step's chip is named for what clicking it does: "Remove step: Without 1 total line". */
const removes = (what: string) => `Remove step: ${what}`

/** The steps applied to the rows on screen, each a chip that removes it; Undo, Redo and Clear all. */
export function StepChips({ ops, onApply, withoutClean, withoutCleans, withoutLookup, canUndo, canRedo, onUndo, onRedo, origin, onEditCategories }: Props) {
  // Steps of one kind, usually from one click: three or more columns converted ("Convert"), or two or more
  // look-alike values merged in a column ("Merge all"). One chip for them, opened on demand.
  const [open, setOpen] = useState<string[]>([])
  const cleans = ops.clean ?? []
  const conversions = cleans.flatMap((c, i) => (isConversion(c) ? [i] : []))
  // A merge is a value replaced by another (one written two ways); replacing with nothing (N/A → empty) isn't.
  const isMerge = (c: (typeof cleans)[number]) => c.kind === 'replace' && !!c.to
  const merged = [...new Set(cleans.filter(isMerge).map((c) => c.column))].map((column) => ({
    column,
    indices: cleans.flatMap((c, i) => (isMerge(c) && c.column === column ? [i] : [])),
  }))
  const groups = [
    { key: 'convert', indices: conversions, min: 3, label: `${conversions.length} columns converted`, undo: `Undo all ${conversions.length} conversions`, regroup: 'Group conversions' },
    ...merged.map((m) => ({ key: `merge:${m.column}`, indices: m.indices, min: 2, label: `${m.column}: ${m.indices.length} values merged`, undo: `Undo all ${m.indices.length} merges in ${m.column}`, regroup: `Group ${m.column} merges` })),
  ].filter((g) => !!withoutCleans && g.indices.length >= g.min)
  const shut = groups.filter((g) => !open.includes(g.key))
  const inShut = new Set(shut.flatMap((g) => g.indices))
  return (
    <span className="op-chips">
      {origin && (
        <button className="origin-chip" onClick={(e) => thenKeepFocus(e, '.op-chips', origin.onBack)} title={`Back to ${origin.source}, with the steps it had`}>
          <Icon name="arrowLeft" size={13} /> {origin.label}, from {origin.source}
        </button>
      )}
      {/* In the order the steps apply: rows left out, columns cleaned, looked up and added, then filters, hidden columns and the sort. */}
      {ops.drop?.map((d, i) => (
        <button
          key={`drop:${i}`}
          className="op-chip"
          aria-label={removes(`without ${d.label}`)}
          onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, drop: ops.drop!.length > 1 ? ops.drop!.filter((_, j) => j !== i) : undefined }))}
          title="Show these rows again"
        >
          <Icon name="filter" size={14} /> Without {d.label}
          <Icon name="close" size={12} />
        </button>
      ))}
      {shut.map((g) => (
        // Clicking a summary shows what's in it; only its × undoes them all.
        <span key={g.key} className="op-chip op-chip-split">
          <button
            className="op-chip-main"
            aria-label={`${g.label}: show each`}
            onClick={(e) => thenKeepFocus(e, '.op-chips', () => setOpen([...open, g.key]))}
            title={`Show each · ${g.indices.map((i) => describeClean(cleans[i])).join(' · ')}`}
          >
            <Icon name="spark" size={14} /> {g.label}
            <Icon name="chevronDown" size={12} />
          </button>
          <button className="op-chip-x" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(withoutCleans!(g.indices)))} aria-label={g.undo} title="Undo all of them">
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      {ops.clean?.map((c, i) =>
        inShut.has(i) ? null : (
          <button
            key={`clean:${i}:${c.column}`}
            className="op-chip"
            aria-label={removes(describeClean(c))}
            onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(withoutClean(i)))}
            title={`Undo this cleaning · ${cleanExpr(c)}`}
          >
            <Icon name="spark" size={14} /> {describeClean(c)}
            <Icon name="close" size={12} />
          </button>
        ),
      )}
      {groups
        .filter((g) => open.includes(g.key))
        .map((g) => (
          <button key={g.key} className="link-btn op-group-toggle" onClick={(e) => thenKeepFocus(e, '.op-chips', () => setOpen(open.filter((k) => k !== g.key)))}>
            {g.regroup}
          </button>
        ))}
      {ops.lookups?.map((l, i) => (
        <button key={`lookup:${i}`} className="op-chip" aria-label={removes(describeLookup(l))} onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(withoutLookup(i)))} title="Remove these columns">
          <Icon name="link" size={14} /> {describeLookup(l)}
          <Icon name="close" size={12} />
        </button>
      ))}
      {ops.computed.map((c, i) => {
        const label = `${c.name}${c.note ? ` (${c.note})` : ''}`
        const remove = (e: { currentTarget: HTMLElement }) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, computed: ops.computed.filter((_, j) => j !== i) }))
        // Categories are rules to go back to (a word to add): the chip opens them, its × removes the column.
        return c.categorize && onEditCategories ? (
          <span key={c.name} className="op-chip op-chip-split">
            <button className="op-chip-main" aria-label={`Edit the categories in ${c.name}`} onClick={() => onEditCategories(c.name)} title="Edit the categories and their words">
              <Icon name="plus" size={14} /> {label}
            </button>
            <button className="op-chip-x" aria-label={removes(`${c.name} column`)} onClick={remove} title={`Remove column · ${c.name}`}>
              <Icon name="close" size={12} />
            </button>
          </span>
        ) : (
          <button key={c.name} className="op-chip" aria-label={removes(`${label} column`)} onClick={remove} title={`Remove column · ${c.expr}`}>
            <Icon name="plus" size={14} /> {label}
            <Icon name="close" size={12} />
          </button>
        )
      })}
      {ops.filters.map((f, i) => (
        <button
          key={i}
          className="op-chip"
          aria-label={removes(describeFilter(f))}
          onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, filters: ops.filters.filter((_, j) => j !== i) }))}
          title={`Remove filter · WHERE ${filterSql(f)}`}
        >
          <Icon name="filter" size={14} /> {describeFilter(f)}
          <Icon name="close" size={12} />
        </button>
      ))}
      {ops.search && (
        <button className="op-chip" aria-label={removes(`contains “${ops.search}”`)} onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, search: undefined }))} title="Remove search">
          <Icon name="search" size={14} /> Contains “{ops.search}”
          <Icon name="close" size={12} />
        </button>
      )}
      {ops.dedupe && (
        <button
          className="op-chip"
          aria-label={removes(ops.dedupe.mode === 'show' ? `duplicates in ${ops.dedupe.column}` : `first of each ${ops.dedupe.column}`)}
          onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, dedupe: undefined }))}
          title="Show all rows again"
        >
          <Icon name="copy" size={14} /> {ops.dedupe.mode === 'show' ? `Duplicates in ${ops.dedupe.column}` : `First of each ${ops.dedupe.column}`}
          <Icon name="close" size={12} />
        </button>
      )}
      {ops.hidden?.map((h) => (
        <button
          key={`hidden:${h}`}
          className="op-chip"
          aria-label={removes(`Hidden: ${h}`)}
          onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, hidden: ops.hidden!.length > 1 ? ops.hidden!.filter((x) => x !== h) : undefined }))}
          title={`Show this column again · EXCLUDE (${sqlName(h)})`}
        >
          <Icon name="column" size={14} /> Hidden: {h}
          <Icon name="close" size={12} />
        </button>
      ))}
      {ops.sort && (
        <button
          className="op-chip"
          aria-label={removes(`sorted by ${ops.sort.column}, ${ops.sort.dir === 'asc' ? 'ascending' : 'descending'}`)}
          onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply({ ...ops, sort: undefined }))}
          title={`Remove sort · ORDER BY ${sqlName(ops.sort.column)} ${ops.sort.dir.toUpperCase()}`}>
          <Icon name={ops.sort.dir === 'asc' ? 'sortAsc' : 'sortDesc'} size={14} /> {ops.sort.column}, {ops.sort.dir === 'asc' ? 'ascending' : 'descending'}
          <Icon name="close" size={12} />
        </button>
      )}
      {/* Kept in view at the row's end on a phone, however many steps scroll beside them. */}
      {(canUndo || canRedo || hasOps(ops)) && (
        <span className="op-actions">
          {/* Both stay while either can be used (dimmed when not): the last Undo doesn't take focus with it. */}
          {(canUndo || canRedo) && (
            <button className="link-btn" aria-disabled={!canUndo} onClick={() => canUndo && onUndo()} title={`Undo (${isMac ? '⌘' : 'Ctrl'}+Z)`}>
              Undo
            </button>
          )}
          {(canUndo || canRedo) && (
            <button className="link-btn" aria-disabled={!canRedo} onClick={() => canRedo && onRedo()} title={`Redo (${isMac ? '⌘⇧Z' : 'Ctrl+Shift+Z or Ctrl+Y'})`}>
              Redo
            </button>
          )}
          {hasOps(ops) && (
            <button className="link-btn" onClick={(e) => thenKeepFocus(e, '.op-chips', () => onApply(emptyOps()))}>
              Clear all
            </button>
          )}
        </span>
      )}
    </span>
  )
}
