/**
 * After an action removes the control that had focus (a suggestion that's been taken, a step removed,
 * the landing page replaced by the workspace), focus would drop to the page itself and a keyboard user
 * would start over from the top. It goes to the control now in that place in the group, else a fallback.
 */
export function keepFocusIn(group: Element | null, index: number, fallback: () => HTMLElement | null = () => document.querySelector<HTMLElement>('.grid-scroll')) {
  // Watched for about a second: what takes focus may still be rendering (the grid, after the landing page),
  // and the group can render again once the action's query is back (the chip that had focus replaced),
  // dropping focus a second time.
  const group0 = group
  // Until the person does something else: a click on the page, or a key, is theirs to decide where focus goes.
  let theirs = false
  const mine = () => (theirs = true)
  document.addEventListener('pointerdown', mine, { capture: true, once: true })
  document.addEventListener('keydown', mine, { capture: true, once: true })
  const attempt = (left: number) =>
    requestAnimationFrame(() => {
      if (theirs) return done()
      const active = document.activeElement
      if (!active || active === document.body || !active.isConnected) {
        // The group itself, or the one rendered in its place (same classes).
        const g = group0?.isConnected ? group0 : group0?.classList.length ? document.querySelector(`.${[...group0.classList].map((c) => CSS.escape(c)).join('.')}`) : null
        const items = g ? [...g.querySelectorAll<HTMLElement>('button:not([disabled])')] : []
        const target = items[Math.min(index, items.length - 1)] ?? fallback()
        target?.focus()
      }
      if (left > 0) attempt(left - 1)
      else done()
    })
  const done = () => {
    document.removeEventListener('pointerdown', mine, { capture: true })
    document.removeEventListener('keydown', mine, { capture: true })
  }
  attempt(60)
}

/** Runs a click's action, then keeps focus in the clicked control's group (see keepFocusIn); returns where it was. */
export function thenKeepFocus(e: { currentTarget: HTMLElement }, groupSelector: string, action: () => void, fallback?: () => HTMLElement | null): number {
  const group = e.currentTarget.closest(groupSelector)
  const index = Math.max(0, group ? [...group.querySelectorAll('button')].indexOf(e.currentTarget as HTMLButtonElement) : 0)
  action()
  keepFocusIn(group, index, fallback)
  return index
}
