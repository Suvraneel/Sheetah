import type { Check } from '../engine/checks'
import { Icon } from './Icon'

/**
 * What the checks found on these rows (the running balance, the total lines), kept above the grid until
 * dismissed: a toast would be gone before a missing line is found. Passed checks are quiet; a failed one
 * says where and by how much. The region is always there (empty when there's nothing to say), so screen
 * readers announce a check when it arrives.
 */
export function Checks({ items, onDismiss }: { items: Check[]; onDismiss: () => void }) {
  return (
    <div className="checks" role="status" aria-label="Checks on these rows">
      {items.map((c) => (
        <span key={c.kind} className={`check ${c.ok ? 'is-ok' : 'is-off'}`}>
          <Icon name={c.ok ? 'check' : 'alert'} size={14} />
          <span>
            <span className="sr-only">{c.ok ? 'Check passed: ' : 'Check failed: '}</span>
            {c.text}
          </span>
        </span>
      ))}
      {items.length > 0 && (
        <button className="icon-btn check-dismiss" aria-label="Dismiss the checks" title="Dismiss" onClick={onDismiss}>
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  )
}
