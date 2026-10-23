<div align="center">

<a href="https://cdn.jsdelivr.net/gh/Suvraneel/Sheetah@main/.github/media/demo.mp4"><img src=".github/media/demo.gif" alt="Sheetah demo: Excel's 1,048,576-row limit struck through, a 3,000,000-row orders.csv opened in the browser and scrolled past that row, a click on London writing WHERE city = 'London' into the SQL editor, and a pivot of revenue by category and year" width="100%"></a>

<h1>Sheetah</h1>

<p><strong>Open the whole file.</strong> A spreadsheet that scrolls millions of rows and speaks SQL.<br>
DuckDB runs inside your browser tab, so the file never leaves your computer.</p>

<p>
<a href="https://cdn.jsdelivr.net/gh/Suvraneel/Sheetah@main/.github/media/demo.mp4"><strong>▶ Watch the 60-second demo</strong></a> (with sound)
&nbsp;·&nbsp;
<a href="https://sheetah.vercel.app"><strong>Try it live</strong></a>
&nbsp;·&nbsp;
<a href="#run-it-locally"><strong>Run it locally</strong></a>
</p>

<p>
<img alt="DuckDB-WASM 1.33" src="https://img.shields.io/badge/DuckDB--WASM-1.33-FFF000?logo=duckdb&logoColor=black">
<img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black">
<img alt="TypeScript 6" src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white">
<img alt="Vite 8" src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white">
<img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green">
</p>

</div>

## Why

Excel stops at row 1,048,576 and quietly drops the rest of the file. Google Sheets refuses large imports and slows
down long before its limits. The usual ways out are a Python environment, a paid big-data spreadsheet, or uploading the
file to someone else's cloud. Each one means setup, cost, or handing over data you may not be allowed to share.

Sheetah is the spreadsheet you already know, with a real database underneath:

- **The whole file, in a grid.** Scroll every row of a multi-million-row CSV at 60 fps, and sort, filter and profile
  columns from their headers.
- **SQL when you want it.** Every click writes readable SQL into the editor, and you can write your own: CTEs, window
  functions, joins across files.
- **Nothing uploaded, and you can check.** The engine is served by the site itself and sealed before it runs a query,
  and the page's security policy blocks every other server. No account, no analytics, free.

It also tidies the messy monthly exports that accounting packages, ERPs and bank portals produce, and remembers the
steps, so next month's file takes one click.

## How it works

```
                 ┌───────────── main thread ─────────────┐        ┌──────── Web Worker ────────┐
 your file ───▶  │ registerFileHandle (read in place)    │ ─────▶ │ DuckDB-WASM (sealed)        │
                 │                                       │        │                             │
 your SQL  ───▶  │ runConn: user queries & loads, one    │ ─────▶ │ CREATE TABLE __sheetah.     │
                 │ at a time, send() so Cancel works     │        │   result_N AS (your SQL)    │
                 │                                       │        │                             │
 canvas grid ◀── │ conn: 200-row windows by rowid, stats,│ ◀───── │ SELECT … WHERE rowid        │
                 │ profiles, charts, pivots, metadata    │        │   BETWEEN a AND b           │
                 └───────────────────────────────────────┘        └─────────────────────────────┘
```

- **Two connections, one job each.** DuckDB-WASM abandons a connection's running `send()` if another query arrives on
  that same connection. So user queries and file loads get their own connection, serialised by a lock and
  cancellable. Everything the UI reads (grid windows, stats, profiles, background scans) uses the other one, so
  scrolling never kills a running query. Results live in a hidden `__sheetah` schema that both connections can see.
- **Windowed fetch by `rowid`, not `OFFSET`.** Each result is materialised once. The grid then asks for any 200-row
  window by `rowid` range, which DuckDB answers from zone maps in milliseconds at any depth. `OFFSET 9,000,000` would
  scan nine million rows.
- **One canvas, no DOM per cell.** Each frame draws only the visible cells. A small LRU keeps about 60,000 rows warm,
  and chunks that haven't arrived yet render as skeleton bars.
- **Beating the browser's height limit.** An element can't be taller than about 33M px, and 10M rows × 30 px is
  300M px. Past 8M px the scrollbar maps proportionally onto row space and keeps sub-row offsets, so scrolling stays
  smooth.
- **UI actions are SQL.** Sorting, filters, clean-ups and formula columns are an `Ops` object composed around your last
  query (`src/engine/compose.ts`). The composed SQL appears in the editor, so the UI teaches SQL instead of hiding it.
- **Pivots without PIVOT.** A pivot compiles to one conditional aggregate per column value
  (`sum(x) FILTER (WHERE status = 'shipped')`) plus a Total column, with the grand-total row from `GROUPING SETS`.
- **Charts are one GROUP BY.** The chart view never samples. A time axis is bucketed with `date_trunc`, categories are
  ranked and cut to the top 20, and numbers get a 20-bin histogram. "Open as query" runs a chart's SQL as a table.
- **Excel off the main thread.** `.xlsx` is unzipped and parsed in a Web Worker, each sheet goes to DuckDB as CSV text,
  and DuckDB's sniffer recovers the dates, booleans and numbers.
- **Snapshots as Arrow.** "Keep my tables" writes each table as an Arrow IPC stream into the Origin Private File
  System and reloads it with `insertArrowFromIPCStream`, so types round-trip exactly.

### Privacy and security

Sheetah treats every query as untrusted, because people paste SQL from the internet. Two independent layers keep the
data in the tab:

1. **Sealed engine.** Before the app runs anything, DuckDB is limited to a virtual `/sheetah/` folder,
   `enable_external_access` is switched off, and the configuration is locked (`src/engine/db.ts`). URL reads, `ATTACH`,
   `COPY TO` a URL, remote extensions and path traversal all fail, and SQL can't undo the seal.
2. **Content-Security-Policy.** The browser refuses connections to any other origin (`connect-src 'self'` in
   `vercel.json`). There are no inline scripts and no `eval`.

The end-to-end suite runs 13 exfiltration attempts through the editor and asserts that all of them fail with zero
outbound requests (`tests/security.spec.ts`). Share links carry only SQL, inside the URL `#fragment`, which browsers
never send to a server, and they are shown for review rather than run. The DuckDB extensions (Parquet, JSON) are
downloaded at build time, checked against pinned SHA-256 hashes, and served by the site itself. The full threat model is
in [SECURITY.md](SECURITY.md).

## Features

| | |
|---|---|
| ![The messy sample, tidied: totals and empty rows left out, ₹ amounts and dates converted, the region filled down](docs/screenshots/tidy.png) | ![Workspace, dark mode, with a selected range](docs/screenshots/workspace-dark.png) |
| ![Clean up: amounts stored as text (₹1,625) convert to numbers in one click](docs/screenshots/clean.png) | ![Look up: bring a table's columns in by a matching column, with the match count before you apply it](docs/screenshots/lookup.png) |
| ![Compare two exports: added, removed and changed rows](docs/screenshots/compare.png) | ![Pivot table builder](docs/screenshots/pivot.png) |
| ![Quick chart: sum of total by category over 1M rows](docs/screenshots/chart.png) | ![Anonymize: personal data found, with before → after previews](docs/screenshots/anonymize.png) |

### Open anything, all of it

- **Canvas grid** from 1 to 10,000,000+ rows. The first column stays in view while wide tables scroll.
- **Formats:** CSV, TSV, Excel (.xlsx; every sheet becomes a table), JSON / NDJSON, Parquet, and gzipped CSV. Drop
  several files at once and join them.
- **Paste cells** copied from Excel, Google Sheets or the grid itself (⌘/Ctrl + V) and they become a table.
- **Tally XML** (Day Book vouchers, or reports like the Trial Balance) opens as a table, and vouchers whose debits and
  credits don't agree are named.
- **The ".xls" that isn't.** A web page's table or Excel 2003 XML, which banks and ERPs often export, opens like a
  workbook. A PDF, an image or a zip renamed to .csv says what it really is instead of failing.
- **Status bar** with count, sum, average, min and max for any selected range, computed in SQL so it works on a
  million rows.
- **Sample data:** a 1,000,000-row table generated inside the engine, with one-click starter queries, and a small messy
  sales export to try the clean-up on.

### Tidy a messy export

- **Suggestions when a file opens:** total lines and empty rows to leave out (so sums aren't doubled), group names to
  fill down, numbers and dates stored as text, stray spaces, empty columns, months laid out as columns, the row the
  headers are really on, and personal data to anonymize.
- **Clean a column:** ₹1,200 · 1,00,000 · (250) · 12% · 50,000.00 Cr · Rs. 25,000 · 15/08/24 become real numbers and
  dates. Codes with leading zeros and phone numbers are never converted.
- **Point-and-click** sort, type-aware filters, find in every column (⌘/Ctrl + F), duplicates, hidden columns, formula
  columns, date parts, split and column profiles. Each step is a removable chip that composes readable SQL, and
  **undo / redo** (⌘/Ctrl + Z) covers all of them.
- **Look up** values from another table (VLOOKUP without the formula), **stack** monthly exports into one, **unpivot**
  month columns, and **compare** two versions of a file.
- **Saved views** re-run next month. A file with the same columns under a new name is recognised and offered the view,
  steps and all. Views can be exported to a file for a colleague; only names, SQL and steps travel, never data.

### For month-end

- **Bank statements:** money in and out by month, a signed amount from Deposit / Withdrawal (or Amount + Dr / Cr)
  columns, and a check that every running balance follows from the row before.
- **Match payments** between the bank and the books (same amount, dates a few days apart), with near misses called out
  ("digits swapped?"), then a **bank reconciliation statement** built from the match.
- **Ageing** of open bills by party, a day book's **totals by ledger**, **categories from words** (*swiggy, zomato →
  Food*), and **GSTIN / PAN / IFSC** checks as a table opens.

### Answer questions

- **SQL editor** (CodeMirror 6) with highlighting, table and column autocomplete, and cancellable runs
  (⌘/Ctrl + Enter). Errors are explained in spreadsheet terms (`&` for joining text, `TOP 10`, unquoted dates,
  `=AVERAGE(…)`), most with a one-click fix, and DuckDB's own message is kept under Details. A query that finds no rows
  says why when it's a common slip (`= NULL`, `LIKE 'a*'`, `'pune'` for `'Pune'`).
- **Pivot tables:** rows, columns (dates by year, April–March financial year, quarter, month, week or day), up to three
  values and totals, all as readable SQL.
- **Quick charts:** trend over time, top groups or a distribution, computed over every row, optionally split by a
  column.
- **Example queries for any table:** totals by a category, a monthly trend, the largest rows, a summary of every
  column.

### Share it, privately

- **Export** to Excel (.xlsx with real numbers, dates and percentages, a frozen header and filters; text never becomes
  a formula), CSV (Excel-safe or exact values) or Parquet.
- **Anonymize before sharing:** emails, phone numbers, Aadhaar (checksum-verified), PAN, card numbers (Luhn), IP
  addresses, names and birth dates can be masked, pseudonymized (keyed, so joins still work), generalized or removed,
  with previews.
- **Share a query as a link.** Only the SQL travels, inside the URL fragment, and links never run on their own.
- **Works offline** after the first visit, installs as an app and opens files from your OS. New versions are offered,
  never forced mid-session. **Keep my tables** (optional) brings tables back after a reload.
- **Light, dark or system theme**, and a **phone layout** with the library in a bottom sheet.

### Accessibility and keyboard

The grid is drawn on a canvas, so Sheetah also renders a visually hidden ARIA grid for the visible rows and points
`aria-activedescendant` at the active cell. axe-core reports 0 WCAG 2.1 A/AA violations on every screen and dialog in
both themes. The audit and keyboard map are in [docs/accessibility.md](docs/accessibility.md).

<details>
<summary>Keyboard shortcuts</summary>

| Keys | Action |
|---|---|
| ⌘/Ctrl + Enter | Run query |
| Arrows, Page Up/Down, Home/End | Move |
| Shift + move / click | Extend selection |
| ⌘/Ctrl + arrows | Jump to edge |
| ⌘/Ctrl + A / C | Select all / copy as TSV |
| ⌘/Ctrl + F | Find text in every column of the result |
| ⌘/Ctrl + Z, ⌘/Ctrl + Shift + Z | Undo / redo a sort, filter, clean-up, look-up or hidden column |
| Alt + ↓ (or Shift + F10) | Open the column menu: sort, filter, profile |
| Tab / Shift + Tab | Move between editor, toolbar and grid (first Tab: skip to grid) |
| Double-click a column edge | Fit width |
| ↑ / ↓ on the editor's resize handle | Shorter / taller (Enter fits the query again) |
| ? | Show all keyboard shortcuts |

</details>

## Tech stack

| Layer | Choice |
|---|---|
| Query engine | [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm) 1.33 in a Web Worker, self-hosted and sealed |
| UI | React 19, TypeScript 6 |
| Build | Vite 8 with `@vitejs/plugin-react` |
| Grid | Custom canvas grid with virtual scroll and an ARIA mirror (`src/grid/Grid.tsx`) |
| SQL editor | CodeMirror 6 with `@codemirror/lang-sql` and autocomplete |
| Charts | Hand-drawn SVG (`src/components/Chart.tsx`), no chart library |
| Excel | `read-excel-file` and `fflate` in a Web Worker to read; a dependency-free streaming writer (`src/engine/xlsx-write.ts`) to export |
| Storage | Apache Arrow IPC snapshots in the Origin Private File System; saved views in browser storage |
| Landing figures | The [Hairline](https://www.npmjs.com/package/@lucasmarkes/hairline) line-figure engine, vendored in `src/hairline/` |
| Fonts | Plus Jakarta Sans and JetBrains Mono, self-hosted via Fontsource |
| Tests | Playwright (unit, end-to-end and perf projects) and `@axe-core/playwright` |
| Lint | oxlint |
| Hosting | Static site on Vercel; CSP and caching headers in `vercel.json`, offline service worker in `public/sw.js` |

## Run it locally

You need Node 22 (`.nvmrc`; `package.json` asks for `>=22.12 <23`).

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ with the production security headers
```

`npm run build` first runs `scripts/fetch-duckdb-extensions.mjs`. It downloads the Parquet and JSON extensions for the
bundled DuckDB version into `public/duckdb-extensions/`, so the site serves them itself, and checks each file against
the SHA-256 pinned in `scripts/duckdb-extensions.lock.json`. Without a build (plain `npm run dev`), Parquet and JSON
show a clear message instead; CSV and Excel always work.

Tests (more in [CONTRIBUTING.md](CONTRIBUTING.md)):

```bash
npx playwright install chromium   # once
npm run lint
npm run test:unit                 # pure functions on DuckDB in Node, seconds, no browser
npm test                          # build, then unit + end-to-end + perf against the production build
```

The end-to-end suite runs against `vite preview`, which sends the same Content-Security-Policy as production, so CSP
problems fail tests too. CI (`.github/workflows/ci.yml`) also runs `npm audit`, the bundle-size budget
(`scripts/check-bundle-size.mjs`) and the extension lock check.

### Deploy your own

1. **Vercel:** import the repo. `vercel.json` sets the framework, the install (`npm ci --ignore-scripts`), the security
   headers and caching.
2. If the site lives somewhere other than `https://sheetah.vercel.app`, set `VITE_SITE_URL` (see `.env`). It feeds the
   canonical link and the social-preview tags. `public/robots.txt` and `public/sitemap.xml` name the URL too.
3. Check the headers on the live site: `curl -sI https://<your-site> | grep -i content-security`.

The DuckDB engine is a ~36 MB `.wasm` file (~8 MB compressed over the wire). Vercel and Netlify serve it fine.
Cloudflare Pages caps single files at 25 MiB, so it isn't a good fit without splitting tricks. Each deploy stamps its
content hash into the service worker, so returning visitors get "A new version of Sheetah is ready · Reload" instead of
a stale offline copy.

## Project structure

```
src/
  App.tsx               the workspace: runs queries, composes header actions, undo/redo, hints, file loading
  main.tsx, theme.ts    entry point, light/dark/system theme
  sw-client.ts          service-worker registration and the "new version" prompt
  engine/               everything that talks to DuckDB, mostly pure SQL builders (unit-tested)
    db.ts               DuckDB-WASM bootstrap, sealing, the two connections, run lock, cancellation
    ingest.ts, sniff.ts file → table, what a file really is from its first bytes, the 1M-row sample
    result.ts           run SQL → windowed result set, range stats, column profile, export
    compose.ts          sort / filter / formula columns → readable SQL
    scan.ts, clean*.ts  the look-over when a table opens; cleaning numbers, dates and text
    pivot.ts, chart.ts  pivot and chart specs → GROUP BY / FILTER / GROUPING SETS SQL
    lookup.ts, stack.ts, unpivot.ts, compare*.ts   look up, stack, unpivot, compare two tables
    views*.ts           saved views, next month's file, views files
    statement.ts, match.ts, brs.ts, ageing.ts, books.ts, tally.ts, ids.ts   bank, books and month-end
    pii*.ts             personal-data detection and anonymize SQL
    share.ts, persist.ts   share links in the URL fragment; "keep my tables" in OPFS
    xlsx.worker.ts, xlsx-write.ts   Excel in (Web Worker) and out (streaming writer)
  grid/                 canvas grid and display formatting
  components/           landing, SQL editor, column menu, dialogs, chart, library, step chips, toasts
  hairline/             vendored Hairline engine and the two landing figures
public/                 service worker, unsupported-browser check, privacy page, icons, manifest
scripts/                DuckDB extension fetch + lock, bundle-size budget
tests/
  unit/                 Node unit tests (SQL run on the same DuckDB-WASM build)
  *.spec.ts             end-to-end suite against the production build under the real CSP
docs/                   research, UX copy review, design critique, accessibility audit, screenshots
```

## Current status

**Live at [sheetah.vercel.app](https://sheetah.vercel.app).** Version 1.0.0 was released on 2026-10-17, and
`main` carries a long list of unreleased changes since then (see [CHANGELOG.md](CHANGELOG.md)). There is no backend,
nothing is mocked, and every number in the app and in the demo video comes from the real engine. The demo's
3,000,000-row `orders.csv` is fictional, generated for the video.

Measured in headless Chromium at 1440×900:

| Scenario | Result |
|---|---|
| Engine start | ~1.6 s |
| Generate the 1M-row sample | ~0.6 s |
| Open a 63 MB, 2,000,000-row CSV | ~1.3 s |
| Full-range scroll, 1M rows | 16.6 ms median frame (60 fps), p95 ≈ 24 ms |
| Random jumps, 10M rows | 16.7 ms median frame |
| Import a 100,000-row .xlsx (2.9 MB) | ~2.4 s, types preserved |
| JavaScript before first paint | 173 KB gzip (CI budget 180 KB); the engine, editor, dialogs and charts load after |

**Known limits**

- Data lives in browser memory, so very large CSVs (several GB) can exceed the tab's limit. Parquet stays on disk as a
  view.
- Legacy binary `.xls` (pre-2007) isn't supported; re-save it as `.xlsx`.
- Saved views and kept tables live in this browser's storage, with no sync across devices. Kept tables are capped at
  5M rows each.
- Personal-data detection checks a 5,000-row sample with patterns and checksums. It can miss free text such as notes or
  addresses inside other columns, so review the columns before sharing.
- Browser support is current Chrome, Edge, Firefox and Safari (Chrome/Edge 111+, Firefox 114+, Safari 16.4+), but the
  end-to-end suite runs in Chromium only. "Keep my tables" needs Safari 26+ on Apple devices.
- Accessibility has been checked with axe-core and the accessibility tree, not yet with VoiceOver or NVDA.
- The product research behind it is desk research; there have been no user interviews yet.

## License

[MIT](LICENSE) © 2026 Suvraneel Bhuin
