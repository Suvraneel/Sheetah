import { Icon } from './Icon'
import type { Starter } from './starters'

/** A row of one-click example queries, shown while the sample data is open. */
export function StarterQueries({
  starters,
  current,
  disabled,
  onRun,
  onDismiss,
}: {
  starters: Starter[]
  current: string
  disabled: boolean
  onRun: (s: Starter) => void
  onDismiss: () => void
}) {
  return (
    <nav className="starters" aria-label="Example queries">
      <span className="starters-label">
        <Icon name="spark" size={14} /> Try
      </span>
      <ul>
        {starters.map((s) => (
          <li key={s.label}>
            <button
              className={`starter${current.trim() === s.sql ? ' is-on' : ''}`}
              aria-current={current.trim() === s.sql ? 'true' : undefined}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (!disabled) onRun(s)
              }}
              title={s.sql}
            >
              {s.chart && <Icon name="stats" size={13} />}
              {s.label}
            </button>
          </li>
        ))}
      </ul>
      <button className="starters-close" aria-label="Hide example queries" title="Hide example queries" onClick={onDismiss}>
        <Icon name="close" size={14} />
      </button>
    </nav>
  )
}
