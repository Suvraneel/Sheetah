import { useState } from 'react'
import { getThemePref, setThemePref, type ThemePref } from '../theme'
import { Icon, type IconName } from './Icon'

const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }
const ICON: Record<ThemePref, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' }
const NAME: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' }

/** One button that cycles System → Light → Dark; its icon shows the current choice. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [pref, setPref] = useState(getThemePref)
  return (
    <button
      type="button"
      className={`icon-pill ${className}`}
      aria-label={`Theme: ${NAME[pref]}. Switch to ${NAME[NEXT[pref]]}`}
      title={`Theme: ${NAME[pref]} (click for ${NAME[NEXT[pref]]})`}
      onClick={() => {
        const next = NEXT[pref]
        setThemePref(next)
        setPref(next)
      }}
    >
      <span className="icon-swap" key={pref}>
        <Icon name={ICON[pref]} size={16} />
      </span>
    </button>
  )
}
