import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react'

/*
 * Heavy fade-up on first entry into the viewport. One shared IntersectionObserver (no scroll
 * listeners); when an element appears, everything before it is revealed too, so content skipped by
 * a fast scroll never stays hidden.
 */
const pending = new Map<Element, () => void>()
let observer: IntersectionObserver | null = null

function reveal(el: Element) {
  for (const [other, show] of pending) {
    if (other === el || other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
      show()
      pending.delete(other)
      observer?.unobserve(other)
    }
  }
}

export function Reveal({
  as: Tag = 'div',
  delay = 0,
  className = '',
  children,
}: {
  as?: ElementType
  delay?: number
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return setShown(true)
    observer ??= new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && reveal(e.target)), {
      rootMargin: '0px 0px -6% 0px',
      threshold: 0.04,
    })
    pending.set(el, () => setShown(true))
    observer.observe(el)
    return () => {
      pending.delete(el)
      observer?.unobserve(el)
    }
  }, [])

  return (
    <Tag ref={ref} className={`reveal${shown ? ' is-in' : ''} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  )
}
