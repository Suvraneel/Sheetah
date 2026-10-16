import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EDITOR_MIN, clampEditor, editorMax } from './editorSize'

const STEP = 24 // about one line

/**
 * Splitter between the SQL editor and the results (WAI-ARIA window splitter). Unpinned, the editor
 * fits the query being edited; dragging or the arrow keys pin a height; double-click or Enter goes
 * back to fitting.
 */
export function EditorResizer({
  height,
  onChange,
  target,
  controls,
}: {
  height: number | null
  onChange: (h: number | null) => void
  /** The element whose rendered height is the editor's (observed for aria-valuenow). */
  target: () => Element | null | undefined
  controls: string
}) {
  const drag = useRef<{ y: number; h: number } | null>(null)
  const [rendered, setRendered] = useState(EDITOR_MIN)
  const [max, setMax] = useState(editorMax)

  useLayoutEffect(() => {
    const el = target()
    if (!el) return
    const ro = new ResizeObserver(() => setRendered(Math.round(el.getBoundingClientRect().height)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [target])

  // A pinned height must still fit after the window shrinks.
  useEffect(() => {
    const fit = () => {
      setMax(editorMax())
      if (height && height > editorMax()) onChange(editorMax())
    }
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [height, onChange])

  const current = () => height ?? rendered

  return (
    <div
      className="editor-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize SQL editor"
      aria-controls={controls}
      aria-valuemin={EDITOR_MIN}
      aria-valuemax={max}
      aria-valuenow={Math.min(max, current())}
      tabIndex={0}
      title="Drag to resize. Double-click to fit the query."
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { y: e.clientY, h: current() }
      }}
      onPointerMove={(e) => {
        if (drag.current) onChange(clampEditor(drag.current.h + e.clientY - drag.current.y))
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(e) => {
        const by = e.shiftKey ? STEP * 3 : STEP
        const set = (h: number | null) => {
          e.preventDefault()
          onChange(h)
        }
        if (e.key === 'ArrowDown') set(clampEditor(current() + by))
        else if (e.key === 'ArrowUp') set(clampEditor(current() - by))
        else if (e.key === 'Home') set(EDITOR_MIN)
        else if (e.key === 'End') set(editorMax())
        else if (e.key === 'Enter') set(null)
      }}
    />
  )
}
