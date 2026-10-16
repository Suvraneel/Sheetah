import type { CSSProperties } from 'react'
import { Icon, Logo } from './Icon'

/*
 * A static replica of the workspace for the landing page, drawn with the app's own tokens so it
 * matches both themes and stays sharp at any size. Every value is real: the query below, run on
 * the built-in 1,000,000-row sample (deterministic), returns exactly these rows and this count.
 */
const COLUMNS: { name: string; type: string; num?: boolean }[] = [
  { name: 'order_id', type: 'bigint', num: true },
  { name: 'ordered_at', type: 'timestamp' },
  { name: 'customer', type: 'varchar' },
  { name: 'city', type: 'varchar' },
  { name: 'category', type: 'varchar' },
  { name: 'product', type: 'varchar' },
  { name: 'quantity', type: 'integer', num: true },
  { name: 'total', type: 'double', num: true },
]
const ROWS = [
  ['590233', '2024-10-11 23:59:39', 'Kabir Das', 'Hyderabad', 'Sports', 'Ceramic mug', '4', '11779.98'],
  ['1010229', '2024-10-11 23:55:30', 'Aarav Reddy', 'Dubai', 'Sports', 'Green tea', '4', '10975.91'],
  ['556771', '2024-10-11 23:53:21', 'Kabir Garcia', 'Bengaluru', 'Fashion', 'Sunscreen', '1', '1703.68'],
  ['390128', '2024-10-11 23:52:37', 'Ananya Iyer', 'Pune', 'Grocery', 'Puzzle set', '1', '2968.04'],
  ['101320', '2024-10-11 23:51:30', 'Leo Reddy', 'Sydney', 'Grocery', 'Desk lamp', '5', '6884.19'],
  ['622396', '2024-10-11 23:51:17', 'Amara Mehta', 'Mumbai', 'Toys', 'Cookbook', '2', '6277.34'],
  ['601309', '2024-10-11 23:50:18', 'Sara Reddy', 'Pune', 'Books', 'Green tea', '4', '8820.0'],
  ['834660', '2024-10-11 23:47:50', 'Kabir Khan', 'Sydney', 'Grocery', 'Football', '3', '11114.18'],
  ['680256', '2024-10-11 23:45:14', 'Vihaan Khan', 'Singapore', 'Electronics', 'Board game', '1', '1187.02'],
  ['623491', '2024-10-11 23:42:15', 'Ananya Das', 'London', 'Home', 'Paperback novel', '2', '4481.36'],
]
const ROW_COUNT = '459,688'
const ELAPSED = '166 ms'
/** Selected block: the total column, rows 3 to 8 (0-based 2..7). */
const SEL = { col: 7, from: 2, to: 7 }
const TABLE_COLUMNS = [...COLUMNS.map((c) => [c.name, c.type]), ['unit_price', 'double'], ['discount_pct', 'integer'], ['status', 'varchar']]

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const picked = ROWS.slice(SEL.from, SEL.to + 1).map((r) => Number(r[SEL.col]))
const sum = picked.reduce((a, b) => a + b, 0)
const isSel = (r: number, c: number) => c === SEL.col && r >= SEL.from && r <= SEL.to
const nth = (i: number) => ({ '--i': i }) as CSSProperties

export function ProductShot() {
  return (
    <figure className="shot">
      <div
        className="shell shot-frame"
        role="img"
        aria-label={`The Quarry workspace: a SQL query over the 1,000,000-row sample returns ${ROW_COUNT} rows in ${ELAPSED}; six cells of the total column are selected and the status bar shows their count, sum and average.`}
      >
        <div className="core pv" aria-hidden>
          <div className="pv-top">
            <span className="pv-brand">
              <Logo size={16} /> Quarry
            </span>
            <span className="pv-lock">
              <Icon name="lock" size={11} /> Network locked
            </span>
            <span className="spacer" />
            <span className="pv-btn">
              <Icon name="spark" size={12} /> Sample data
            </span>
            <span className="pv-btn is-primary">
              Open file
              <i>
                <Icon name="plus" size={11} />
              </i>
            </span>
          </div>

          <div className="pv-side">
            <div className="pv-tabs">
              <span className="is-on">Tables</span>
              <span>Saved</span>
              <span>History</span>
            </div>
            <div className="pv-table">
              <Icon name="table" size={13} /> <b>orders</b> <em>1M</em>
            </div>
            <ul className="pv-cols">
              {TABLE_COLUMNS.map(([n, t]) => (
                <li key={n}>
                  <span>{n}</span>
                  <em>{t}</em>
                </li>
              ))}
            </ul>
          </div>

          <div className="pv-main">
            <div className="pv-editor">
              <pre>
                <span>
                  <i className="k">SELECT</i> order_id, ordered_at, customer, city, category, product, quantity, total
                </span>
                <span>
                  <i className="k">FROM</i> orders
                </span>
                <span>
                  <i className="k">WHERE</i> status = <i className="s">'delivered'</i> <i className="k">AND</i> total {'>'} <i className="n">1000</i>
                </span>
                <span>
                  <i className="k">ORDER BY</i> ordered_at <i className="k">DESC</i>
                </span>
              </pre>
              <div className="pv-run">
                <span className="pv-kbd">
                  <kbd>⌘</kbd>
                  <kbd>Enter</kbd> to run
                </span>
                <span className="pv-btn is-primary">
                  Run query
                  <i>
                    <Icon name="play" size={10} />
                  </i>
                </span>
              </div>
            </div>

            <div className="pv-results">
              <div className="pv-toolbar">
                <span>
                  <b>{ROW_COUNT}</b> rows · {COLUMNS.length} columns · <span className="mono">{ELAPSED}</span>
                </span>
                <span className="spacer" />
                <span className="pv-switch">
                  <span className="is-on">Grid</span>
                  <span>Chart</span>
                </span>
                <span className="pv-btn">Pivot</span>
                <span className="pv-btn">Export</span>
              </div>
              <div className="pv-grid">
                <div className="pv-row pv-head">
                  <span />
                  {COLUMNS.map((c, i) => (
                    <span key={c.name} className={`${c.num ? 'num' : ''}${i === SEL.col ? ' is-col' : ''}`}>
                      {c.name}
                      <em>{c.type}</em>
                    </span>
                  ))}
                </div>
                {ROWS.map((row, r) => (
                  <div className="pv-row" key={row[0]}>
                    <span className={`pv-gutter${r >= SEL.from && r <= SEL.to ? ' is-row' : ''}`}>{r + 1}</span>
                    {row.map((v, c) => (
                      <span
                        key={c}
                        className={`${COLUMNS[c].num ? 'num' : ''}${isSel(r, c) ? ' is-sel' : ''}${isSel(r, c) && r === SEL.to ? ' is-active' : ''}`}
                        style={isSel(r, c) ? nth(r - SEL.from) : undefined}
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <div className="pv-status">
                <span className="mono">Row {SEL.to + 1} · total</span>
                <span className="mono pv-value">{ROWS[SEL.to][SEL.col]}</span>
                <span className="spacer" />
                <span className="pv-stats">
                  <span>
                    Count <b>{picked.length}</b>
                  </span>
                  <span>
                    Sum <b>{nf.format(sum)}</b>
                  </span>
                  <span>
                    Average <b>{nf.format(sum / picked.length)}</b>
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption>
        Real output from the built-in sample. Drag across cells and the status bar sums them in SQL, at any row
        count.
      </figcaption>
    </figure>
  )
}
