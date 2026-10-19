import { useEffect, useRef } from 'react'
import type { Figure } from '../hairline/types'

/*
 * A Hairline figure: a line drawing that answers the pointer, with its read-out (a line of SQL) under it.
 * The engine and the figure load after the page, as their own chunk. The figure draws in a 400 × 320 box;
 * the CSS shows only the band its poses stay inside (x 16..384, y 76..254), keeping the stage at full size
 * so the engine's pointer mapping stays exact. Decorative: hidden from assistive tech, like the sketches.
 */
export function HairlineFigure({
  load,
  className = '',
  tourOnce = false,
  hideWhen,
}: {
  load: () => Promise<{ default: Figure }>
  className?: string
  /** Walk the figure's tour once, the first time most of it is in view, then wait for a hand. */
  tourOnce?: boolean
  /** The media query under which CSS hides the figure: it isn't loaded while that holds, and loads once it stops. */
  hideWhen?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const readRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const stage = stageRef.current
    const out = readRef.current
    if (!root || !stage || !out) return
    let gone = false
    let cleanup = () => {}
    const start = () => Promise.all([load(), import('../hairline/kernel.js')])
      .then(([{ default: figure }, { default: HL }]) => {
        if (gone) return
        HL.inject(document)
        stage.dataset.hairline = figure.name
        const svg = HL.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, stage)
        let text: string | null = null
        const read = {
          get textContent() {
            return text
          },
          set textContent(v: string | null) {
            text = v ?? ''
            const on = text !== '' && text !== 'rest'
            if (on) out.textContent = text
            out.classList.toggle('is-on', on)
          },
        }
        const handle = figure.mount({ stage, svg, read }, figure.range[1])

        let tour: { stop(): void } | null = null
        let timer = 0
        // A real hand ends the tour for good (the engine would walk it again after the hand leaves).
        let touched = false
        const onEnter = () => {
          touched = true
          tour?.stop()
        }
        stage.addEventListener('pointerenter', onEnter)
        const stops = figure.tour
        const io =
          tourOnce && stops
            ? new IntersectionObserver(
                (entries) => {
                  if (!entries.some((e) => e.isIntersecting)) return
                  io?.disconnect()
                  timer = window.setTimeout(() => {
                    if (!touched) tour = HL.tour(stage, stops, (i) => i === stops.length - 1 && tour?.stop())
                  }, 900)
                },
                { threshold: 0.6 },
              )
            : null
        // the band, not the stage: the band crops the stage, so most of the stage is never "in view"
        io?.observe(root)

        cleanup = () => {
          io?.disconnect()
          clearTimeout(timer)
          stage.removeEventListener('pointerenter', onEnter)
          tour?.stop()
          handle.destroy()
          svg.remove()
          delete stage.dataset.hairline
        }
      })
      // Decorative: if the chunk can't load (offline before it was cached), the space just stays empty.
      .catch(() => {})
    // Hidden at this width: wait until the window widens (or the tablet turns) before loading anything.
    const mq = hideWhen ? matchMedia(hideWhen) : null
    const onChange = () => {
      if (mq?.matches) return
      mq?.removeEventListener('change', onChange)
      void start()
    }
    if (mq?.matches) mq.addEventListener('change', onChange)
    else void start()
    return () => {
      gone = true
      mq?.removeEventListener('change', onChange)
      cleanup()
    }
  }, [load, tourOnce, hideWhen])

  return (
    <div className={`hfig ${className}`} ref={rootRef} aria-hidden>
      <div className="hfig-band">
        <div className="hfig-stage" ref={stageRef} />
      </div>
      <span className="hfig-read" ref={readRef} />
    </div>
  )
}
