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
