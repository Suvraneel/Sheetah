import type { CSSProperties, ReactNode } from 'react'
import { BtnIcon, Icon, Logo } from './Icon'
import { ProductShot } from './ProductShot'
import { ThemeToggle } from './ThemeToggle'
import { Reveal } from './Reveal'

interface Props {
  sharedSql?: string | null
  ready: boolean
  offlineReady?: boolean
  busy: string | null
  onPick: () => void
  onDemo: () => void
}

export function Landing({ ready, offlineReady, busy, sharedSql, onPick, onDemo }: Props) {
  return (
    <div className="landing">
      <header className="land-nav">
        <span className="brand">
          <Logo /> Sheetah
        </span>
        <span className={`engine-pill${ready ? ' is-ready' : ''}`} role="status">
          <span className="dot" aria-hidden />
          {ready ? (offlineReady ? 'Engine ready · works offline' : 'Engine ready · runs on this device') : 'Loading the engine (about 8 MB, once)…'}
        </span>
        <ThemeToggle className="icon-pill-sm" />
      </header>

      <main>
      {sharedSql && (
        <aside className="shared-banner" aria-label="Shared query">
          <span className="shared-icon">
            <Icon name="share" size={18} />
          </span>
          <div>
            <strong>A shared query is waiting.</strong>
            <span>Open a file or try the sample data, then review it before it runs. Only the SQL was shared, never anyone’s data.</span>
            <code>{sharedSql.length > 140 ? `${sharedSql.slice(0, 140)}…` : sharedSql}</code>
          </div>
        </aside>
      )}
      <section className="hero">
        <Reveal className="hero-copy">
          <span className="eyebrow">Spreadsheet × SQL · In your browser</span>
          <h1>
            Open the <span className="hl">whole</span> file.
          </h1>
          <p className="lede">
            Scroll millions of rows like a spreadsheet, then ask anything in SQL. Sheetah runs DuckDB inside this tab,
            so your data never leaves your computer.
          </p>
        </Reveal>

        <Reveal className="hero-drop" delay={120}>
          <button className="shell drop" onClick={onPick} disabled={!!busy}>
            <span className="core drop-core">
              <span className="drop-icon">
                <Icon name="upload" size={24} />
              </span>
              <span className="drop-title">
                {busy ?? (
                  <>
                    <span className="on-pointer">Drop a file, or click to browse</span>
                    <span className="on-touch">Tap to choose a file</span>
                  </>
                )}
              </span>
              <span className="drop-sub">CSV, Excel, JSON or Parquet · compressed .gz works too</span>
              <span className="drop-private">
                <Icon name="lock" size={13} /> Read locally. Nothing is uploaded.
              </span>
            </span>
          </button>
          <div className="hero-ctas">
            <p className="stat">
              <span className="stat-num">1,048,576</span>
              <span className="stat-cap">rows is where Excel stops. Sheetah keeps scrolling.</span>
            </p>
            <button className="btn btn-primary" onClick={onDemo} disabled={!!busy}>
              Try 1,000,000 sample rows
              <BtnIcon name="arrowRight" />
            </button>
            <span className="cta-note">Generated right here in a second. No file needed.</span>
          </div>
        </Reveal>
      </section>

      <Reveal className="showcase">
        <ProductShot />
      </Reveal>

      <section className="features" aria-labelledby="features-title">
        <Reveal className="section-head">
          <div>
            <span className="eyebrow">What’s inside</span>
            <h2 id="features-title">
              Feels like a spreadsheet. <span className="ink-soft">Thinks in SQL.</span>
            </h2>
          </div>
          <p>Every click writes a query you can read, and every query runs on DuckDB inside this tab.</p>
        </Reveal>

        <div className="bento">
          <Reveal className="b-a">
            <Feature title="Smooth at a million rows" big visual={<GridSketch />}>
              A canvas grid draws only what’s on screen and pulls rows from DuckDB as you scroll. Excel stops at
              1,048,576 rows. Sheetah doesn’t.
            </Feature>
          </Reveal>
          <Reveal className="b-b" delay={80}>
            <Feature title="SQL when you want it" visual={<SqlSketch />}>
              Sort and filter from the column header. Each click writes readable SQL you can keep editing.
            </Feature>
          </Reveal>
          <Reveal className="b-c" delay={160}>
            <Feature title="Private by design" visual={<NetworkSketch />}>
              The engine ships with the page. No uploads, no accounts, no analytics.
            </Feature>
          </Reveal>
          <Reveal className="b-d" delay={80}>
            <Feature title="Answers at a glance" visual={<StatsSketch />}>
              Select a range for its count, sum and average. Flip any result to a chart or a pivot, computed over
              every row.
            </Feature>
          </Reveal>
          <Reveal className="b-e" delay={160}>
            <Feature title="Take it with you" wide visual={<ExportSketch />}>
              Export any result as CSV or Parquet, or share the query as a link. Only the SQL travels, never the data.
            </Feature>
          </Reveal>
        </div>
      </section>

      </main>

      <footer className="land-foot">
        <span>
          <Logo size={16} /> Sheetah
        </span>
        <span>Built with DuckDB-WASM. A static site: no server ever sees your data.</span>
      </footer>
    </div>
  )
}

function Feature({ title, children, visual, big, wide }: { title: string; children: ReactNode; visual: ReactNode; big?: boolean; wide?: boolean }) {
  return (
    <div className="shell">
      <div className={`core feature${big ? ' feature-big' : ''}${wide ? ' feature-wide' : ''}`}>
        <div className="feature-text">
          <h3 className="feature-title">{title}</h3>
          <p>{children}</p>
        </div>
        <div className="feature-viz" aria-hidden>
          {visual}
        </div>
      </div>
    </div>
  )
}

/** Stagger index for the sketches' entry choreography (read by CSS as --i). */
const nth = (i: number) => ({ '--i': i }) as CSSProperties

/** Decorative mini-grid that "scrolls" forever (transform-only animation). */
function GridSketch() {
  return (
    <div className="sketch">
      <div className="sketch-track">
        {Array.from({ length: 24 }, (_, i) => (
          <div className="sketch-row" key={i}>
            <span>{(1_000_000 - 23 + i).toLocaleString('en-US')}</span>
            <i style={{ width: `${30 + ((i * 37) % 50)}%` }} />
            <i style={{ width: `${20 + ((i * 53) % 40)}%` }} />
            <b>{(((i * 7919) % 90000) / 100 + 99).toFixed(2)}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Two header clicks and the SQL they compose (the same shape compose.ts writes). */
function SqlSketch() {
  return (
    <div className="viz-sql">
      <div className="viz-chips">
        <span className="viz-chip" style={nth(0)}>
          <Icon name="filter" size={13} /> city = Delhi
        </span>
        <span className="viz-chip" style={nth(1)}>
          <Icon name="sortDesc" size={13} /> total
        </span>
      </div>
      <pre className="viz-code">
        <span className="ln">
          <i className="k">SELECT</i> * <i className="k">FROM</i> (<i className="k">SELECT</i> * <i className="k">FROM</i> <i className="s">"orders"</i>)
        </span>
        <span className="ln is-new" style={nth(0)}>
          <i className="k">WHERE</i> <i className="s">"city"</i>::<i className="t">VARCHAR</i> = <i className="s">'Delhi'</i>
        </span>
        <span className="ln is-new" style={nth(1)}>
          <i className="k">ORDER BY</i> <i className="s">"total"</i> <i className="k">DESC NULLS LAST</i>
        </span>
      </pre>
    </div>
  )
}

const LEDGER = [
  { what: 'orders.csv', how: 'read from your disk', ok: true },
  { what: 'DuckDB engine', how: 'served by this site', ok: true },
  { what: 'any other server', how: 'blocked', ok: false },
]

/** What the tab may talk to: a tiny network log. */
function NetworkSketch() {
  return (
    <ul className="viz-ledger">
      {LEDGER.map((r, i) => (
        <li key={r.what} className={r.ok ? 'is-ok' : 'is-blocked'} style={nth(i)}>
          <span className="led" />
          <span className="what">{r.what}</span>
          <span className="how">{r.how}</span>
        </li>
      ))}
    </ul>
  )
}

const BARS = [3120, 5080, 3940, 6560, 4590, 7540, 5740, 5250]
const PICK = [2, 5] // selected range, inclusive
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** A column chart with a selected range, and the status bar that sums it. */
function StatsSketch() {
  const picked = BARS.slice(PICK[0], PICK[1] + 1)
  const sum = picked.reduce((a, b) => a + b, 0)
  const max = Math.max(...BARS)
  return (
    <div className="viz-stats">
      <div className="viz-bars">
        {BARS.map((v, i) => (
          <span key={i} className={i >= PICK[0] && i <= PICK[1] ? 'is-on' : ''} style={{ ...nth(i), height: `${(v / max) * 100}%` }} />
        ))}
      </div>
      <div className="viz-status">
        <span>
          Count <b>{picked.length}</b>
        </span>
        <span>
          Sum <b>{fmt.format(sum)}</b>
        </span>
        <span>
          Average <b>{fmt.format(sum / picked.length)}</b>
        </span>
      </div>
    </div>
  )
}

/** Two export files fanned out, plus a share link that carries only SQL. */
function ExportSketch() {
  return (
    <div className="viz-export">
      <div className="viz-files">
        <span className="viz-file" style={nth(0)}>
          <i />
          <i />
          <i />
          <b>.csv</b>
        </span>
        <span className="viz-file is-alt" style={nth(1)}>
          <i />
          <i />
          <i />
          <b>.parquet</b>
        </span>
      </div>
      <span className="viz-link" style={nth(2)}>
        <Icon name="share" size={13} />
        <code>#q=K0ktSi0u…</code>
        <b>SQL only</b>
      </span>
    </div>
  )
}
