import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LOCALE } from '../engine/sql'
import { fmt, type Point } from '../engine/chart'

/*
 * One small SVG chart for three jobs: compare groups (horizontal bars), trend over time (line + wash),
 * distribution (histogram). One series needs no legend (the title names the measure); a split adds a
 * legend, a line per series, and bars in parts (or side by side when the parts don't add up).
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
  /** A split: each series' name; the last is the rest put together when `other`. Points carry `values`. */
  series?: string[]
  other?: boolean
  stacked?: boolean
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

/** A series' color: the palette in order, the rest put together in grey. */
const seriesClass = (i: number, series: string[], other?: boolean) => (other && i === series.length - 1 ? 'viz-other' : `viz-s${i}`)

/** A series' sample in the legend and the tooltip: a stretch of its line (dashed as it is), or a square of its bar. */
function Swatch({ kind, cls }: { kind: Props['kind']; cls: string }) {
  return (
    <svg className="chart-swatch" width={kind === 'line' ? 16 : 10} height={10} aria-hidden>
      {kind === 'line' ? <line className={`chart-line ${cls}`} x1={1} x2={15} y1={5} y2={5} /> : <rect className={`chart-key ${cls}`} width={10} height={10} rx={3} />}
    </svg>
  )
}

/** A bar's part from x0 to x1, its end rounded when it's the last. */
const segment = (x0: number, x1: number, y: number, h: number, last: boolean) => (last ? hBar(x0, x1, y, h) : `M${x0},${y}H${x1}V${y + h}H${x0}Z`)

export function Chart({ kind, points, label, valueName, bucket, compact, series, other, stacked }: Props) {
  const multi = !!series?.length && kind !== 'hist' && points.every((p) => p.values?.length === series.length)
  const names = multi ? series! : []
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

  const values = useMemo(() => points.map((p) => (multi && stacked ? p.values!.reduce<number>((a, v) => a + (v ?? 0), 0) : p.value)), [points, multi, stacked])
  // The axis spans what is drawn: each series' values, or the bars' totals when they're in parts.
  const drawn = useMemo(() => (multi && !stacked ? points.flatMap((p) => p.values!.filter((v): v is number => v !== null)) : values), [multi, stacked, points, values])
  const [d0, d1] = useMemo(() => niceDomain(drawn), [drawn])
  const ticks = useMemo(() => niceTicks(d0, d1, compact ? 2 : 4), [d0, d1, compact])
  const times = useMemo(() => (kind === 'line' ? points.map((p) => parseTime(p.label)) : []), [kind, points])
  const tf = useMemo(() => timeFormat(bucket), [bucket])

  // Layout (bars side by side get a row tall enough for each)
  const sideBySide = multi && !stacked && kind === 'bar'
  const rowH = sideBySide ? Math.max(28, names.length * 8 + 10) : 28
  const barH = 18
  const subH = sideBySide ? Math.max(4, Math.floor((rowH - 10) / names.length)) : 0
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

  const peak = values.length && !sideBySide ? values.indexOf(Math.max(...values)) : -1
  const pointLabel = (p: Point, i: number) => (kind === 'line' ? tf(times[i]) : p.label)

  // Tooltip anchor
  let tip: { x: number; y: number } | null = null
  if (active !== null && points[active]) {
    const p = points[active]
    const top = multi ? Math.max(...(stacked ? [values[active]] : p.values!.map((v) => v ?? d0))) : p.value
    if (kind === 'bar') tip = { x: Math.max(sv(top), sv(0)), y: m.t + active * rowH + rowH / 2 }
    else if (kind === 'hist') tip = { x: m.l + band * (active + 0.5), y: sv(p.value) }
    else tip = { x: sx(times[active]), y: sv(top) }
  }

  const linePath = kind === 'line' && !multi ? points.map((p, i) => `${i ? 'L' : 'M'}${sx(times[i])},${sv(p.value)}`).join('') : ''
  const areaPath = kind === 'line' && !multi && points.length > 1 ? `${linePath}L${sx(times[times.length - 1])},${sv(0)}L${sx(times[0])},${sv(0)}Z` : ''
  // A line per series, broken where it has no value (an average over no rows).
  const seriesPaths =
    kind === 'line' && multi
      ? names.map((_, j) => {
          let d = ''
          let open = false
          points.forEach((p, i) => {
            const v = p.values![j]
            if (v === null) open = false
            else {
              d += `${open ? 'L' : 'M'}${sx(times[i])},${sv(v)}`
              open = true
            }
          })
          return d
        })
      : []
  // As many x labels as fit the plot width (month labels like "Sep 2024" need the most room), up to 6.
  const tickN = Math.min(6, points.length, Math.max(2, Math.floor(iw / (bucket === 'month' || bucket === 'quarter' ? 68 : bucket === 'hour' || bucket === 'year' ? 44 : 52))))
  const xTickIdx = kind === 'line' ? Array.from(new Set(Array.from({ length: tickN }, (_, k) => Math.round((k * (points.length - 1)) / Math.max(1, tickN - 1))))) : []

  return (
    <div className={`chart${compact ? ' chart-compact' : ''}`} ref={wrap}>
      {multi && (
        <ul className="chart-legend" aria-label="Series">
          {names.map((n, j) => (
            <li key={j}>
              <Swatch kind={kind} cls={seriesClass(j, names, other)} />
              {n}
            </li>
          ))}
        </ul>
      )}
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
            multi &&
            points.map((p, i) => {
              const y = m.t + i * rowH + (rowH - (sideBySide ? subH * names.length : barH)) / 2
              let cum = 0
              const lastPart = p.values!.reduce<number>((a, v, j) => ((v ?? 0) > 0 ? j : a), -1)
              return (
                <g key={i} className={active === i ? 'is-active' : undefined}>
                  <text className="chart-cat" x={labelW} y={m.t + i * rowH + rowH / 2 + 4} textAnchor="end">
                    {p.label.length > 26 ? `${p.label.slice(0, 25)}…` : p.label}
                  </text>
                  {p.values!.map((v, j) => {
                    if (v === null || v === 0) return null
                    if (sideBySide) return <path key={j} className={`chart-mark ${seriesClass(j, names, other)}`} d={hBar(sv(0), sv(v), y + j * subH, Math.max(2, subH - 1))} />
                    const from = cum
                    cum += v
                    return <path key={j} className={`chart-mark chart-part ${seriesClass(j, names, other)}`} d={segment(sv(from), sv(cum), y, barH, j === lastPart)} />
                  })}
                  {!sideBySide && (i === peak || active === i) && (
                    <text className="chart-value" x={Math.max(sv(values[i]), sv(0)) + 6} y={y + barH / 2 + 4}>
                      {fmt(values[i])}
                    </text>
                  )}
                </g>
              )
            })}

          {kind === 'bar' &&
            !multi &&
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

          {kind === 'line' && multi && (
            <>
              {active !== null && <line className="chart-cross" x1={sx(times[active])} x2={sx(times[active])} y1={m.t} y2={m.t + ih} />}
              {seriesPaths.map((d, j) => (
                <path key={j} className={`chart-line ${seriesClass(j, names, other)}`} d={d} />
              ))}
              {/* A lone point (a series with one month) is a dot, as a line from it to nothing can't be seen. */}
              {names.map((_, j) =>
                points.map((p, i) => {
                  const v = p.values![j]
                  const alone = v !== null && (i === 0 || points[i - 1].values![j] === null) && (i === points.length - 1 || points[i + 1].values![j] === null)
                  return v !== null && (active === i || alone) ? <circle key={`${j}-${i}`} className={`chart-dot ${seriesClass(j, names, other)}`} cx={sx(times[i])} cy={sv(v)} r={active === i ? 4 : 2.5} /> : null
                }),
              )}
              {xTickIdx.map((i) => (
                <text key={i} className="chart-tick" x={sx(times[i])} y={height - 10} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
                  {tf(times[i])}
                </text>
              ))}
            </>
          )}

          {kind === 'line' && !multi && (
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
          {multi ? (
            <dl className="chart-tip-series">
              {names.map((n, j) => (
                <div key={j}>
                  <dt>
                    <Swatch kind={kind} cls={seriesClass(j, names, other)} />
                    {n}
                  </dt>
                  <dd>{points[active].values![j] === null ? '–' : exact.format(points[active].values![j]!)}</dd>
                </div>
              ))}
              {stacked && (
                <div className="chart-tip-total">
                  <dt>Total</dt>
                  <dd>{exact.format(values[active])}</dd>
                </div>
              )}
            </dl>
          ) : (
            <b>
              {exact.format(points[active].value)} {kind === 'hist' ? 'rows' : ''}
            </b>
          )}
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
              {multi ? names.map((n, j) => <th key={j} scope="col">{n}</th>) : <th scope="col">{valueName}</th>}
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <td>{pointLabel(p, i)}</td>
                {multi ? p.values!.map((v, j) => <td key={j}>{v === null ? '–' : exact.format(v)}</td>) : <td>{exact.format(p.value)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
