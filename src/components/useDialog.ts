import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Modal dialog behaviour: traps Tab inside the dialog, closes on Escape, and returns focus to
 * whatever was focused before it opened.
 */
export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  // Captured during the first render, before autoFocus moves focus into the dialog.
  const [previous] = useState(() => (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null))
  const restore = useRef(0)

  useEffect(() => {
    // A re-run (StrictMode remount) must cancel the focus hand-back the previous cleanup scheduled.
    cancelAnimationFrame(restore.current)
    const el = ref.current
    const focusables = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, a[href], [tabindex]:not([tabindex="-1"])') ?? [],
      )
    // A dialog that is mostly reading (shortcuts) starts on its heading ([data-autofocus]), not a button below the fold.
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0])?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      // Focus on something outside the list (a heading the dialog started on): Tab stays inside.
      if (!items.includes(document.activeElement as HTMLElement)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const back = previous
      // Defer so the dialog has unmounted before focus moves back.
      restore.current = requestAnimationFrame(() => back?.focus?.({ preventScroll: true }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return ref
}
