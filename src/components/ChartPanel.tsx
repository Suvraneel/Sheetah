import { useEffect, useMemo, useState } from 'react'
import { LOCALE } from '../engine/sql'
import { AGGS, TIME_GRAINS, TOP_N, chartData, defaultSpec, eachColumns, isTemporal, xCandidates, yearName, type Agg, type ChartData, type ChartSpec, type TimeGrain } from '../engine/chart'
import type { ResultSet } from '../engine/result'
import { Chart } from './Chart'
import { Icon } from './Icon'

interface Props {
  result: ResultSet
  onOpenSql: (sql: string) => void
  /** Number columns stored as text (they can't be measured until converted), and the one-click conversion. */
  textNumbers?: string[]
  onConvert?: () => void
}

const nf = new Intl.NumberFormat(LOCALE)
/** The "of" choice for every number column at once (never a column's name: it has a NUL in it). */
const EACH = '\u0000each'

export function ChartPanel({ result, onOpenSql, textNumbers, onConvert }: Props) {
  const xs = useMemo(() => xCandidates(result.columns), [result])
  const numeric = useMemo(() => result.columns.filter((c) => c.numeric), [result])
  const [chosen, setChosen] = useState<ChartSpec | null>(null)
  // A new result keeps the current choice when its columns still exist; otherwise pick a sensible default.
  const spec = useMemo(() => {
    const ok = chosen && result.columns.some((c) => c.name === chosen.x) && (!chosen.y || result.columns.some((c) => c.name === chosen.y))
    if (!ok) return defaultSpec(result.columns, result.sql)
    // A split by a column the new result doesn't have is left off; the rest of the choice stays.
    // (Nor by one that is no longer a split's to pick: the column grouped by, a date, a number.)
    const splittable = xCandidates(result.columns).some((c) => c.name === chosen.split && c.name !== chosen.x && !isTemporal(c))
    return chosen.split && !splittable ? { ...chosen, split: null } : chosen
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
  // A column of years is a time axis, not a distribution (its measure and split stay).
  const isDistribution = !!xCol?.numeric && !yearName(xCol)
  const set = (patch: Partial<ChartSpec>) => setChosen({ ...spec, ...patch })
  const isTime = !!xCol && isTemporal(xCol)
  const grains = TIME_GRAINS.filter((g) => g !== 'hour' || !/^DATE$/i.test(xCol?.type ?? ''))
  // Splits: the columns that name things (a time axis is the x, not a series).
  const splits = xs.filter((c) => c.name !== spec.x && !isTemporal(c))
  // Each number column as its own series: offered for sums, when there are two or more to chart.
  const eachOk = spec.agg === 'sum' && eachColumns(result.columns, spec.x, result.sql, spec.y).length >= 2
  const each = eachOk && !!spec.each

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
            {numeric.some((c) => !yearName(c)) && (
              <optgroup label="Distribution of">
                {numeric.filter((c) => !yearName(c)).map((c) => (
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
            {isTime && (
              <label>
                <span>By</span>
                <select value={spec.grain ?? ''} onChange={(e) => set({ grain: (e.target.value || undefined) as TimeGrain | undefined })}>
                  <option value="">{data?.bucket && !spec.grain ? `Auto (${data.bucket})` : 'Auto'}</option>
                  {grains.map((g) => (
                    <option key={g} value={g}>
                      {g[0].toUpperCase() + g.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {spec.agg !== 'count' && (
              <label>
                <span>of</span>
                <select value={each ? EACH : (spec.y ?? '')} onChange={(e) => set(e.target.value === EACH ? { each: true } : { y: e.target.value, each: false })}>
                  {eachOk && <option value={EACH}>Each number column</option>}
                  {numeric.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {splits.length > 0 && !each && (
              <label>
                <span>Split by</span>
                <select value={spec.split ?? ''} onChange={(e) => set({ split: e.target.value || null })}>
                  <option value="">None</option>
                  {splits.map((c) => (
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
        {onConvert && !!textNumbers?.length && !isDistribution && (
          <span className="chart-text-numbers">
            {textNumbers.slice(0, 2).join(', ')}
            {textNumbers.length > 2 ? ` and ${textNumbers.length - 2} more` : ''} {textNumbers.length === 1 ? 'is' : 'are'} stored as text, so {textNumbers.length === 1 ? 'it can’t' : 'they can’t'} be summed yet.{' '}
            <button className="link-btn" onClick={onConvert}>
              Convert to numbers
            </button>
          </span>
        )}
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
                ? data.inOrder
                  ? `First ${TOP_N} of ${nf.format(data.groups)} groups`
                  : `Top ${TOP_N} of ${nf.format(data.groups)} groups, by value`
                : data.kind === 'line'
                  ? `${nf.format(data.points.length)} ${data.bucket}s`
                  : data.kind === 'hist'
                    ? `${nf.format(data.points.length)} equal-width bins · rows per bin`
                    : `${nf.format(data.points.length)} groups`}{' '}
              {data.series && data.seriesGroups
                ? data.other
                  ? ` · ${data.series.length - 1} of ${nf.format(data.seriesGroups)} ${each ? 'columns' : `${spec.split} values`} shown, the rest as ${data.series.at(-1)}`
                  : data.seriesGroups > data.series.length
                    ? ` · the first ${data.series.length} of ${nf.format(data.seriesGroups)} columns`
                    : ''
                : ''}{' '}
              ·{' '}
              {data.left
                ? `${nf.format(data.rows ?? 0)} of ${nf.format((data.rows ?? 0) + data.left)} rows (${nf.format(data.left)} with no ${spec.x} left out)`
                : `all ${nf.format(data.rows ?? result.rowCount)} rows`}
            </span>
          </figcaption>
          {data.points.length ? (
            <Chart
              kind={data.kind}
              points={data.points}
              label={data.title}
              valueName={data.kind === 'hist' ? 'rows' : 'value'}
              bucket={data.bucket}
              series={data.series}
              other={data.other}
              stacked={data.stacked}
            />
          ) : (
            <p className="chart-note muted">{result.rowCount ? 'No values to plot (every row is empty).' : 'No rows to chart.'}</p>
          )}
        </figure>
      ) : (
        <p className="chart-note muted">{loading ? 'Drawing…' : 'This result can’t be charted. Try Grid view, or run it as a query first.'}</p>
      )}
    </div>
  )
}
