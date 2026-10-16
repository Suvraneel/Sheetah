# Sheetah

**Open the whole file.** A spreadsheet that scrolls millions of rows and speaks SQL, running entirely in your browser.
Sheetah ships DuckDB (compiled to WebAssembly) with the page, so files are read from your disk and never uploaded.
There is no backend; it deploys as a static site for free.

![Sheetah landing](docs/screenshots/landing.png)
![Workspace, dark mode, with a selected range](docs/screenshots/workspace-dark.png)
![Quick chart: sum of total by category over 1M rows](docs/screenshots/chart.png)
![Pivot table builder](docs/screenshots/pivot.png)

- **Canvas grid** that stays at ~60 fps from 1 to 10,000,000+ rows
- **SQL editor** with highlighting and table/column autocomplete (⌘/Ctrl + Enter)
- **Point-and-click** sort, filter, formula columns and column profiles, each composing readable SQL you can keep editing
- **Spreadsheet status bar**: select any range for count / sum / average / min / max, computed by SQL so it works on a million rows
- **Open** CSV, TSV, Excel (.xlsx, every sheet becomes a table), JSON / NDJSON, Parquet, and gzipped CSV; drop several files at once and join them
- **Saved views**: name a query and re-run it next month; if the file has a new name, Sheetah asks which table to point it at and can update the view
- **Pivot tables**: rows, columns (dates by year, quarter, month, week or day), up to three values, totals; the pivot is readable SQL you can edit, chart, save or share
- **Quick charts**: flip any result to a chart (trend over time, top groups, or a distribution), computed by SQL over every row; "Open as query" turns the chart back into a table
- **Share a query as a link**: only the SQL travels, inside the URL fragment, so not even the host sees it; links never auto-run
- **Works offline** after the first visit (service worker caches the app and engine), and installs as an app
- **Keep my tables** (optional): snapshots your tables in the browser's private file system so they're back after a reload
- **Cancel** long queries, with plain-language messages when the tab runs out of memory
- **Export** any result as CSV (Excel-safe or exact values) or Parquet
- **1,000,000-row sample** generated inside the engine, so there's nothing to download, with one-click starter queries
- **Light, dark or system theme**, remembered per browser and applied before first paint
- **Phone layout**: tables, saved views and history in a bottom sheet; the SQL collapses to one line so the grid gets the screen

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

`npm run build` first runs `scripts/fetch-duckdb-extensions.mjs`, which downloads the Parquet and JSON extensions for the
bundled DuckDB version into `public/duckdb-extensions/`, so the site serves them itself, and checks each file against the
SHA-256 pinned in `scripts/duckdb-extensions.lock.json`. The app never loads code from another host. If the extensions are
missing (e.g. `npm run dev` without a build), Parquet/JSON show a clear message; CSV and Excel always work.

## Deploy (free)

1. Run `npm run build` once locally (with internet). It records the extension hashes in
   `scripts/duckdb-extensions.lock.json`. **Commit that file**, so every later build verifies against it.
2. **Vercel:** import the repo; it detects Vite (build `npm run build`, output `dist`). No environment variables.
   `vercel.json` adds the security headers (CSP and friends) and long-lived caching for assets.
3. Check the headers on the live site: `curl -sI https://<your-app>.vercel.app | grep -i content-security`.

The DuckDB engine is a ~36 MB `.wasm` file (~8 MB compressed over the wire). Vercel and Netlify serve it fine.
Cloudflare Pages caps single files at 25 MiB, so it isn't a good fit without splitting tricks.

## How it works

```
File ──registerFileHandle──▶ DuckDB-WASM (Web Worker)
                                  │  CREATE TABLE t AS SELECT * FROM read_csv_auto(file)
your SQL ──────────────────────▶  CREATE TEMP TABLE __result AS SELECT * FROM (your SQL)
                                  │
Canvas grid ◀── 200-row chunks ── SELECT cols::VARCHAR FROM __result WHERE rowid BETWEEN a AND b
```

- **Windowed fetch by `rowid`, not `OFFSET`.** Every result is materialised once into a temp table; the grid then asks for
  any 200-row window by `rowid` range, which DuckDB answers from zone maps in milliseconds at any depth.
  `OFFSET 9,000,000` would scan nine million rows.
- **One canvas, no DOM per cell.** Each frame draws only the visible cells (one clip region per column, monospace
  truncation without measuring every string). A small LRU keeps ~60k rows warm; missing chunks render as skeleton bars
  and fill in as they arrive.
- **Beating the browser's height limit.** Elements can't be taller than ~33M px, and 10M rows × 30 px is 300M px. Past
  8M px the scrollbar maps proportionally onto row space, keeping sub-row offsets so scrolling stays smooth.
- **Excel off the main thread.** `.xlsx` is parsed in a Web Worker (`read-excel-file`), each sheet is handed to DuckDB as
  CSV text, and DuckDB's sniffer recovers dates, booleans and numbers. The page stays responsive while a big workbook loads.
- **Views survive file renames.** A saved view records which tables it reads. When those tables aren't open, a small
  SQL tokenizer (`src/engine/views.ts`) swaps the identifiers, skipping strings, comments and `alias.column` references,
  after suggesting the closest match (`sales_oct` → `sales_nov`).
- **UI actions are SQL.** Sorting, filters and formula columns are an `Ops` object composed around your last query
  (`src/engine/compose.ts`). The composed SQL appears in the editor, so the UI teaches SQL instead of hiding it.
- **Pivots without PIVOT.** A pivot compiles to one conditional aggregate per column value
  (`sum(x) FILTER (WHERE status = 'shipped')`) plus a Total column, with the grand-total row from `GROUPING SETS`.
  That keeps row and column totals consistent, handles NULL groups, and reads like SQL a person would write. Column
  fields are capped at 60 values with a message that says what to do instead.
- **Charts are one GROUP BY.** The chart view never samples: a time axis is bucketed (`date_trunc` by hour, day, week
  or month depending on the span), categories are ranked and cut to the top 20, numbers get a 20-bin histogram. Each
  chart carries its own standalone SQL, which "Open as query" runs as the table view.
- **Snapshots as Arrow.** "Keep my tables" writes each table as an Arrow IPC stream into the Origin Private File System
  and reloads it with `insertArrowFromIPCStream`, so types (BIGINT, DECIMAL, dates, lists) round-trip exactly.
- **Range math in SQL.** The status bar's sum/average for a selected block runs `SELECT sum(x) … WHERE rowid BETWEEN`,
  so selecting 500,000 cells costs one query, not a JavaScript loop.

## Measured (headless Chromium, 1440×900)

| Scenario | Result |
|---|---|
| Engine start | ~1.6 s |
| Generate 1M-row sample | ~0.6 s |
| Open a 63 MB, 2,000,000-row CSV | ~1.3 s |
| Full-range scroll, 1M rows | 16.6 ms median frame (60 fps), p95 ≈ 24 ms |
| Random jumps, 10M rows | 16.7 ms median frame |
| Export 2M rows to CSV | 61 MB file, a few seconds |
| Import a 100,000-row .xlsx (2.9 MB) | ~2.4 s, types preserved |

## Project layout

```
src/
  engine/db.ts          DuckDB-WASM bootstrap (self-hosted wasm + worker), extension loader
  engine/ingest.ts      file → table, 1M-row sample generator, table metadata
  engine/result.ts      run SQL → windowed ResultSet, range stats, column profile, export
  engine/compose.ts     sort / filter / formula columns → readable SQL
  engine/views.ts       saved views: storage, table detection, safe identifier remapping
  engine/pivot.ts       pivot specs → GROUP BY / FILTER / GROUPING SETS SQL
  engine/chart.ts       chart specs → aggregate SQL (buckets, top-N, histograms)
  engine/share.ts       share links: SQL ⇄ compressed URL fragment
  engine/persist.ts     "keep my tables": Arrow snapshots in OPFS
  engine/xlsx.worker.ts Excel parsing in a Web Worker
  grid/Grid.tsx         canvas grid: virtual scroll, chunk cache, selection, keyboard, copy, resize
  components/           landing, SQL editor (CodeMirror 6), column menu, dialogs, Chart (SVG)
public/sw.js            offline service worker (precache list generated at build time)
tests/                  Playwright e2e suite, run against the production build under the real CSP
docs/
  research.md           desk research synthesis that shaped the product
  ux-copy.md            copy review
  design-critique.md    design review and follow-ups
scripts/
  fetch-duckdb-extensions.mjs
```

## Known limits

- Data lives in browser memory: very large CSVs (several GB) can exceed the tab's limit. Parquet stays on disk as a view.
- Legacy `.xls` (pre-2007 binary) isn't supported; re-save as `.xlsx`. Very large workbooks parse slower than CSV.
- Saved views and kept tables live in this browser's storage (no sync across devices). Kept tables are capped at
  5M rows each, and views over Parquet files aren't kept (re-open the file).

## Security

Sheetah treats every query as untrusted: people paste SQL from the internet. Two independent layers keep data in the tab:

1. **Sealed engine.** Before the app can run anything, DuckDB is restricted to a virtual `/sheetah/` folder,
   `enable_external_access` is switched off and the configuration is locked. URL reads, `ATTACH`, `COPY TO` a URL,
   remote extensions and path traversal all fail, and SQL can't undo it.
2. **Content-Security-Policy.** The browser refuses connections to any other origin (`connect-src 'self'`), with no
   inline scripts and no `eval`.

Share links carry only SQL, in the `#fragment` (never sent to a server), and are shown for review instead of running.
Kept tables are opt-in, stored unencrypted in this site's private browser storage, and wiped by "Clear all local data".

Verified with 12 attack queries run through the editor: all blocked, zero outbound requests. Plus pinned dependencies,
hash-checked extensions, CI audit, Excel-safe CSV export, and optional history. See [SECURITY.md](SECURITY.md) for the
threat model.

## Accessibility

The grid is drawn on a canvas, so Sheetah also renders a visually hidden ARIA grid for the visible window (header row plus
the rows on screen) and points `aria-activedescendant` at the active cell. Screen readers get real rows, columns, headers,
sort state and selection, and range totals are announced through a live region. axe-core reports 0 WCAG 2.1 A/AA
violations on every screen in both themes. The full audit and keyboard map are in [docs/accessibility.md](docs/accessibility.md).

## Keyboard

| Keys | Action |
|---|---|
| ⌘/Ctrl + Enter | Run query |
| Arrows, Page Up/Down, Home/End | Move |
| Shift + move / click | Extend selection |
| ⌘/Ctrl + arrows | Jump to edge |
| ⌘/Ctrl + A / C | Select all / copy as TSV |
| Alt + ↓ (or Shift + F10) | Open the column menu: sort, filter, profile |
| Tab / Shift + Tab | Move between editor, toolbar and grid (first Tab: skip to grid) |
| Double-click a column edge | Fit width |
| ↑ / ↓ on the editor's resize handle | Shorter / taller (Enter fits the query again) |
| ? | Show all keyboard shortcuts |
