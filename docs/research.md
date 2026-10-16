## Research Synthesis: Opening and querying big or sensitive data files

**Method:** Desk research (competitor products, vendor docs, practitioner blog posts) | **Participants:** none (no primary interviews yet)
**Date:** October 2026 | **Researcher:** Claude, for Suvraneel

### Executive Summary
People hit a wall when a CSV outgrows the spreadsheet they already know: Excel truncates at 1,048,576 rows and Google Sheets
rejects large imports and slows down long before its limits. The usual escape hatches (Python, paid big-data spreadsheets,
uploading to a cloud tool) add setup, cost, or a privacy problem. Browser-native DuckDB has made "real SQL on a local file,
nothing uploaded" possible, and several tools now offer it, but they mostly look like developer consoles. The gap Sheetah
targets: **spreadsheet-feel browsing of millions of rows plus SQL when you need it, with zero install and zero upload.**

### Key Themes

#### Theme 1: Spreadsheets break at a hard ceiling
**Prevalence:** Repeated across every source on large CSVs reviewed (vendor blogs, how-to guides).
**Summary:** Excel stops at 1,048,576 rows and silently keeps only the first part of the file; Google Sheets has a cell cap
and an import-size limit, and gets sluggish far earlier. Malformed quoting and encodings in big exports make it worse.
**Evidence:** Row Zero's guide to CSV row limits; Import2's "what to do if your CSV is too large to open".
**Implication:** The first job is simply *open the whole file and scroll it*, fast, with the familiar grid metaphor.

#### Theme 2: Sensitive data shouldn't leave the machine
**Prevalence:** Central claim of several recent tools (DuckPipe, privacy-first CSV toolkits).
**Summary:** Analysts handling client lists or survey respondents don't want to upload files to tools they don't control,
and some need to work offline.
**Evidence:** DuckPipe (asc.org.uk) is built around processing client files "with nothing but a browser".
**Implication:** "Nothing is uploaded" must be true, visible, and verifiable (self-hosted engine, no CDN, no analytics).

#### Theme 3: Setup is the real barrier, not SQL itself
**Prevalence:** Strong in practitioner write-ups.
**Summary:** Python scripts need environments; specialist tools need licences; handing work to non-technical colleagues is
hard. People want something that opens in a tab and can be re-run on next month's export.
**Implication:** No sign-up, instant start, and a reusable query (history / copyable SQL).

#### Theme 4: Existing browser SQL tools feel like consoles
**Prevalence:** Observed across SQL Workbench, Duck UI, DuckDB shell-style tools.
**Summary:** Strong engines, but the result view is a basic table, often paged, and the experience starts from a blank editor.
**Implication:** Differentiate on the grid (smooth scrolling of every row, sort/filter/profile from the header) and on a
calm, guided first run (a one-click demo dataset).

### Insights → Opportunities

| Insight | Opportunity | Impact | Effort |
|---------|-------------|--------|--------|
| Excel/Sheets cap rows and choke on big files | Canvas grid that scrolls 1M+ rows at 60fps | High | High |
| Uploading sensitive files is a blocker | Self-hosted DuckDB-WASM, no network calls after load, say so clearly | High | Low |
| Blank SQL editors intimidate | Header click → sort / filter / profile; SQL is optional | High | Med |
| People re-run the same work on new exports | Query history + copy SQL + export result to CSV/Parquet | Med | Low |
| First-run friction | "Try a 1,000,000-row demo" generated in-browser, no download | Med | Low |
| Spreadsheet users think in formulas | "Add column" with an expression (SQL under the hood) | Med | Med |

### User Segments Identified
| Segment | Characteristics | Needs | Size |
|---------|----------------|-------|------|
| Ops / finance analysts | Live in Excel, get huge exports | Open it all, filter, sum, export | Large |
| Consultants & researchers | Handle client or respondent data | Local-only, offline, repeatable | Medium |
| Developers & data folks | Know SQL | Fast ad-hoc SQL on Parquet/CSV/JSON | Medium |

### Recommendations
1. **Grid first** — a fast, spreadsheet-like view of the entire file is the core promise (Themes 1, 4).
2. **Privacy you can verify** — self-host every byte; no third-party requests (Theme 2).
3. **Progressive SQL** — point-and-click sort/filter/profile, with an editor for when you outgrow it (Themes 3, 4).
4. **Lower priority** — Excel (.xlsx) import, saved workflows, sharing a query as a file.

### Questions for Further Research
- Which file sizes do target users actually hit (100 MB? 5 GB?), and on what hardware?
- Do non-SQL users discover header actions without guidance?
- How important is .xlsx input versus CSV?

### Methodology Notes
Desk research only, from public product pages and blog posts; no interviews or usage data. Evidence skews toward vendors
with an interest in the problem. Validate with 5 short user tests once the prototype is live.

Sources: rowzero.com/blog/csv-row-limit · import2.com/csv/what-to-do-if-your-csv-is-too-large-to-open ·
asc.org.uk (DuckPipe) · producthunt.com (SQL Workbench) · duckdb.org/docs (WASM instantiation)
