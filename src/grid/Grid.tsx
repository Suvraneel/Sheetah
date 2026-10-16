import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ColumnInfo, Row } from '../engine/result'

/* ------------------------------------------------------------------------------------------
 * A canvas-rendered, virtualised grid.
 * - Only visible cells are drawn, every frame, on one <canvas>: no DOM per cell.
 * - Rows are fetched in 200-row chunks from DuckDB (by rowid) and kept in a small LRU cache.
 * - Browsers cap element height (~33M px), so beyond MAX_SCROLL the scrollbar maps
 *   proportionally onto the row space. 10M+ rows still scroll smoothly.
 * ---------------------------------------------------------------------------------------- */

export interface GridSource {
  key: number
  rowCount: number
  columns: ColumnInfo[]
  fetch(start: number, end: number): Promise<Row[]>
}

export interface CellPos {
  r: number
  c: number
}
export interface Selection {
  anchor: CellPos
  focus: CellPos
}
export interface SelectionInfo {
  r0: number
  r1: number
  c0: number
  c1: number
  active: CellPos
  value: string | null | undefined
}

export interface GridHandle {
  focus(): void
  scrollToTop(): void
}

interface Props {
  source: GridSource
  sort?: { column: string; dir: 'asc' | 'desc' }
  onHeaderClick?: (col: number, anchor: DOMRect) => void
  onSelection?: (info: SelectionInfo | null) => void
  onCopy?: (rows: number, cells: number) => void
}

const ROW_H = 30
const HEAD_H = 44
const PAD = 12
const CHUNK = 200
const MAX_CHUNKS = 300
const MAX_SCROLL = 8_000_000
const MIN_W = 64
const MAX_W = 420
const MONO = '"JetBrains Mono Variable", ui-monospace, monospace'
const SANS = '"Plus Jakarta Sans Variable", ui-sans-serif, system-ui, sans-serif'

interface Theme {
  bg: string
  text: string
  muted: string
  faint: string
  line: string
  head: string
  gutter: string
  hover: string
  select: string
  selectLine: string
  skeleton: string
  accent: string
}

function readTheme(el: HTMLElement): Theme {
  const s = getComputedStyle(el)
  const v = (n: string) => s.getPropertyValue(n).trim()
  return {
    bg: v('--grid-bg'),
    text: v('--text'),
    muted: v('--muted'),
    faint: v('--faint'),
    line: v('--grid-line'),
    head: v('--grid-head'),
    gutter: v('--grid-gutter'),
    hover: v('--grid-hover'),
    select: v('--grid-select'),
    selectLine: v('--accent'),
    skeleton: v('--grid-skeleton'),
    accent: v('--accent'),
  }
}

export const Grid = forwardRef<GridHandle, Props>(function Grid({ source, sort, onHeaderClick, onSelection, onCopy }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Mutable render state (kept out of React to avoid re-renders while scrolling).
  const st = useRef({
    widths: [] as number[],
    fitted: false,
    cache: new Map<number, Row[]>(),
    pending: new Set<number>(),
    lru: [] as number[],
    sel: null as Selection | null,
    hoverRow: -1,
    hoverCol: -1,
    charW: 7.8,
    viewW: 0,
    viewH: 0,
    theme: null as Theme | null,
    frame: 0,
    resizing: null as null | { col: number; startX: number; startW: number },
    dragging: false,
    sourceKey: -1,
  })
  // Accessibility: a visually hidden ARIA mirror of the cells currently on screen, so screen readers
  // can read the grid and follow the active cell via aria-activedescendant.
  const [mirror, setMirror] = useState({ first: 0, last: -1, c0: 0, c1: -1, tick: 0 })
  const mirrorRef = useRef(mirror)
  const [aria, setAria] = useState<{ active: CellPos | null; r0: number; r1: number; c0: number; c1: number }>({
    active: null,
    r0: -1,
    r1: -1,
    c0: -1,
    c1: -1,
  })
  const props = useRef({ source, sort, onHeaderClick, onSelection, onCopy })
  props.current = { source, sort, onHeaderClick, onSelection, onCopy }

  /* ----------------------------------- geometry ----------------------------------- */

  const gutterW = useCallback(() => Math.ceil(String(Math.max(1, props.current.source.rowCount)).length * st.current.charW + PAD * 2), [])

  const colX = useCallback((c: number) => {
    let x = 0
    const w = st.current.widths
    for (let i = 0; i < c; i++) x += w[i] ?? 120
    return x
  }, [])

  const totalW = useCallback(() => st.current.widths.reduce((a, b) => a + b, 0), [])

  /** Maps scrollTop to a virtual Y in row space (handles > MAX_SCROLL). */
  const virtualY = useCallback((scrollTop: number) => {
    const s = st.current
    const body = s.viewH - HEAD_H
    const total = props.current.source.rowCount * ROW_H
    if (total <= MAX_SCROLL) return scrollTop
    return (scrollTop * (total - body)) / (MAX_SCROLL - body)
  }, [])

  const scrollTopFor = useCallback((vy: number) => {
    const s = st.current
    const body = s.viewH - HEAD_H
    const total = props.current.source.rowCount * ROW_H
    if (total <= MAX_SCROLL) return vy
    return (vy * (MAX_SCROLL - body)) / (total - body)
  }, [])

  /* ------------------------------------ data ------------------------------------ */

  const requestDraw = useCallback(() => {
    if (st.current.frame) return
    st.current.frame = requestAnimationFrame(() => {
      st.current.frame = 0
      draw()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ensureChunk = useCallback(
    (chunk: number) => {
      const s = st.current
      const src = props.current.source
      if (s.cache.has(chunk) || s.pending.has(chunk)) return
      if (chunk < 0 || chunk * CHUNK >= src.rowCount) return
      if (s.pending.size >= 4) return // backpressure; the next frame will ask again
      s.pending.add(chunk)
      const key = src.key
      src
        .fetch(chunk * CHUNK, Math.min(src.rowCount, (chunk + 1) * CHUNK))
        .then((rows) => {
          if (st.current.sourceKey !== key) return
          s.cache.set(chunk, rows)
          s.lru.push(chunk)
          while (s.lru.length > MAX_CHUNKS) s.cache.delete(s.lru.shift()!)
          if (chunk === 0 && !s.fitted) autoFit(rows)
          const m = mirrorRef.current
          if (chunk * CHUNK <= m.last && (chunk + 1) * CHUNK > m.first) {
            mirrorRef.current = { ...m, tick: m.tick + 1 }
            setMirror(mirrorRef.current)
          }
          // The active cell's value may have just arrived.
          if (s.sel && Math.floor(s.sel.focus.r / CHUNK) === chunk) emitSelection()
        })
        .catch(() => {})
        .finally(() => {
          s.pending.delete(chunk)
          requestDraw()
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const cell = (r: number, c: number): string | null | undefined => {
    const rows = st.current.cache.get(Math.floor(r / CHUNK))
    return rows ? rows[r % CHUNK]?.[c] : undefined
  }

  const autoFit = (rows: Row[]) => {
    const s = st.current
    const cols = props.current.source.columns
    s.widths = cols.map((col, c) => {
      let len = Math.max(col.name.length + 2, col.type.length * 0.8)
      for (let i = 0; i < Math.min(rows.length, 120); i++) len = Math.max(len, (rows[i][c] ?? 'NULL').length)
      return Math.round(Math.min(MAX_W, Math.max(MIN_W + 16, len * s.charW + PAD * 2 + 8)))
    })
    s.fitted = true
    updateSpacer()
  }

  /* ----------------------------------- drawing ----------------------------------- */

  const updateSpacer = () => {
    const s = st.current
    const src = props.current.source
    if (!spacerRef.current) return
    const h = Math.min(src.rowCount * ROW_H, MAX_SCROLL) + HEAD_H
    spacerRef.current.style.height = `${h}px`
    spacerRef.current.style.width = `${gutterW() + totalW() + 40}px`
    void s
  }

  const truncate = (text: string, width: number) => {
    const max = Math.floor((width - PAD * 2) / st.current.charW)
    if (max <= 0) return ''
    const flat = text.length > 400 ? text.slice(0, 400) : text
    const one = flat.replace(/[\r\n\t]+/g, ' ')
    return one.length > max ? `${one.slice(0, Math.max(0, max - 1))}…` : one
  }

  const draw = () => {
    const canvas = canvasRef.current
    const scroller = scrollRef.current
    const s = st.current
    const t = s.theme
    if (!canvas || !scroller || !t) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const src = props.current.source
    const dpr = window.devicePixelRatio || 1
    const W = s.viewW
    const H = s.viewH
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = t.bg
    ctx.fillRect(0, 0, W, H)

    const gw = gutterW()
    const scrollLeft = scroller.scrollLeft
    const vy = virtualY(scroller.scrollTop)
    const first = Math.floor(vy / ROW_H)
    const offset = vy - first * ROW_H
    const visible = Math.ceil((H - HEAD_H) / ROW_H) + 1
    const last = Math.min(src.rowCount - 1, first + visible)

    // Fetch what's on screen first, then a chunk either side.
    const c0 = Math.floor(first / CHUNK)
    const c1 = Math.floor(Math.max(first, last) / CHUNK)
    for (let c = c0; c <= c1; c++) ensureChunk(c)
    ensureChunk(c1 + 1)
    ensureChunk(c0 - 1)

    // Visible columns
    const cols = src.columns
    const xs: { c: number; x: number; w: number }[] = []
    let x = gw - scrollLeft
    for (let c = 0; c < cols.length; c++) {
      const w = s.widths[c] ?? 120
      if (x + w > gw && x < W) xs.push({ c, x, w })
      x += w
    }
    const gridRight = Math.min(W, x)

    const mc0 = xs[0]?.c ?? 0
    const mc1 = xs.length ? xs[xs.length - 1].c : -1
    const m = mirrorRef.current
    if (m.first !== first || m.last !== last || m.c0 !== mc0 || m.c1 !== mc1) {
      mirrorRef.current = { first, last, c0: mc0, c1: mc1, tick: m.tick }
      setMirror(mirrorRef.current)
    }

    const sel = s.sel
    const r0 = sel ? Math.min(sel.anchor.r, sel.focus.r) : -1
    const r1 = sel ? Math.max(sel.anchor.r, sel.focus.r) : -1
    const sc0 = sel ? Math.min(sel.anchor.c, sel.focus.c) : -1
    const sc1 = sel ? Math.max(sel.anchor.c, sel.focus.c) : -1

    // Row backgrounds (hover, selection band)
    for (let r = first; r <= last; r++) {
      const y = HEAD_H + (r - first) * ROW_H - offset
      if (r === s.hoverRow) {
        ctx.fillStyle = t.hover
        ctx.fillRect(gw, y, gridRight - gw, ROW_H)
      }
    }
    if (sel) {
      const ya = HEAD_H + (r0 - first) * ROW_H - offset
      const yb = HEAD_H + (r1 + 1 - first) * ROW_H - offset
      const xa = gw + colX(sc0) - scrollLeft
      const xb = gw + colX(sc1 + 1) - scrollLeft
      ctx.fillStyle = t.select
      ctx.fillRect(Math.max(gw, xa), Math.max(HEAD_H, ya), Math.min(W, xb) - Math.max(gw, xa), Math.min(H, yb) - Math.max(HEAD_H, ya))
    }

    // Cells, one clip per column
    ctx.textBaseline = 'middle'
    ctx.font = `13px ${MONO}`
    for (const { c, x: cx, w } of xs) {
      const numeric = cols[c].numeric
      ctx.save()
      ctx.beginPath()
      ctx.rect(Math.max(cx, gw), HEAD_H, w - (cx < gw ? gw - cx : 0), H - HEAD_H)
      ctx.clip()
      for (let r = first; r <= last; r++) {
        const y = HEAD_H + (r - first) * ROW_H - offset
        const v = cell(r, c)
        if (v === undefined) {
          ctx.fillStyle = t.skeleton
          const bw = Math.min(w - PAD * 2, 24 + ((r * 7 + c * 13) % 5) * 14)
          roundRect(ctx, numeric ? cx + w - PAD - bw : cx + PAD, y + ROW_H / 2 - 4, bw, 8, 4)
          continue
        }
        if (v === null) {
          ctx.fillStyle = t.faint
          ctx.font = `italic 12px ${MONO}`
          ctx.textAlign = numeric ? 'right' : 'left'
          ctx.fillText('NULL', numeric ? cx + w - PAD : cx + PAD, y + ROW_H / 2 + 0.5)
          ctx.font = `13px ${MONO}`
          continue
        }
        ctx.fillStyle = t.text
        ctx.textAlign = numeric ? 'right' : 'left'
        ctx.fillText(truncate(v, w), numeric ? cx + w - PAD : cx + PAD, y + ROW_H / 2 + 0.5)
      }
      ctx.restore()
    }

    // Grid lines
    ctx.fillStyle = t.line
    for (let r = first; r <= last + 1; r++) {
      const y = Math.round(HEAD_H + (r - first) * ROW_H - offset) - 0.5
      if (y > HEAD_H) ctx.fillRect(gw, y, gridRight - gw, 1)
    }
    for (const { x: cx, w } of xs) {
      const lx = Math.round(cx + w) - 1
      if (lx > gw) ctx.fillRect(lx, HEAD_H, 1, H - HEAD_H)
    }

    // Selection outline + active cell
    if (sel) {
      const ya = HEAD_H + (r0 - first) * ROW_H - offset
      const yb = HEAD_H + (r1 + 1 - first) * ROW_H - offset
      const xa = gw + colX(sc0) - scrollLeft
      const xb = gw + colX(sc1 + 1) - scrollLeft
      ctx.save()
      ctx.beginPath()
      ctx.rect(gw, HEAD_H, W - gw, H - HEAD_H)
      ctx.clip()
      ctx.strokeStyle = t.selectLine
      ctx.lineWidth = 1.5
      ctx.strokeRect(xa + 0.75, ya + 0.75, xb - xa - 1.5, yb - ya - 1.5)
      const ax = gw + colX(sel.focus.c) - scrollLeft
      const ay = HEAD_H + (sel.focus.r - first) * ROW_H - offset
      ctx.lineWidth = 2
      ctx.strokeRect(ax + 1, ay + 1, (s.widths[sel.focus.c] ?? 120) - 2, ROW_H - 2)
      ctx.restore()
    }

    // Header
    ctx.fillStyle = t.head
    ctx.fillRect(0, 0, W, HEAD_H)
    const curSort = props.current.sort
    for (const { c, x: cx, w } of xs) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(Math.max(cx, gw), 0, w, HEAD_H)
      ctx.clip()
      const col = cols[c]
      const inSel = sel && c >= sc0 && c <= sc1
      if (c === s.hoverCol) {
        ctx.fillStyle = t.hover
        ctx.fillRect(cx, 0, w, HEAD_H)
      }
      ctx.textAlign = col.numeric ? 'right' : 'left'
      const tx = col.numeric ? cx + w - PAD : cx + PAD
      ctx.fillStyle = inSel ? t.accent : t.text
      ctx.font = `600 12.5px ${SANS}`
      let label = col.name
      const sorted = curSort?.column === col.name
      const arrow = sorted ? (curSort!.dir === 'asc' ? ' ↑' : ' ↓') : ''
      const maxW = w - PAD * 2
      while (label.length > 1 && ctx.measureText(label + arrow).width > maxW) label = label.slice(0, -2) + '…'
      ctx.fillText(label + arrow, tx, 17)
      ctx.fillStyle = t.faint
      ctx.font = `10.5px ${MONO}`
      ctx.fillText(truncate(col.type.toLowerCase(), w + 4), tx, 32)
      ctx.restore()
      ctx.fillStyle = t.line
      ctx.fillRect(Math.round(cx + w) - 1, 10, 1, HEAD_H - 20)
    }
    ctx.fillStyle = t.line
    ctx.fillRect(0, HEAD_H - 1, W, 1)

    // Gutter (row numbers)
    ctx.fillStyle = t.gutter
    ctx.fillRect(0, HEAD_H, gw, H - HEAD_H)
    ctx.font = `11.5px ${MONO}`
    ctx.textAlign = 'right'
    for (let r = first; r <= last; r++) {
      const y = HEAD_H + (r - first) * ROW_H - offset
      if (y + ROW_H < HEAD_H) continue
      const inSel = sel && r >= r0 && r <= r1
      ctx.fillStyle = inSel ? t.accent : t.faint
      ctx.fillText((r + 1).toLocaleString('en-US'), gw - PAD, y + ROW_H / 2 + 0.5)
    }
    ctx.fillStyle = t.head
    ctx.fillRect(0, 0, gw, HEAD_H)
    ctx.fillStyle = t.line
    ctx.fillRect(gw - 1, 0, 1, H)
    ctx.fillRect(0, HEAD_H - 1, gw, 1)
  }

  /* ------------------------------- selection helpers ------------------------------- */

  const emitSelection = () => {
    const s = st.current
    const cb = props.current.onSelection
    if (!cb) return
    if (!s.sel) return cb(null)
    const { anchor, focus } = s.sel
    cb({
      r0: Math.min(anchor.r, focus.r),
      r1: Math.max(anchor.r, focus.r),
      c0: Math.min(anchor.c, focus.c),
      c1: Math.max(anchor.c, focus.c),
      active: focus,
      value: cell(focus.r, focus.c),
    })
  }

  const setSel = (sel: Selection | null) => {
    st.current.sel = sel
    setAria(
      sel
        ? {
            active: sel.focus,
            r0: Math.min(sel.anchor.r, sel.focus.r),
            r1: Math.max(sel.anchor.r, sel.focus.r),
            c0: Math.min(sel.anchor.c, sel.focus.c),
            c1: Math.max(sel.anchor.c, sel.focus.c),
          }
        : { active: null, r0: -1, r1: -1, c0: -1, c1: -1 },
    )
    emitSelection()
    requestDraw()
  }

  const hit = (clientX: number, clientY: number) => {
    const scroller = scrollRef.current!
    const rect = scroller.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const gw = gutterW()
    const src = props.current.source
    let c = -1
    let border = -1
    if (x >= gw) {
      const gx = x - gw + scroller.scrollLeft
      let acc = 0
      for (let i = 0; i < src.columns.length; i++) {
        const w = st.current.widths[i] ?? 120
        if (Math.abs(gx - (acc + w)) <= 5) border = i
        if (gx >= acc && gx < acc + w) c = i
        acc += w
      }
    }
    let r = -1
    if (y >= HEAD_H) {
      const vy = virtualY(scroller.scrollTop) + (y - HEAD_H)
      r = Math.min(src.rowCount - 1, Math.floor(vy / ROW_H))
    }
    return { x, y, c, r, border, inHeader: y < HEAD_H, inGutter: x < gw }
  }

  const ensureVisible = (pos: CellPos) => {
    const scroller = scrollRef.current!
    const s = st.current
    const body = s.viewH - HEAD_H
    const vy = virtualY(scroller.scrollTop)
    const top = pos.r * ROW_H
    if (top < vy) scroller.scrollTop = scrollTopFor(top)
    else if (top + ROW_H > vy + body) scroller.scrollTop = scrollTopFor(top + ROW_H - body)
    const gw = gutterW()
    const left = colX(pos.c)
    const w = s.widths[pos.c] ?? 120
    if (left < scroller.scrollLeft) scroller.scrollLeft = left
    else if (left + w > scroller.scrollLeft + s.viewW - gw) scroller.scrollLeft = left + w - (s.viewW - gw)
  }

  const copySelection = async () => {
    const s = st.current
    const src = props.current.source
    if (!s.sel) return
    const r0 = Math.min(s.sel.anchor.r, s.sel.focus.r)
    const r1 = Math.min(Math.max(s.sel.anchor.r, s.sel.focus.r), r0 + 49_999)
    const c0 = Math.min(s.sel.anchor.c, s.sel.focus.c)
    const c1 = Math.max(s.sel.anchor.c, s.sel.focus.c)
    const rows = await src.fetch(r0, r1 + 1)
    const multi = r1 > r0 || c1 > c0
    const header = multi ? src.columns.slice(c0, c1 + 1).map((c) => c.name).join('\t') + '\n' : ''
    const body = rows.map((row) => row.slice(c0, c1 + 1).map((v) => (v ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n')
    await navigator.clipboard.writeText(header + body)
    props.current.onCopy?.(rows.length, rows.length * (c1 - c0 + 1))
  }

  /* ------------------------------------ events ------------------------------------ */

  useEffect(() => {
    const scroller = scrollRef.current!
    const onScroll = () => requestDraw()

    const onMove = (e: MouseEvent) => {
      const s = st.current
      if (s.resizing) return
      const h = hit(e.clientX, e.clientY)
      scroller.style.cursor = h.inHeader && h.border >= 0 ? 'col-resize' : h.inHeader && h.c >= 0 ? 'pointer' : 'cell'
      const hover = h.inHeader ? -1 : h.r
      const hoverCol = h.inHeader && h.border < 0 ? h.c : -1
      if (hover !== s.hoverRow || hoverCol !== s.hoverCol) {
        s.hoverRow = hover
        s.hoverCol = hoverCol
        requestDraw()
      }
      if (s.dragging && s.sel && h.r >= 0) {
        const c = h.c >= 0 ? h.c : s.sel.focus.c
        if (h.r !== s.sel.focus.r || c !== s.sel.focus.c) setSel({ anchor: s.sel.anchor, focus: { r: h.r, c } })
      }
    }
    const onLeave = () => {
      st.current.hoverRow = -1
      st.current.hoverCol = -1
      requestDraw()
    }
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const s = st.current
      const h = hit(e.clientX, e.clientY)
      const src = props.current.source
      if (h.inHeader) {
        if (h.border >= 0) {
          s.resizing = { col: h.border, startX: e.clientX, startW: s.widths[h.border] ?? 120 }
          e.preventDefault()
          return
        }
        if (h.c >= 0 && props.current.onHeaderClick) {
          const rect = scroller.getBoundingClientRect()
          const x = rect.left + gutterW() + colX(h.c) - scroller.scrollLeft
          props.current.onHeaderClick(h.c, new DOMRect(x, rect.top, s.widths[h.c] ?? 120, HEAD_H))
        }
        return
      }
      if (h.r < 0) return
      if (h.inGutter) {
        const anchor = e.shiftKey && s.sel ? s.sel.anchor : { r: h.r, c: 0 }
        setSel({ anchor: { r: anchor.r, c: 0 }, focus: { r: h.r, c: src.columns.length - 1 } })
        return
      }
      const c = h.c >= 0 ? h.c : src.columns.length - 1 // empty space right of the last column
      if (c < 0) return
      const pos = { r: h.r, c }
      setSel({ anchor: e.shiftKey && s.sel ? s.sel.anchor : pos, focus: pos })
      s.dragging = true
      scroller.focus({ preventScroll: true })
    }
    const onUp = () => {
      st.current.dragging = false
      st.current.resizing = null
    }
    const onWinMove = (e: MouseEvent) => {
      const s = st.current
      if (!s.resizing) return
      const w = Math.max(MIN_W, Math.min(1200, s.resizing.startW + e.clientX - s.resizing.startX))
      s.widths[s.resizing.col] = w
      updateSpacer()
      requestDraw()
    }
    const onDbl = (e: MouseEvent) => {
      const h = hit(e.clientX, e.clientY)
      const s = st.current
      if (h.inHeader && h.border >= 0) {
        // Fit column to the cached values on screen
        let len = props.current.source.columns[h.border].name.length + 2
        for (const rows of s.cache.values()) for (const row of rows.slice(0, 200)) len = Math.max(len, (row[h.border] ?? 'NULL').length)
        s.widths[h.border] = Math.round(Math.min(800, Math.max(MIN_W, len * s.charW + PAD * 2 + 8)))
        updateSpacer()
        requestDraw()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      const s = st.current
      const src = props.current.source
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void copySelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSel({ anchor: { r: 0, c: 0 }, focus: { r: src.rowCount - 1, c: src.columns.length - 1 } })
        return
      }
      // Alt+↓, Shift+F10 or the context-menu key opens the active column's menu.
      if (s.sel && ((e.altKey && e.key === 'ArrowDown') || (e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) {
        e.preventDefault()
        const c = s.sel.focus.c
        const rect = scroller.getBoundingClientRect()
        const x = rect.left + gutterW() + colX(c) - scroller.scrollLeft
        props.current.onHeaderClick?.(c, new DOMRect(x, rect.top, s.widths[c] ?? 120, HEAD_H))
        return
      }
      if (!s.sel) {
        if (!/^Arrow|^Page|^Home$|^End$/.test(e.key)) return
        s.sel = { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } }
      }
      const page = Math.max(1, Math.floor((s.viewH - HEAD_H) / ROW_H) - 1)
      let { r, c } = s.sel.focus
      switch (e.key) {
        case 'ArrowDown': r = mod ? src.rowCount - 1 : r + 1; break
        case 'ArrowUp': r = mod ? 0 : r - 1; break
        case 'ArrowRight': c = mod ? src.columns.length - 1 : c + 1; break
        case 'ArrowLeft': c = mod ? 0 : c - 1; break
        case 'PageDown': r += page; break
        case 'PageUp': r -= page; break
        case 'Home': if (mod) r = 0; c = 0; break
        case 'End': if (mod) r = src.rowCount - 1; c = src.columns.length - 1; break
        case 'Escape': setSel(null); return
        default: return
      }
      e.preventDefault()
      r = Math.max(0, Math.min(src.rowCount - 1, r))
      c = Math.max(0, Math.min(src.columns.length - 1, c))
      const focus = { r, c }
      setSel({ anchor: e.shiftKey ? s.sel.anchor : focus, focus })
      ensureVisible(focus)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('mousemove', onMove)
    scroller.addEventListener('mouseleave', onLeave)
    scroller.addEventListener('mousedown', onDown)
    scroller.addEventListener('dblclick', onDbl)
    scroller.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('mousemove', onWinMove)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('mousemove', onMove)
      scroller.removeEventListener('mouseleave', onLeave)
      scroller.removeEventListener('mousedown', onDown)
      scroller.removeEventListener('dblclick', onDbl)
      scroller.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('mousemove', onWinMove)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Size, DPR and theme
  useLayoutEffect(() => {
    const scroller = scrollRef.current!
    const canvas = canvasRef.current!
    const s = st.current
    const measure = () => {
      const dpr = window.devicePixelRatio || 1
      s.viewW = scroller.clientWidth
      s.viewH = scroller.clientHeight
      canvas.width = Math.round(s.viewW * dpr)
      canvas.height = Math.round(s.viewH * dpr)
      canvas.style.width = `${s.viewW}px`
      canvas.style.height = `${s.viewH}px`
      requestDraw()
    }
    const refreshTheme = () => {
      s.theme = readTheme(wrapRef.current!)
      requestDraw()
    }
    const ro = new ResizeObserver(measure)
    ro.observe(scroller)
    // The theme is a data-theme attribute on <html> (system default or the user's choice): repaint on change.
    const themeWatch = new MutationObserver(refreshTheme)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    refreshTheme()
    measure()
    void document.fonts.ready.then(() => {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.font = `13px ${MONO}`
        s.charW = ctx.measureText('0000000000').width / 10
      }
      updateSpacer()
      requestDraw()
    })
    return () => {
      ro.disconnect()
      themeWatch.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // New source: reset cache, widths and scroll
  useEffect(() => {
    const s = st.current
    s.sourceKey = source.key
    s.cache.clear()
    s.pending.clear()
    s.lru = []
    s.fitted = false
    s.widths = source.columns.map((c) => Math.round(Math.min(MAX_W, Math.max(MIN_W + 16, (c.name.length + 4) * s.charW + PAD * 2))))
    s.sel = null
    emitSelection()
    const scroller = scrollRef.current!
    scroller.scrollTop = 0
    scroller.scrollLeft = 0
    updateSpacer()
    requestDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.key])

  useEffect(() => requestDraw(), [sort, requestDraw])

  useImperativeHandle(ref, () => ({
    focus: () => scrollRef.current?.focus({ preventScroll: true }),
    scrollToTop: () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    },
  }))

  return (
    <div className="grid-wrap" ref={wrapRef}>
      <div
        className="grid-scroll"
        ref={scrollRef}
        tabIndex={0}
        id="results-grid"
        role="grid"
        aria-readonly="true"
        aria-multiselectable="true"
        aria-rowcount={source.rowCount + 1}
        aria-colcount={source.columns.length}
        aria-label={`Results: ${source.rowCount.toLocaleString('en-US')} rows, ${source.columns.length} columns`}
        aria-describedby="grid-help"
        aria-activedescendant={aria.active ? cellId(source.key, aria.active.r, aria.active.c) : undefined}
      >
        <div ref={spacerRef} className="grid-spacer" aria-hidden />
        <span id="grid-help" hidden>
          Arrow keys move between cells. Shift with arrows selects a range. Control or Command with C copies. Alt with Down
          arrow opens the column menu to sort, filter or profile.
        </span>
        <div className="sr-grid" role="rowgroup">
          <div role="row" aria-rowindex={1}>
            {mirror.c1 >= mirror.c0 &&
              source.columns.slice(mirror.c0, mirror.c1 + 1).map((col, i) => {
                const c = mirror.c0 + i
                const sorted = sort?.column === col.name ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                return (
                  <span key={c} role="columnheader" aria-colindex={c + 1} aria-sort={sorted}>
                    {col.name}, {col.type.toLowerCase()}
                  </span>
                )
              })}
          </div>
        </div>
        <div className="sr-grid" role="rowgroup">
          {mirror.last >= mirror.first &&
            Array.from({ length: mirror.last - mirror.first + 1 }, (_, i) => {
              const r = mirror.first + i
              return (
                <div key={r} role="row" aria-rowindex={r + 2}>
                  {Array.from({ length: Math.max(0, mirror.c1 - mirror.c0 + 1) }, (_, j) => {
                    const c = mirror.c0 + j
                    const v = cell(r, c)
                    const selected = r >= aria.r0 && r <= aria.r1 && c >= aria.c0 && c <= aria.c1
                    return (
                      <span key={c} id={cellId(source.key, r, c)} role="gridcell" aria-colindex={c + 1} aria-selected={selected}>
                        {v === undefined ? 'Loading' : v === null ? 'empty' : v}
                      </span>
                    )
                  })}
                </div>
              )
            })}
        </div>
      </div>
      <canvas ref={canvasRef} className="grid-canvas" aria-hidden />
    </div>
  )
})

const cellId = (key: number, r: number, c: number) => `qc-${key}-${r}-${c}`

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(0, w), h, r)
  ctx.fill()
}
