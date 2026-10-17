import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LOCALE } from '../engine/sql'
import { fmt, type Point } from '../engine/chart'

/*
 * One small SVG chart for three jobs: compare groups (horizontal bars), trend over time (line + wash),
 * distribution (histogram). One series, one axis, so no legend: the title names the measure.
 * Thin marks, 4px rounded data-ends, 2px surface gaps, hairline grid, text in text tokens.
 * Every value is reachable without hover: keyboard arrows drive the same tooltip, and a hidden table
 * mirrors the data for screen readers ("Open as query" is the visible table view).
 */
interface Props {
  kind: 'bar' | 'line' | 'hist'
  points: Point[]
  /** Accessible name and table caption. */
  label: string
  valueName: string
  bucket?: string
  compact?: boolean
}

const exact = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min]
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}

function niceDomain(values: number[]): [number, number] {
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  if (lo === hi) return [0, 1]
  const t = niceTicks(lo, hi, 4)
  const step = t.length > 1 ? t[1] - t[0] : 1
  return [lo < 0 ? Math.floor(lo / step) * step : 0, hi > 0 ? Math.ceil(hi / step) * step : 0]
}

const parseTime = (label: string) => Date.parse(label.length > 10 ? label.replace(' ', 'T') + ':00Z' : label + 'T00:00:00Z')

function timeFormat(bucket?: string) {
  if (bucket === 'year') return (t: number) => String(new Date(t).getUTCFullYear())
  if (bucket === 'quarter') return (t: number) => `Q${Math.floor(new Date(t).getUTCMonth() / 3) + 1} ${new Date(t).getUTCFullYear()}`
  const opts: Intl.DateTimeFormatOptions =
    bucket === 'month' ? { month: 'short', year: 'numeric' } : bucket === 'hour' ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric' }
  const f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' })
  return (t: number) => f.format(t)
}

/** Horizontal bar from base to end with only the data end rounded. */
function hBar(base: number, end: number, y: number, h: number) {
  const len = Math.abs(end - base)
  const r = Math.min(4, len, h / 2)
  const d = end >= base ? 1 : -1
  const sweep = d > 0 ? 1 : 0
  return `M${base},${y}H${end - d * r}A${r},${r} 0 0 ${sweep} ${end},${y + r}V${y + h - r}A${r},${r} 0 0 ${sweep} ${end - d * r},${y + h}H${base}Z`
}

/** Vertical column from the baseline up, top corners rounded. */
function vBar(x: number, w: number, base: number, top: number) {
  const r = Math.min(4, w / 2, base - top)
  return `M${x},${base}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${top + r}V${base}Z`
}

export function Chart({ kind, points, label, valueName, bucket, compact }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<{ points: Point[]; i: number } | null>(null)
  const active = hover && hover.points === points ? hover.i : null // new data clears the hover
  const setActive = (next: number | null | ((a: number | null) => number | null)) => {
    const i = typeof next === 'function' ? next(active) : next
    setHover(i === null ? null : { points, i })
  }

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const values = useMemo(() => points.map((p) => p.value), [points])
  const [d0, d1] = useMemo(() => niceDomain(values), [values])
  const ticks = useMemo(() => niceTicks(d0, d1, compact ? 2 : 4), [d0, d1, compact])
  const times = useMemo(() => (kind === 'line' ? points.map((p) => parseTime(p.label)) : []), [kind, points])
  const tf = useMemo(() => timeFormat(bucket), [bucket])

  // Layout
  const rowH = 28
  const barH = 18
  const labelW = kind === 'bar' ? Math.min(180, Math.max(80, width * 0.28)) : 0
  const m =
    kind === 'bar'
      ? { l: labelW + 12, r: 64, t: 4, b: 26 }
      : compact
        ? { l: 2, r: 2, t: 6, b: 18 }
        : { l: 52, r: kind === 'line' ? 72 : 16, t: 16, b: 30 }
  const height = kind === 'bar' ? points.length * rowH + m.t + m.b : compact ? 88 : 300
  const iw = Math.max(0, width - m.l - m.r)
  const ih = height - m.t - m.b

  const sv = (v: number) => (kind === 'bar' ? m.l + ((v - d0) / (d1 - d0)) * iw : m.t + ih - ((v - d0) / (d1 - d0)) * ih)
  const t0 = times.length ? Math.min(...times) : 0
  const t1 = times.length ? Math.max(...times) : 1
  const sx = (t: number) => m.l + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw)
  const band = kind === 'hist' ? iw / Math.max(1, points.length) : 0

  const pointer = (e: React.PointerEvent) => {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    let i: number
    if (kind === 'bar') i = Math.floor((y - m.t) / rowH)
    else if (kind === 'hist') i = Math.floor((x - m.l) / band)
    else {
      let best = 0
      for (let k = 1; k < times.length; k++) if (Math.abs(sx(times[k]) - x) < Math.abs(sx(times[best]) - x)) best = k
      i = best
    }
    setActive(i >= 0 && i < points.length ? i : null)
  }
  const key = (e: React.KeyboardEvent) => {
    const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (next) {
      e.preventDefault()
      setActive((a) => (a === null ? 0 : Math.max(0, Math.min(points.length - 1, a + next))))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setActive(e.key === 'Home' ? 0 : points.length - 1)
    } else if (e.key === 'Escape') setActive(null)
  }

  const peak = values.length ? values.indexOf(Math.max(...values)) : -1
  const pointLabel = (p: Point, i: number) => (kind === 'line' ? tf(times[i]) : p.label)

  // Tooltip anchor
  let tip: { x: number; y: number } | null = null
  if (active !== null && points[active]) {
    const p = points[active]
    if (kind === 'bar') tip = { x: Math.max(sv(p.value), sv(0)), y: m.t + active * rowH + rowH / 2 }
    else if (kind === 'hist') tip = { x: m.l + band * (active + 0.5), y: sv(p.value) }
    else tip = { x: sx(times[active]), y: sv(p.value) }
  }

  const linePath = kind === 'line' ? points.map((p, i) => `${i ? 'L' : 'M'}${sx(times[i])},${sv(p.value)}`).join('') : ''
  const areaPath = kind === 'line' && points.length > 1 ? `${linePath}L${sx(times[times.length - 1])},${sv(0)}L${sx(times[0])},${sv(0)}Z` : ''
  // As many x labels as fit the plot width (month labels like "Sep 2024" need the most room), up to 6.
  const tickN = Math.min(6, points.length, Math.max(2, Math.floor(iw / (bucket === 'month' || bucket === 'quarter' ? 68 : bucket === 'hour' || bucket === 'year' ? 44 : 52))))
  const xTickIdx = kind === 'line' ? Array.from(new Set(Array.from({ length: tickN }, (_, k) => Math.round((k * (points.length - 1)) / Math.max(1, tickN - 1))))) : []

  return (
    <div className={`chart${compact ? ' chart-compact' : ''}`} ref={wrap}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${label}. ${points.length} ${kind === 'line' ? 'points' : kind === 'hist' ? 'bins' : 'bars'}. Use arrow keys to read values.`}
          tabIndex={0}
          onPointerMove={pointer}
          onPointerLeave={() => setActive(null)}
          onKeyDown={key}
          onBlur={() => setActive(null)}
        >
          {/* Value gridlines (hairline, recessive) */}
          {!compact &&
            ticks.map((t) =>
              kind === 'bar' ? (
                <g key={t}>
                  <line className="chart-grid" x1={sv(t)} x2={sv(t)} y1={m.t} y2={height - m.b} />
                  <text className="chart-tick" x={sv(t)} y={height - 8} textAnchor="middle">
                    {fmt(t)}
                  </text>
                </g>
              ) : (
                <g key={t}>
                  <line className="chart-grid" x1={m.l} x2={width - m.r} y1={sv(t)} y2={sv(t)} />
                  <text className="chart-tick" x={m.l - 8} y={sv(t) + 4} textAnchor="end">
                    {fmt(t)}
                  </text>
                </g>
              ),
            )}

          {kind === 'bar' &&
            points.map((p, i) => {
              const y = m.t + i * rowH + (rowH - barH) / 2
              const end = sv(p.value)
              return (
                <g key={i} className={active === i ? 'is-active' : undefined}>
                  <text className="chart-cat" x={labelW} y={y + barH / 2 + 4} textAnchor="end">
                    {p.label.length > 26 ? `${p.label.slice(0, 25)}…` : p.label}
                  </text>
                  <path className="chart-mark" d={hBar(sv(0), end, y, barH)} />
                  {(i === peak || active === i) && (
                    <text className="chart-value" x={Math.max(end, sv(0)) + 6} y={y + barH / 2 + 4}>
                      {fmt(p.value)}
                    </text>
                  )}
                </g>
              )
            })}

          {kind === 'hist' &&
            points.map((p, i) => (
              <path
                key={i}
                className={`chart-mark${active === i ? ' is-active' : ''}`}
                d={p.value > 0 ? vBar(m.l + band * i + 1, Math.max(1, band - 2), sv(0), sv(p.value)) : ''}
              />
            ))}

          {kind === 'line' && (
            <>
              {areaPath && <path className="chart-wash" d={areaPath} />}
              <path className="chart-line" d={linePath} />
              {active !== null && <line className="chart-cross" x1={sx(times[active])} x2={sx(times[active])} y1={m.t} y2={m.t + ih} />}
              {points.length > 0 && (
                <>
                  <circle className="chart-dot" cx={sx(times[times.length - 1])} cy={sv(values[values.length - 1])} r={4} />
                  <text className="chart-value" x={sx(times[times.length - 1]) + 8} y={sv(values[values.length - 1]) + 4}>
                    {fmt(values[values.length - 1])}
                  </text>
                </>
              )}
              {active !== null && <circle className="chart-dot" cx={sx(times[active])} cy={sv(values[active])} r={4} />}
              {xTickIdx.map((i) => (
                <text key={i} className="chart-tick" x={sx(times[i])} y={height - 10} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
                  {tf(times[i])}
                </text>
              ))}
            </>
          )}

          {kind === 'hist' && points.length > 0 && (
            <>
              <line className="chart-axis" x1={m.l} x2={width - m.r} y1={sv(0)} y2={sv(0)} />
              <text className="chart-tick" x={m.l} y={height - (compact ? 4 : 10)} textAnchor="start">
                {fmt(points[0].lo ?? 0)}
              </text>
              <text className="chart-tick" x={width - m.r} y={height - (compact ? 4 : 10)} textAnchor="end">
                {fmt(points[points.length - 1].hi ?? 0)}
              </text>
            </>
          )}
          {kind === 'bar' && <line className="chart-axis" x1={sv(0)} x2={sv(0)} y1={m.t} y2={height - m.b} />}
        </svg>
      )}

      {tip && active !== null && (
        <div
          className="chart-tip"
          role="status"
          style={{
            left: Math.min(Math.max(tip.x, 70), width - 70),
            top: tip.y,
            transform: kind === 'bar' ? 'translate(12px, -50%)' : 'translate(-50%, calc(-100% - 12px))',
          }}
        >
          <span>{pointLabel(points[active], active)}</span>
          <b>
            {exact.format(points[active].value)} {kind === 'hist' ? 'rows' : ''}
          </b>
        </div>
      )}

      {/* Hidden data table for screen readers. The wrapper is what is visually hidden: a table ignores
          height limits, so a 1px "sr-only" table still lays out every row and props up scroll areas. */}
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{kind === 'line' ? (bucket ?? 'time') : kind === 'hist' ? 'range' : 'group'}</th>
              <th scope="col">{valueName}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <td>{pointLabel(p, i)}</td>
                <td>{exact.format(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
