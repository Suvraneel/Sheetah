## Design Critique: Sheetah (refinement pass)

### Overall Impression
The landing reads instantly: one huge promise ("Open the whole file.") and one obvious action. The workspace feels calm
for a data tool. The biggest opportunity was balance: the hero's right half was empty, and the editor took more room
than one-line queries need.

### Usability
| Finding | Severity | Recommendation | Status |
|---|---|---|---|
| Column headers don't look clickable, and they are the main way into sort/filter/profile | 🟡 Moderate | Hover state on header cells + pointer cursor; status-bar hint names the action | Fixed |
| Editor is 148px tall for typical one-line queries, pushing the grid down | 🟡 Moderate | 112px default; scrolls for longer SQL | Fixed |
| On mobile the sidebar's column lists push the grid below the fold | 🟡 Moderate | Hide column lists and cap the sidebar height under 960px | Fixed |
| Keyboard hint used ⌘/↵ glyphs that were tiny in the mono font, and wrong on Windows | 🟢 Minor | Sans font; show Ctrl + Enter off-Mac | Fixed |
| Formula placeholder suggested `order_id * quantity` | 🟢 Minor | Skip id-like columns when building the example | Fixed |
| Canvas grid content isn't exposed to screen readers | 🟡 Moderate | Hidden ARIA grid mirror with `aria-activedescendant` (see accessibility.md) | Fixed |

### Visual Hierarchy
- **What draws the eye first**: the headline and its highlighter mark, which is correct for a first visit.
- **Reading flow**: headline → lede → drop zone → demo button. The right column now carries a supporting proof point
  (the Excel row limit, struck through), so the eye finishes on the CTA instead of empty space.
- **Emphasis**: in the workspace, data comes first. Chrome is quiet hairlines; colour is reserved for selection and active filters.

### Consistency
| Element | Issue | Recommendation |
|---|---|---|
| Wording | "Local only" vs "runs on this device" | Unified to "Runs on this device" (see ux-copy.md) |
| Buttons | All pills; primary actions carry a nested icon circle | Keep |
| Radii | 28px shell / 22px core, 12–14px for inputs, 999px for pills | Keep the scale |

### Accessibility
- **Color contrast**: body text and muted text (≈62% opacity) pass AA on both themes; faint labels (≈40%) are used only for non-essential metadata.
- **Touch targets**: buttons ≥ 36px, primary ≥ 44px.
- **Text readability**: 15px base, 13px mono in the grid, 1.55 line height.
- **Motion**: all transitions respect `prefers-reduced-motion`.

### What Works Well
- One clear promise, backed by a live 1M-row demo that needs no file.
- Point-and-click actions write visible SQL, which teaches without forcing it.
- The status bar's live count/sum/average makes it feel like a spreadsheet.

### Priority Recommendations (next)
1. ~~**Accessible grid mode**~~: shipped (ARIA mirror + active descendant); see accessibility.md.
2. ~~**Saved views**~~: shipped, with table remapping for next month's export.
3. ~~**.xlsx import**~~: shipped (all sheets, parsed in a Web Worker).

## Design Critique: visual pass 2

Re-reviewed against a high-end visual bar at 1440px and 390px, light and dark.

| Finding | Severity | Fix |
|---|---|---|
| Workspace scrolled sideways on phones (390px rendered 477px wide): "Open file" off-screen, "Save view" clipped past the left edge (`justify-content: flex-end` on an overflowing row) | 🔴 Critical | Secondary actions go icon-only under 768px (labels kept as accessible names); run bar no longer right-justifies |
| Mobile sidebar (168px) was filled by the "Keep my tables" setting, so no table was visible | 🟡 Moderate | Setting moved after the tables (DOM order too, so focus order matches) and pinned to the sidebar foot on desktop |
| "Network locked" badge was 4.37:1 in light mode (axe can't see it behind the blurred topbar) | 🟡 Moderate | `--ok` light → `#0d7340` (5.9:1) |
| Bento read as a template: four of five cards were icon + title + one sentence; one 7-column card held a single line | 🟡 Moderate | Section heading added; icon circles replaced by sketches of the real UI (composed SQL, network log, selected-range stats, export files + SQL-only share link), assembling on entry with transform/opacity only and rendering finished under reduced motion |
| Drop zone had no drop affordance (its dashed border was dead CSS) and said "drop" on phones | 🟢 Minor | Concentric dashed tray; touch devices read "Tap to choose a file" |
| Hero CTA column had three different left edges | 🟢 Minor | One edge |
| Native checkboxes in OS blue; squared Grid/Chart toggle among pills; `.btn-danger-outline` used but undefined | 🟢 Minor | `accent-color`, pill toggle, Cancel styled as danger |
| Running indicator animated `background-position` (repaint per frame); static topbar carried a backdrop blur; chart transitions used default `ease` | 🟢 Minor | Transform-only sweep clipped by the grid core; blur removed; shared easing curve |

## Enhancements: product shot, export menu, fitting editor

- **Landing product shot** (`ProductShot.tsx`): an HTML replica of the workspace in the app's own tokens. Every value is
  real output of the sample (the query returns 459,688 rows; the status bar sums the selected cells). Narrow panels shed
  context columns, never the selected one.
- **Export menu** (`ExportMenu.tsx`): CSV (Excel-safe), CSV with exact values, and Parquet behind one WAI-ARIA menu
  button, replacing two buttons and a checkbox. Portalled so the mobile toolbar's scroll fade can't hide it; flips
  upward on short screens; focus stays on the button while the export runs.
- **Fitting editor** (`EditorResizer.tsx`, `SqlEditor.tsx`): fits the query being edited (3 to 8 lines, then scrolls);
  a keyboard-operable splitter pins a height (persisted, re-clamped to the window). When the editor isn't focused it holds
  its height, so SQL written by header clicks never moves the grid under the pointer.

An adversarial review (3 reviewers, 3 refuting verifiers, live browser) confirmed 7 defects in the first cut, all fixed:
menu invisible on phones (clipped by the toolbar mask), focus lost after export, menu cut off on short screens, stale
`aria-valuenow`, unclamped stored height, grid collapsing in the stacked layout, and the product shot clipping its own
selection below 1240px. The e2e suite also caught header filters shifting the grid 45px, which led to the hold-height rule.

## Starter queries, theme, shortcuts, phone layout

- **Starter queries** for the sample (revenue by city, monthly revenue as a chart, best sellers, return rate), dismissible.
  Exposed a chart bug: already-monthly data was bucketed by week, so January plotted as "Dec 26". Buckets now never go
  finer than the data's own grain; x labels thin out to fit narrow charts.
- **Theme**: System / Light / Dark. `public/theme.js` (same-origin, CSP-safe) sets `data-theme` before first paint; all
  dark styles key off it, and the canvas grid repaints on the attribute.
- **Shortcut sheet** on `?` or the topbar button, listing only shortcuts verified to work.
- **Phone**: the sidebar is a modal bottom sheet; the SQL collapses to a one-line peek; the grid gets ~45% more height.

An adversarial review (4 reviewers, 4 refuting verifiers) confirmed 16 defects, all fixed: chiefly focus being dropped
to `<body>` (starter run, strip dismiss, sheet picks, phone run, dialogs under StrictMode), plus theme edge cases (storage
blocked, "Clear all local data"), stale sample identity, overlapping chart labels, and shortcut-sheet layout. The suite
also caught `<aside role="dialog">` (not allowed by ARIA in HTML).

## Housekeeping pass

- Screenshots in `docs/screenshots/` regenerated from the production build (same seven scenes, 1440×900).
- Perf re-measured on the production build: 1M-row full-range scroll holds a 16.7 ms median frame (p95 ≈ 17.5 ms).
- Fixed two older bugs found while reshooting: the column menu ran off the bottom of the screen (it was placed before
  its histogram rendered), and chart screen-reader tables put `sr-only` on the `<table>` itself; tables ignore height
  limits, so the "1px" table laid out every row and added ~200px of empty scroll to the column menu and chart panel.

## The monthly export

A hands-on pass with a realistic export (a sales register with ₹ amounts as text, sub-totals, a grand total, empty
rows, a region named once per group, and month columns) set the next round of work around one recurring job: the same
report arrives every month and needs the same tidying.

- **Rows that aren't data** are counted on open and offered as one chip ("Leave out 4 total lines and 3 empty rows"),
  applied before any clean-up so filling down can't bring them back. "Grand/Sub-total" count anywhere; a plain "Total"
  only in the first text column, in a row with empty cells or whose numbers add up to the rows above it. A fuel brand
  called Total stays data.
- **Replace a value**, **percentages** shown as 18% (only for columns converted from "18%" text), **unpivot** for
  month/quarter/year columns, **Excel title lines** above the column names left out.
- **Save the steps, run them next month**: a saved view remembers its table's columns, and a file with the same columns
  under a new name is offered the view in one click.
- **A messy sample** on the landing page, whose tidied numbers add up to its own Grand Total (a unit test checks).
- **Phones**: suggestions and applied steps are one swipeable row each; six steps stacked one per line had pushed the
  grid off the screen.

Two independent code reviews of these commits found 19 defects, all fixed: chiefly an empty month column turning
unpivoted numbers into text, saved views re-pointing columns that shared the table's name, percent display guessed from
column names (0.42% shown as 42%), a replace step silently disabled by a later case change, two toasts overlapping and
blocking each other's buttons, and stale suggestions on a table replaced under the same name.

## First contact: files, errors and where rows came from

A UX audit (one reviewer working the production build as a spreadsheet user would) ranked what still made people stop
and guess. The fixes, in its order:

- **The file that isn't what it says**: a PDF or image renamed .csv, a zip, a Word file, an encrypted .xlsx (an OLE
  container, so it read as "old .xls") now say what they are and what to do. The ".xls" that banks and ERPs export as a
  web page or Excel 2003 XML opens like a workbook (in its declared encoding, leaf tables only, row and column spans
  left empty as Excel does); Excel's UTF-16 "Unicode text" opens too. A CSV with only column names says so.
- **SQL errors in a spreadsheet person's words**, with a one-click fix where one is safe: `city = "Pune"` → *Use
  'Pune'*; a misspelt column or table → *Use total*. The fix rewrites names outside text and comments only.
- **Fill down offered**, not just available: the first columns from the left, whose first row is named, with gaps that
  sit under their value (a phone number given now and then has values next to each other and isn't offered).
- **Where rows came from**: counted, unpivoted or renamed rows carry a quiet chip (*Rows counted by product, from
  orders*) that goes back with every step the rows had.
- **Paste** cells from a spreadsheet anywhere outside the editor to make a table.
- Smaller: pivot charts without the Total row, a sort chip that says ascending or descending, date layouts named as
  patterns, the Export menu bringing itself into view on phones, a narrower row-number gutter on phones, Alt+↓ with
  nothing selected.

A code review of the batch found 14 defects, all fixed before commit: chiefly plain-words load errors replaced by a
generic "didn't read as any of them", windows-1252 web pages decoded as UTF-8 (£ and é lost), nested layout tables
read as one cell, DuckDB's own `countif` mistaken for the spreadsheet one, a column named Order told "ORDER is in the
wrong place", and lookups on a plain object answering `constructor`. The bundle check itself was found to under-count
what the page loads first (13 KB of preloaded shared chunks); it now reads `index.html`, and five modules moved out of
the first download to pay for the new features.

## Second audit: clicks and SQL together, trust, bank statements

A second audit drove the production build as someone with real monthly files (a bank statement with a summary
footer, a Tally export with title lines, a 600,000-row register, an en-US reader with day-first dates) at 1440×900,
1280×720 and on a phone. Its top finding: SQL typed against a tidied table silently read the raw file, so the totals
the tidy-up had removed came back. What changed:

- **Clicks and SQL work together**: typed SQL that reads a table with tidy-up steps is offered *Run on the tidied
  rows* (a `WITH` of the same name, which shadows the table). Only for queries that read, never for one that is the
  steps' own SQL edited, and never for INSERT or CREATE … AS (it would copy rows twice).
- **Trust**: leaving out total lines is tied out against the rows left ("Invoice Total comes to 721,715, counted
  once"); a result left on screen by a query that failed is dimmed.
- **Next month**: saved views bring their steps back as chips, compared to the view's SQL token by token (comments
  aside) so a views file can't run steps its SQL doesn't show; the day/month swap and the tie-out's sums stay out of
  saved views.
- **Files as they come**: Cr/Dr amounts (only when some are Dr: on its own, "₹12 Cr" is twelve crore), "Convert
  anyway" with a footer in the column, empty leading columns set aside (they hid the Total in the next column, which
  doubled the sum), stray spaces, ambiguous dates read the other way from the reader's habit, total lines in tables
  of up to 5 million rows.
- **Keyboard and layout**: focus lands on the rows or the next chip instead of the page; notices wait under dialogs;
  the editor shows focus; generated SQL holds at four lines on short screens.

A code review of the batch found 12 defects before commit, all fixed: chiefly the tidied-rows offer firing for
INSERT … SELECT (rows copied twice) and for the steps' own decimal-comma SQL (1234,567 read as 1234567), Cr read as a
sign in "₹12 Cr", the day/month swap saved into views (it would corrupt next month's correctly read dates), the
empty-column check scanning five million rows three times, and a re-pointed view silently losing its chips.
