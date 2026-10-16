/** Colour theme preference; applied by public/theme.js (which also runs before first paint). */
export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_KEY = 'sheetah:theme'

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    const v = document.documentElement.dataset.themePref
    return v === 'light' || v === 'dark' ? v : 'system'
  }
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    // Storage blocked: remember it for this page, where theme.js looks next.
    document.documentElement.dataset.themePref = pref
  }
  window.dispatchEvent(new Event('sheetah:theme'))
}
