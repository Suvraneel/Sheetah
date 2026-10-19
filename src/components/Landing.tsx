import { Suspense, lazy, type CSSProperties, type ReactNode } from 'react'
import { BtnIcon, Icon, Logo } from './Icon'
import { ThemeToggle } from './ThemeToggle'
import { Reveal } from './Reveal'
import { HairlineFigure } from './HairlineFigure'

const ProductShot = lazy(() => import('./ProductShot').then((m) => ({ default: m.ProductShot })))
// The two line figures load after the page, with their engine, as their own chunks.
const loadSheetChart = () => import('../hairline/sheet-chart.js')
const loadTidyGate = () => import('../hairline/tidy-gate.js')

interface Props {
  sharedSql?: string | null
  ready: boolean
  /** The engine couldn't start in this browser. */
  failed?: boolean
  offlineReady?: boolean
  busy: string | null
  onPick: () => void
  onDemo: () => void
  /** Open the small, messy sample export (totals, amounts as text, empty rows) to tidy up. */
  onMessy?: () => void
}

export function Landing({ ready, failed, offlineReady, busy, sharedSql, onPick, onDemo, onMessy }: Props) {
  return (
    <div className="landing">
      <header className="land-nav">
        <span className="brand">
          <Logo /> Sheetah
        </span>
        <span className={`engine-pill${ready ? ' is-ready' : ''}${failed ? ' is-failed' : ''}`} role="status">
          <span className="dot" aria-hidden />
          {failed
            ? 'The engine couldn’t start'
            : ready
              ? offlineReady
                ? 'Engine ready · works offline'
                : 'Engine ready · runs on this device'
              : 'Getting ready (8 MB, first visit only)…'}
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
            <span className="h1-line">Open the</span> <span className="h1-line"><span className="hl">whole</span> file.</span>
          </h1>
          <p className="lede">
            Scroll millions of rows like a spreadsheet, tidy up messy exports in a click, then ask anything in SQL.
            Sheetah runs DuckDB inside this tab, so your data never leaves your computer.
          </p>
          {/* Point at a column and it rises into a chart of its own values; the line under it is the SQL. */}
          <HairlineFigure load={loadSheetChart} className="hero-figure" tourOnce hideWhen="(max-width: 960px)" />
        </Reveal>

        <Reveal className="hero-drop" delay={120}>
          <button className="shell drop" onClick={onPick} disabled={!!busy || failed}>
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
              <span className="drop-sub">
                CSV, Excel, JSON or Parquet · compressed .gz works too<span className="on-pointer"> · or paste cells from a spreadsheet</span>
              </span>
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
            <button className="btn btn-primary" onClick={onDemo} disabled={!!busy || failed}>
              Try 1,000,000 sample rows
              <BtnIcon name="arrowRight" />
            </button>
            <span className="cta-note">Generated right here in a few seconds. No file needed.</span>
            {onMessy && (
              <button className="link-btn cta-messy" onClick={onMessy} disabled={!!busy || failed}>
                Or tidy up a messy sales export
                <Icon name="arrowRight" size={14} />
              </button>
            )}
          </div>
        </Reveal>
      </section>

      <Reveal className="showcase">
        {/* Below the fold: it loads after the page is usable (a placeholder holds its place meanwhile). */}
        <Suspense fallback={<div className="shot shot-placeholder" aria-hidden />}>
          <ProductShot />
        </Suspense>
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
              Sort, filter, clean up and look up from the column header. Each click writes readable SQL you can keep
              editing, or undo.
            </Feature>
          </Reveal>
          <Reveal className="b-c" delay={160}>
            <Feature title="Private by design" visual={<NetworkSketch />}>
              The engine ships with the page. No uploads, no accounts, no analytics. Anonymize personal data before you
              share.
            </Feature>
          </Reveal>
          <Reveal className="b-d" delay={80}>
            <Feature title="Answers at a glance" visual={<StatsSketch />}>
              Select a range for its count, sum and average. Flip any result to a chart or a pivot, or compare two
              versions of a file, computed over every row.
            </Feature>
          </Reveal>
          <Reveal className="b-e" delay={160}>
            <Feature title="Take it with you" wide visual={<ExportSketch />}>
              Export any result to Excel, CSV or Parquet, or share the query as a link. Only the SQL travels, never the
              data.
            </Feature>
          </Reveal>
        </div>
      </section>

      <section className="tidy-band" aria-labelledby="tidy-title">
        <Reveal className="tidy-copy">
          <span className="eyebrow">Tidy a messy export</span>
          <h2 id="tidy-title">
            Ragged in, square out. <span className="ink-soft">Every fix is a line of SQL.</span>
          </h2>
          <p>
            Total lines and empty rows are left out, numbers stored as text become numbers, stray spaces go. Each fix
            is a step you can read, undo, or save to run again on next month’s file.
          </p>
          {onMessy && (
            <button className="btn btn-primary" onClick={onMessy} disabled={!!busy || failed}>
              Tidy the messy sample
              <BtnIcon name="arrowRight" />
            </button>
          )}
        </Reveal>
        <Reveal className="tidy-viz" delay={120}>
          <div className="shell">
            <div className="core tidy-core">
              {/* Rows ride a belt through a comb; hover slows it, and the line under it names the fix. */}
              <HairlineFigure load={loadTidyGate} />
            </div>
          </div>
        </Reveal>
      </section>

      </main>

      <footer className="land-foot">
        <span>
          <Logo size={16} /> Sheetah
        </span>
        <span>Built with DuckDB-WASM. A static site: no server ever sees your data.</span>
        <nav className="land-links" aria-label="About Sheetah">
          <a href="/privacy.html">Privacy</a>
          <a href="https://github.com/Suvraneel/Sheetah" target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
          <span className="muted">v{__APP_VERSION__}</span>
        </nav>
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

/** Decorative mini-grid that "scrolls" once, and on while hovered (transform-only animation). */
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
          <i className="k">SELECT</i> * <i className="k">FROM</i> orders
        </span>
        <span className="ln is-new" style={nth(0)}>
          <i className="k">WHERE</i> city = <i className="s">'Delhi'</i>
        </span>
        <span className="ln is-new" style={nth(1)}>
          <i className="k">ORDER BY</i> total <i className="k">DESC NULLS LAST</i>
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
          <b>.xlsx</b>
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
