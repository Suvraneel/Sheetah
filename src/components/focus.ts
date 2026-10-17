/**
 * After an action removes the control that had focus (a suggestion that's been taken, a step removed,
 * the landing page replaced by the workspace), focus would drop to the page itself and a keyboard user
 * would start over from the top. It goes to the control now in that place in the group, else a fallback.
 */
export function keepFocusIn(group: Element | null, index: number, fallback: () => HTMLElement | null = () => document.querySelector<HTMLElement>('.grid-scroll')) {
  // A few frames at most: what takes focus may still be rendering (the grid, after the landing page).
  const attempt = (left: number) =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      const items = group?.isConnected ? [...group.querySelectorAll<HTMLElement>('button:not([disabled])')] : []
      const target = items[Math.min(index, items.length - 1)] ?? fallback()
      if (target) target.focus()
      else if (left > 0) attempt(left - 1)
    })
  attempt(10)
}

/** Runs a click's action, then keeps focus in the clicked control's group (see keepFocusIn). */
export function thenKeepFocus(e: { currentTarget: HTMLElement }, groupSelector: string, action: () => void) {
  const group = e.currentTarget.closest(groupSelector)
  const index = group ? [...group.querySelectorAll('button')].indexOf(e.currentTarget as HTMLButtonElement) : 0
  action()
  keepFocusIn(group, Math.max(0, index))
}
