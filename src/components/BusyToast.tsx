import { useEffect, useState } from 'react'

interface Props {
  label: string
  onCancel?: (() => void) | null
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "Reading sales.csv · 0:41 · Cancel": long work shows that it's alive, and can be stopped. */
export function BusyToast({ label, onCancel }: Props) {
  const [started] = useState(() => Date.now())
  const [now, setNow] = useState(started)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const elapsed = now - started
  return (
    <p className="toast toast-busy" role="status">
      <span className="spinner" aria-hidden /> <span className="toast-text">{label}</span>
      {elapsed >= 2000 && (
        <span className="toast-clock mono" aria-hidden>
          {clock(elapsed)}
        </span>
      )}
      {onCancel && (
        <button className="toast-action" onClick={onCancel}>
          Cancel
        </button>
      )}
    </p>
  )
}
