## Accessibility Audit: Quarry
**Standard:** WCAG 2.1 AA | **Date:** October 2026 | **Method:** axe-core 4 (WCAG 2.0/2.1 A + AA + best practice) on the landing page, workspace, column menu and add-column dialog in light and dark themes; scripted keyboard pass; accessibility-tree inspection; 200% zoom check. No manual VoiceOver/NVDA session yet.

### Summary
**Issues found:** 9 | **Critical:** 1 | **Major:** 4 | **Minor:** 4 | **Open after fixes:** 0 automated; real screen-reader testing still to do

### Findings (all fixed)

#### Perceivable
| # | Issue | WCAG | Severity | Fix |
|---|---|---|---|---|
| 1 | Canvas grid content invisible to assistive tech | 1.3.1 Info and relationships | 🔴 Critical | Hidden ARIA `grid` mirrors the on-screen window (header row + visible rows, `aria-rowindex`/`aria-colindex`, `aria-sort`, `aria-selected`); `aria-rowcount` reports the full row count |
| 2 | "Faint" metadata text (types, counts, hints) at 2.7–3.5:1 | 1.4.3 Contrast | 🟡 Major | Raised the faint token to 60% / 58% opacity (≥ 4.8:1) and muted to 70% / 72% |
| 3 | Landing feature titles jumped from h1 to h3 | 1.3.1 | 🟢 Minor | Feature titles are h2 |

#### Operable
| # | Issue | WCAG | Severity | Fix |
|---|---|---|---|---|
| 4 | Tab inside the SQL editor indented instead of moving focus (keyboard trap) | 2.1.2 No keyboard trap | 🟡 Major | Removed Tab-to-indent; Tab and Shift+Tab move focus |
| 5 | Column menu (sort/filter/profile) only reachable by mouse | 2.1.1 Keyboard | 🟡 Major | Alt+↓, Shift+F10 or the Menu key opens it for the active column; Escape returns focus to the grid |
| 6 | Dialogs didn't trap focus or restore it on close | 2.4.3 Focus order | 🟡 Major | `useDialog` traps Tab, closes on Escape and returns focus to the control that opened it |
| 7 | The grid was ~24 Tab stops from the top | 2.4.1 Bypass blocks | 🟢 Minor | "Skip to results grid" link, visible on focus |

#### Robust
| # | Issue | WCAG | Severity | Fix |
|---|---|---|---|---|
| 8 | `role="dialog"` set on a `<form>` | 4.1.2 Name, role, value | 🟢 Minor | Dialog role and `aria-modal` on a wrapper, labelled by its heading |
| 9 | Missing `main` landmark on the landing page, no h1 in the workspace | 1.3.1 / best practice | 🟢 Minor | Added `<main>` and a visually hidden h1 |

### Color Contrast Check
| Element | Ratio (light) | Ratio (dark) | Required | Pass? |
|---|---|---|---|---|
| Body text on surface | 18.9:1 | 15.7:1 | 4.5:1 | ✅ |
| Muted text | 7.1:1 | 8.6:1 | 4.5:1 | ✅ |
| Faint text on surface / sunken | 4.95 / 4.81:1 | 5.98 / 5.77:1 | 4.5:1 | ✅ |
| Accent (links, selection, sort) | 6.1:1 | 7.2:1 | 4.5:1 | ✅ |
| Headline on the lime highlight | 16.7:1 | — | 3:1 (large) | ✅ |

### Keyboard Navigation
| Element | Tab | Enter/Space | Escape | Arrows / other |
|---|---|---|---|---|
| Skip link | 1st stop | Focus the grid | — | — |
| SQL editor | Moves in and out | New line; ⌘/Ctrl+Enter runs | Closes autocomplete | Autocomplete with ↑/↓ |
| Grid | One stop | — | Clears the selection | Move; Shift extends; ⌘/Ctrl jumps to edges; ⌘/Ctrl+C copies; Alt+↓ opens the column menu |
| Column menu | Cycles controls | Applies | Closes, focus back to grid | — |
| Dialogs | Trapped | Submits | Closes, focus restored | — |

### Screen Reader (accessibility-tree check)
| Element | Exposed as | Notes |
|---|---|---|
| Grid | grid "Results: 1,000,000 rows, 11 columns", with usage help via `aria-describedby` | Row count includes the header row |
| Active cell | gridcell "Diya Smith", row 3, column 3, header "customer, varchar", selected | Tracked with `aria-activedescendant`; follows jumps to row 1,000,000 |
| Range selection | Polite live region: "Selection: 5 values, sum 16,850.28, average 3,370.06…" | Same numbers as the status bar |
| Column headers | columnheader "total, double", with `aria-sort` when sorted | — |

### Other checks
- **200% zoom** (720×450 CSS px): no horizontal page scroll on the landing page or the workspace.
- **Reduced motion**: every animation and transition is disabled under `prefers-reduced-motion`.
- **Performance cost of the mirror**: scrolling stays at a 16.6 ms median frame (60 fps).

### Next
1. Test with VoiceOver (Safari) and NVDA (Firefox/Chrome). Automated checks and tree inspection can't confirm how announcements sound.
2. Consider announcing new results ("1,000,000 rows loaded") after each query run.
