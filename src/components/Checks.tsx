import { useState } from 'react'
import type { Check } from '../engine/checks'
import { Icon } from './Icon'

/** What each check is about, for the one line that says they passed. */
const ABOUT: Record<Check['kind'], string> = {
  totals: 'totals',
  balance: 'running balance',
  rollforward: 'opening to closing',
  continuity: 'carries on from last time',
  match: 'match',
  ids: 'tax IDs',
}

/**
 * What the checks found on these rows (the running balance, the total lines…), kept above the grid until
 * dismissed: a toast would be gone before a missing line is found. A failed check says where and by how
 * much; checks that passed fold into one line ("3 checks passed: totals, running balance…") until opened,
 * so the rows keep the room. What they found is said once to screen readers as it arrives, by a live region
 * of its own (always there, so the first is announced too): showing and folding them isn't news.
 */
export function Checks({ items, onDismiss }: { items: Check[]; onDismiss: () => void }) {
  const [open, setOpen] = useState(false)
  const notes = items.filter((c) => c.note)
  const passed = items.filter((c) => c.ok && !c.note)
  const failed = items.filter((c) => !c.ok && !c.note)
  const fold = passed.length >= 2 && !open
  const one = (c: Check) => (
    <span key={c.kind} className={`check ${c.note ? 'is-note' : c.ok ? 'is-ok' : 'is-off'}`}>
      <Icon name={c.note ? 'compare' : c.ok ? 'check' : 'alert'} size={14} />
      <span>
        <span className="sr-only">{c.note ? 'Found: ' : c.ok ? 'Check passed: ' : 'Check failed: '}</span>
        {c.text}
      </span>
    </span>
  )
  const said = [...notes, ...failed, ...passed].map((c) => `${c.note ? 'Found' : c.ok ? 'Check passed' : 'Check failed'}: ${c.text}`).join('. ')
  return (
    <>
      <p className="sr-only" role="status">
        {said}
      </p>
      <div className="checks" role={items.length ? 'group' : undefined} aria-label={items.length ? 'Checks on these rows' : undefined}>
        {notes.map(one)}
        {failed.map(one)}
        {fold ? (
          <span className="check is-ok">
            <Icon name="check" size={14} />
            <span>
              {passed.length} checks passed: {passed.map((c) => ABOUT[c.kind]).join(', ')}
            </span>
          </span>
        ) : (
          passed.map(one)
        )}
        {/* One button, there either way: focus stays on it as the checks open and fold. */}
        {passed.length >= 2 && (
          <button className="link-btn check-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Fold' : 'Show'}
          </button>
        )}
        {items.length > 0 && (
          <button className="icon-btn check-dismiss" aria-label="Dismiss the checks" title="Dismiss" onClick={onDismiss}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
    </>
  )
}
