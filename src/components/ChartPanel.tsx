import { useEffect, useMemo, useState } from 'react'
import { AGGS, TOP_N, chartData, defaultSpec, xCandidates, type Agg, type ChartData, type ChartSpec } from '../engine/chart'
import type { ResultSet } from '../engine/result'
import { Chart } from './Chart'
import { Icon } from './Icon'

interface Props {
  result: ResultSet
  onOpenSql: (sql: string) => void
}

const nf = new Intl.NumberFormat('en-US')

export function ChartPanel({ result, onOpenSql }: Props) {
  const xs = useMemo(() => xCandidates(result.columns), [result])
  const numeric = useMemo(() => result.columns.filter((c) => c.numeric), [result])
  const [chosen, setChosen] = useState<ChartSpec | null>(null)
  // A new result keeps the current choice when its columns still exist; otherwise pick a sensible default.
  const spec = useMemo(() => {
    const ok = chosen && result.columns.some((c) => c.name === chosen.x) && (!chosen.y || result.columns.some((c) => c.name === chosen.y))
    return ok ? chosen : defaultSpec(result.columns)
  }, [chosen, result])
  const [state, setState] = useState<{ for: unknown; data?: ChartData | null; error?: string } | null>(null)
  const key = useMemo(() => ({ result, spec }), [result, spec])

  useEffect(() => {
    if (!spec) return
    let live = true
    chartData(result, spec)
      .then((data) => live && setState({ for: key, data }))
      .catch((e) => live && setState({ for: key, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      live = false
    }
  }, [key, result, spec])

  const loading = state?.for !== key
  const data = state?.data ?? null // previous chart stays (dimmed) while the next one computes
  const error = loading ? null : (state?.error ?? null)

  if (!spec) {
    return (
      <div className="grid-empty">
        <p>Nothing to chart here: this result has no columns that can be grouped or measured.</p>
      </div>
    )
  }

  const xCol = result.columns.find((c) => c.name === spec.x)
  const isDistribution = !!xCol?.numeric
  const set = (patch: Partial<ChartSpec>) => setChosen({ ...spec, ...patch })

  return (
    <div className={`chart-panel${loading ? ' is-loading' : ''}`} id="results-chart">
      <div className="chart-controls">
        <label>
          <span>Group by</span>
          <select value={spec.x} onChange={(e) => set({ x: e.target.value })}>
            {xs.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
            {numeric.length > 0 && (
              <optgroup label="Distribution of">
                {numeric.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {!isDistribution && (
          <>
            <label>
              <span>Measure</span>
              <select
                value={spec.agg}
                onChange={(e) => {
                  const agg = e.target.value as Agg
                  set({ agg, y: agg === 'count' ? spec.y : (spec.y ?? numeric[0]?.name ?? null) })
                }}
              >
                {AGGS.filter((a) => a.id === 'count' || numeric.length).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            {spec.agg !== 'count' && (
              <label>
                <span>of</span>
                <select value={spec.y ?? ''} onChange={(e) => set({ y: e.target.value })}>
                  {numeric.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <span className="spacer" />
        {data && (
          <button className="btn btn-ghost btn-sm" onClick={() => onOpenSql(data.sql)} title="Put the SQL behind this chart in the editor and run it">
            <Icon name="table" /> Open as query
          </button>
        )}
      </div>

      {error ? (
        <p className="chart-note error-text" role="alert">
          Couldn’t draw that chart. {error}
        </p>
      ) : data ? (
        <figure className="chart-figure">
          <figcaption>
            <strong>{data.title}</strong>
            <span className="muted small">
              {data.kind === 'bar' && data.groups > data.points.length
                ? `Top ${TOP_N} of ${nf.format(data.groups)} groups, by value`
                : data.kind === 'line'
                  ? `${nf.format(data.points.length)} ${data.bucket}s`
                  : data.kind === 'hist'
                    ? `${nf.format(data.points.length)} equal-width bins · rows per bin`
                    : `${nf.format(data.points.length)} groups`}{' '}
              · all {nf.format(result.rowCount)} rows
            </span>
          </figcaption>
          {data.points.length ? (
            <Chart kind={data.kind} points={data.points} label={data.title} valueName={data.kind === 'hist' ? 'rows' : 'value'} bucket={data.bucket} />
          ) : (
            <p className="chart-note muted">No values to plot (every row is empty).</p>
          )}
        </figure>
      ) : (
        <p className="chart-note muted">Drawing…</p>
      )}
    </div>
  )
}
