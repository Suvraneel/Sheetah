# Changelog

All notable changes. Dates are release dates; versions follow [semver](https://semver.org).

## Unreleased

### Added
- **Bank reconciliation statement**: from the payments matched, *Reconciliation statement* is laid out as an
  accountant writes one (Particulars, Date, Amount, Total): from the bank's closing balance (where its running
  balance ends, read the way round its rows run), each heading (deposits not yet credited, cheques not yet
  presented, the bank's own credits and debits) with its lines under it, to the balance the books should show.
  Lines left over say where the same amount is on the other side, up to a month away; a line with no date is
  listed, not matched, and not counted in the statement (which says so). What's left is said as money in and money
  out. A **cheque or reference number** on both sides pairs lines first, however late the cheque cleared. Compare
  suggests matching when the two tables are a statement and its books (as tidied).
- **Opening + in − out = closing**: a statement's opening and closing balance lines, once left out, check the rows
  between them (*Opening 10,000.00 + in 2,000.00 − out 5,000.00 = closing 7,000.00, as the file says*, or how far
  apart). A saved view keeps each period it has run on, so a month is checked against the one just before it,
  whichever ran last. Money in checks is shown to the paisa; passed checks fold into one line until shown.
- **Ageing**: a list of open bills (Tally's Bills Receivable, an outstanding invoices export) is offered *Ageing by
  Party's Name*: each party's money not yet due, 0–30 days, 31–60, 61–90, 91–180 and over 180, biggest first, as on
  the day asked (today, or the month's end). Dr and Cr are read; an advance shows on account.
- **Totals by ledger**: a day book (each voucher's lines, each to its ledger) sums each ledger's debits and credits
  and its net, with a total where the debits meet the credits.
- **GSTIN, PAN and IFSC checks**: a column named for one is checked as the table opens: a GSTIN by its check
  character (a business's, a TDS deductor's, a UIN), a PAN and an IFSC code by their shape, and a PAN against its
  GSTIN. A wrong one is named above the rows (NA, URP and the like aren't counted).
- **A bank's own export, tidied**: a statement's summary below its transactions is offered for leaving out
  (*undated lines*); an opening balance written in Debit or Credit is a balance line; a total label is found under
  Particulars or Party when the first column is dates or codes; balances written *2,11,150.00 Cr* are checked.
- **Financial years**: pivots group dates by financial year (April to March: *FY 2024-25*) and its quarters.
- **Tally**: an item invoice's sales ledger is read from its stock lines, a foreign-currency amount in rupees; a
  voucher whose debits and credits don't agree is named, and a trial balance's totals are checked.
- **Bank statements, signed and checked**: a statement with money in and money out in two columns (Deposit /
  Withdrawal, Credit / Debit) is offered *Add signed amount*, one column that sums, charts and pivots. With a running
  balance, each balance is checked against the one before (oldest or newest first): *Every Closing Balance follows
  from the row above*, or the row where a line is missing or doubled, and by how much. Its *Opening Balance* and
  *Closing Balance* lines (and *Balance b/f*, *Carried forward*) are offered for leaving out with the total line.
  *Money in and out by month* summarises it: each month's money in, money out, the net and how many lines.
- **Checks that travel with a saved view**: running a view on next month's file checks it again, the running
  balance and the total lines against the rows, and says what passed or which line is missing. A statement is
  checked to open where the last one closed (*Opens at 7,000.00, where stmt_apr closed*, or how far apart: a statement
  missing in between), whether or not each month's file has the same name, and the rows are counted against last
  time. Checks sit above the rows (not in a passing
  toast) while the step they checked is there. What a view last ran on stays in this browser, never in a views file.
- **Tally's own XML opens**: a Day Book or vouchers export becomes one row per ledger line (date, voucher type and
  number, party, narration, ledger, Debit, Credit: Tally's minus is a debit), and a report (a Trial Balance) one row
  per account. UTF-16, Tally's default, and the control characters Tally writes (`&#4;`) are handled.
- **India by its time zone**: a browser left on US English in India reads numbers and dates as India does (1,00,000;
  01/04/2024 is 1 April), so two-digit years, the date hint and number grouping follow suit.
- **Match payments, bank against books**: from Compare, *Match payments by amount and date* pairs each line with
  one line of the other table of the same amount, dated up to a few days apart (3 to start with): same-day lines
  first, occurrence by occurrence, then each the other's nearest, in rounds, so a missing line doesn't pull its
  neighbours out of their pairs and five payments of 500 on a day pair up at once (50,000 lines a side in about two
  seconds). Tables tidied by steps are matched as tidied; Cr/Dr amounts are read; a line whose amount can't be read
  is listed, not lost. A cash book that writes money the other way round is noticed and turned round (and the
  reader's say stands). The result lists every line once, *matched* side by side or *only in bank_apr* / *only in
  books_apr*, with the totals of what's left over said as it opens.
- **Categories from words**: *Group Narration into categories* (offered once a statement's amount is signed, and in
  any text column's menu) adds a category column from rules like *swiggy, zomato → Food and dining*: matched where a
  word starts (*ola* is Ola and OLACABS, not COLA), the first rule winning, the rest *Other*. The column's common words
  are listed to pick from (payment rails and banks left out; words in any script, and a word starts after a digit
  or _ too, so HDFC0MERCHANT and UPI_ZOMATO match), the usual categories are one click, and each says how
  many rows it gets. The rules are readable SQL, kept with a saved view; *Pivot by month* then lays each category out
  month by month. *Edit these categories…* in the column's menu changes them.
- **Two-digit years read the right way round**: `01/04/24` is 1 April 2024, not 24 April 2001 (the file reader's
  guess), and `01/04/24 10:30` is a time, not the year 1. A file read the other way would put its dates years
  from today, so one that really is year first (`24/01/31`) stays as it is.
- **Charts by day, week, month, quarter or year**: a *By* control for date axes (a three-month statement now starts
  by week, not 90 spiky days). A pivot charts in its own order (months by date), its Total row left out, titled
  *Sum of amount* once. Amounts stored as text are named in Chart and Pivot with *Convert to numbers*.
- **Undo and redo** for every header action (sort, filters, find, duplicates, clean-up, look-ups, hidden columns):
  ⌘/Ctrl + Z and ⌘/Ctrl + Shift + Z, or the Undo / Redo links. Quick successive clicks build on each other instead
  of the last one silently dropping the one before.
- **Stack tables into one** (twelve monthly exports → one table), matched by column name, with a `source` column;
  offered when three or more similar files are opened.
- **Hide a column** and **Count rows by a column** from the column menu; for dates, **add Year / Month / Weekday /
  Hour columns**; for text, **split into columns** at a separator.
- **Look up** values from another table (VLOOKUP): pick the table and the matching columns (suggested by name), see
  how many rows match and whether keys repeat, then bring any columns over. Rows are never duplicated: the first
  match wins. Keys typed differently (number vs text) still match; case and spaces are ignored unless you say not to.
- **Clean a column** in place: numbers stored as text (₹1,200 · 1,00,000 · (250) · 12% · 12,5 in decimal-comma
  locales), dates in any common layout including two-digit years (DD/MM vs MM/DD chosen by the data, then the
  reader's locale), extra spaces, blanks, UPPER / lower / Title case; steps stack (trim, then Title case). Offered in
  the column menu with how many values won't convert; a file with amounts stored as text gets a one-click "Convert".
  A value that doesn't fit is left empty rather than misread ("12,5" never becomes 125, "15/08/24" never the year 24).
  Codes with leading zeros, PIN codes, phone numbers and ID columns are never converted automatically.
- **Fill down**: empty cells take the value above, for reports that name a group only on its first row. Offered
  when a file opens, for the first columns from the left whose first row is named, at least 3 rows in 10 are empty
  (not counting empty rows and total lines) and a value is seldom followed by another, so a column filled in now and
  then (a phone number) isn't mistaken for one.
- **Your SQL on the tidied rows**: a query typed against a table that has tidy-up steps reads the file as it is
  (total lines, amounts as text). Sheetah says so and offers *Run on the tidied rows*, which runs the same query on a
  `WITH table AS (…)` of the steps (your own WITH and comments are kept). When the query failed on what the steps
  fix (text where a number belongs), that's the error's own fix, in place of advice to convert a converted column.
- **Tie-out**: leaving out total lines says whether they come to exactly the rows left, column by column (sub-totals
  and a grand total come to twice them): *The totals match the rows exactly: Invoice Total 721,715*, or *The totals
  say Withdrawal Amt. is 218,890.84; the rows come to 218,296.92: 593.92 short*. A closing balance or a rate on the
  total line isn't something the rows add up to, and is left alone.
- **Saved views keep their steps**: a view saved from a table's header actions comes back as chips, each removable,
  on next month's file too (steps that aren't exactly the view's SQL are ignored, so nothing runs unseen).
- **More suggestions**: tidy stray spaces in names; hide empty columns (an export's empty first column no longer hides
  the total lines in the next one); read dates month first (or day first) when every day is the 12th or before and
  the file reader's guess differs from how the reader writes dates; total lines in tables of 500,000 to 5 million
  rows (a quick pass over the lines that mention "total").
- **Bank statements**: amounts marked Cr and Dr convert to plus and minus when some are Dr (on its own, "₹12 Cr" is
  twelve crore), in the column menu with a note to check;
  a column with a footer among its amounts offers *Convert to number anyway* with how many values are lost.
- **A missing comma** (`SELECT city customer`, which runs with the cities under "customer") is pointed out after the
  query runs, with *Add the comma*.
- **More fixes for SQL errors**: a column name with spaces written without quotes (*Use "Taxable Value"*), and dates
  written 01/04/2024 (*Use '2024-04-01'*, day or month first by the values, then the reader's habit). DuckDB's quote of
  Sheetah's own wrapper is left out of messages, and a result left on screen by a query that didn't run is dimmed.
- **A pivot to Excel with the rows behind it**: one workbook, the summary on one sheet and the rows it was made
  from on the next, ready to send.
- **One value written two ways**: a text column's menu offers merging look-alikes into the common spelling (*Hydrabad →
  Hyderabad*, *new delhi → New Delhi*): the same words in another case or spacing, or a typo of a value at least five
  times as common. Codes and numbers are never paired.
- **Look up says what didn't match**: *Not in products: Z-9 (5 rows), Q-1 (2 rows)*, so a 43% match explains itself.
- **Compare** opens on the pair worth comparing: the open table's other version, or the two tables most alike.
- **Paste cells as a table**: a range copied from Excel, Google Sheets, Numbers or Sheetah's own grid, pasted on the
  page (outside the editor and inputs), opens as a table like a dropped file, with the usual suggestions.
- **Where these rows came from**: a result made from other rows (Count rows by, columns turned into rows, a row as the
  column names) says so above the grid, *Rows counted by product, from orders*, and one click goes back with every
  step the rows had.
- **Files that are something else inside**: an ".xls" that is a web page's table or Excel 2003 XML Spreadsheet
  (bank statements, ERP exports) opens like a workbook, title lines and all; Excel's UTF-16 "Unicode text" opens as
  text. A PDF, an image, a zip, a Word or an old binary .xls says what it is and what to do, in plain words; a file
  that still won't read keeps DuckDB's message under Details. A CSV with only column names says so.
- **SQL errors in spreadsheet terms**: text in double quotes ("Pune" is a column's name in SQL: use 'Pune'), a table
  that isn't there (with your tables listed, never DuckDB's own catalog), Excel functions (VLOOKUP → a join or Lookup,
  SUMIF → sum(x) FILTER (WHERE …)), columns neither grouped nor totalled, totals in WHERE, an unclosed quote, a query
  that ends too soon, clauses out of order, and an Excel formula pasted as SQL. DuckDB's own message stays under
  Details. Text in double quotes and a misspelt column or table come with a one-click fix (*Use 'Pune'*, *Use
  total*) that changes only those names, never text in quotes or comments, and runs the query again.
- **Rows that aren't data**: a report's total lines and completely empty rows are counted when a file opens and
  offered for leaving out in one click (a removable, undoable chip), before any clean-up runs, so sums and counts
  aren't doubled. "Grand total" and "Sub-total" count anywhere; a plain "Total" or Excel's "North Total" only in the
  first text column of a row with empty cells, and only while there are few of them, so a fuel brand called Total
  stays data. A "Total" line with nothing empty in it counts when its numbers add up to the rows above it.
- **Replace a value** in a text column (Bangalore → Bengaluru, N/A → empty), matched ignoring case and stray spaces; each
  replacement is its own removable step and runs before a conversion, so "nil" can become 0 before the column turns
  into numbers.
- Columns converted from **percentages** ("18%" text) show as 18% in the grid and the column menu, a filter typed
  as 12 or 12% there means 12%, and the Excel export gives them a percent format (the value stays 0.18).
- Columns behind the "Convert" suggestion say so in their header ("number as text", "date as text") until they're
  converted.
- Suggestions follow their table: one opened from the list is looked over the first time it's seen (not just the
  file opened first), a table opened again gets its suggestions back, and a table replaced under the same name is
  looked over afresh. Unpivoted month names are offered as dates.
- A long query's scrolling area in the SQL editor is reachable by keyboard for accessibility checkers (axe flagged
  `scrollable-region-focusable` once clean-up steps made the SQL overflow); a11y tests now cover suggestions, applied
  steps and the clean-up menu.
- Screen readers hear every result's row count ("16 of 23 rows, 8 columns") from a status that is always in the page
  (so the first result is read too), without the timing.
- Each applied step's chip shows the SQL it adds on hover ("Remove filter · WHERE city = 'Pune'", "Undo this cleaning ·
  number_from_text(amount)"), so the clicks teach the SQL they write.
- **Shift+Space** selects the active cell's row and **Ctrl+Space** its column (as in Excel), for the status bar's
  count, sum and average or "Use row N as column names", without moving the view. The screen-reader mirror always
  holds the active cell, so `aria-activedescendant` never points at one that isn't rendered.
- The screen-reader grid reads values as they're drawn (1,234.50, 18%), not as stored.
- On phones, suggestions and applied steps are one swipeable row each, so six clean-up steps no longer push the
  grid off the screen.
- **The first column stays in view** while a wide table scrolls sideways (twelve month columns, and you still see
  which branch each row is), like a spreadsheet's frozen column; clicks, menus, resizing and keyboard movement all
  respect it. Not pinned when the column is wider than 40% of the grid.
- **Next month's file, recognised**: a saved view remembers its table's columns, so when a file with the same
  columns is opened under another name ("sales_register_may"), Sheetah offers to run the view on it in one click.
  Tidy April's export once, save the steps, and May's takes a click. In the Saved list such a view says "fits
  sales_register_may", and re-pointing a view by hand starts from the table with its columns.
- **Export and import saved views** (Saved › Export views / Import views…): a small JSON file with names and SQL,
  never data, checked field by field on the way in; a view already saved is skipped and other clashing names get
  "(2)". An imported view shows its SQL for review before it first runs, and one that fits the table on screen is
  offered at once ("Review it"), so a colleague's tidy-up for the same export is a click and a check.
- **Turn columns into rows** (unpivot): a report laid out one column per month, quarter or year becomes one row per
  month, ready to filter, chart and pivot. Offered when a table opens with such columns (Jan … Dec, Q1 … Q4,
  FY2023, Apr-24), or from any column's menu; Undo brings the wide layout back. Month names like "Apr-24",
  "Aug 2024" or "2024-08" then convert to dates from the column menu, so they sort and chart in time order. A month
  not reached yet (an empty column) doesn't turn the numbers into text; empty cells can be kept as rows. Financial
  years (2023-24) count as years, and a survey's Q1 … Q20 aren't taken for quarters.
- **Column names on a later row**: when titles above the names were read as data (most columns get made-up names
  like column1), the row holding the names is found and offered ("Use row 2 as column names"); any row near the top
  can also be picked by clicking its number. Plain SQL, undoable; the columns that turn out to be amounts are then
  offered as numbers.
- **Excel reports with title lines** ("ABC Traders", "Sales Register", a date range) above the column names: those
  lines are left out and the real column names are used, with a note saying so.
- **A messy sample export** on the landing page: a sales register with ₹ amounts as text, sub-totals, a grand total,
  empty rows and a region named once per group, to try the clean-up on. Its numbers, once tidied, add up to its own
  Grand Total (a unit test checks).
- **Excel export** (.xlsx): numbers stay numbers, dates are real dates, a bold frozen header with filters, text is
  never a formula, integers longer than Excel's 15 digits stay exact as text. Streams a window of rows at a time with
  progress and Cancel (1M rows × 11 columns in about 30 s); written in this tab with no new dependency.
- **Example queries for any table** you open, built from its columns (totals by a category, a monthly trend, the
  top 10, a summary of every column), not just for the sample data.
- Unit tests execute the generated SQL on the same DuckDB-WASM build, in Node.
- Dialogs, the column menu and the chart view are each behind their own boundary: if one can't load (offline after a
  new version went out) or crashes, it closes with a message and the tables stay; with tables open, a missing file
  offers the new version instead of reloading the page on its own.
- Every end-to-end test also fails on any uncaught error or unhandled rejection in the page, or an error React caught
  (the crash screen, a part that failed) (`tests/fixtures.ts`), even when what it checked on screen looked right.

### Changed
- Step chips are named for what clicking them does (*Remove step: Without 1 total line*); an added category column's
  chip opens its rules, and its × removes it. Category words come from the rows no category has taken yet, and
  focus stays among them as they're used.
- *1 row*, *1 column*; the sidebar says text, number, date (the database's type on hover); a view's suggested name
  leaves out the table's month and year; Excel dates use Excel's own short date (as the reader's computer writes
  dates); the chart's date grain reads *Auto (month)*.
- Each table keeps its checks while another is open.
- Three or more columns converted (usually one click on *Convert*) show as one chip, *4 columns converted*: clicking
  it lists them one by one, and only its × undoes them all. Look-alike values merged in a column group the same way
  (*City: 4 values merged*), and the column menu offers *Merge all*; a stray space shows as ␣ (*Mumbai␣ → Mumbai*).
- Pivot rows and columns by month, quarter or year read as the period (2024-04, 2024-Q2), sort as dates, and go to
  Excel as real months (*Apr 2024*). The pivot dialog speaks plainly: *Totals over all 58 rows*, *Date (50 values)*.
- A file that doesn't open says which (*Couldn’t open tally.xml.*), not *That query didn’t run.*
- The shortcuts list fits a laptop screen (two balanced columns, one line a shortcut); on phones the landing page
  offers opening a file first; while a big file's total lines are looked for, a quiet *Checking for total lines…*
  holds their chip's place; running a query closes the editor's suggestions.
- Copy: *Ran “HDFC tidy” on bank_jul: 6 steps, shown above the rows*; *Checked all 112 rows* (not "sample rows")
  when that's all of them; *3 of 40 values* (not "sampled") when they were every value; a pasted Excel formula is
  answered with a sum on your own table and column.
- The code that looks a table over (total lines, fill down, dates, a column's profile) loads with the first table,
  not the first screen.
- App.tsx split up: the library tabs (`Library.tsx`), applied steps and suggestions (`StepChips.tsx`,
  `HintChips.tsx`) and the notice stack (`Toasts.tsx`) are components of their own.
- Usability pass:
  - A column of numbers or dates stored as text says so at the top of its menu, with a one-click Convert (sorting and
    sums are wrong until then); Excel export offers converting first, too.
  - The column menu leads with sorting, filtering and the most common values; text columns no longer show a
    meaningless alphabetical min/max; case and splitting aren't offered for IDs and codes; repeats are only flagged
    in mostly-unique columns. On phones it's a bottom sheet with a Close button.
  - Look up opens on the likeliest pair of columns (not simply the first) and warns, instead of applying, when no
    rows would match. Pivots never default to summing an ID column.
  - Errors in plain words (sum over text, a misspelt column, text in double quotes) with DuckDB's message under
    Details. Formulas are checked before they're added, and a leading "=" is fine.
  - Numbers follow the reader's locale everywhere (12,34,567 in India); decimal columns show two places; Excel
    exports keep grouping (#,##0.00).
  - Headers say text / number / date & time instead of database types, and show ▾ on hover; added columns scroll
    into view; converted columns get a fresh width; compare results have a readable `what_changed` column.
  - Suggestions are outlined, applied steps filled; example queries step aside once you start working on a result.
  - A CSV whose rows have more or fewer fields than its header opens as columns instead of one text column.
  - Clean-up SQL reads like what it does: `number_from_text(amount)`, `date_from_text(paid_on, '%d/%m/%Y')`,
    `title_case(name)`, `tidy_spaces(city)` (macros defined in the engine) instead of long regular expressions.
- Compare: keys typed differently in the two files (number vs text) still match; whole-row mode compares the key
  columns too. Defaults are now strict except for spaces: case changes and small number changes count unless you
  choose to ignore them (separate options), and rounding tolerance never applies to whole numbers. Output columns
  (`change`, `changed_columns`, `x_before` / `x_after`) are renamed when the data already uses those names.
- Updating in one tab no longer breaks other open tabs (the previous offline copy is kept until the next deploy), and
  a deploy of the build a tab already runs is applied without a prompt.
- Column profiles show exact distinct counts for small columns and format min/max like the grid.
- Rows-that-aren't-data SQL reads like what it does too: `has_value(x)`, `is_total_label(x)`,
  `is_grand_or_subtotal(x)` instead of CASE expressions with regular expressions.
- The "Convert" suggestion stays offered after a fill-down or trim (only a conversion settles it).
- Date layouts are named as patterns (DD-Mon-YYYY, Mon-YY) rather than an example date; the sort chip says
  ascending or descending.
- Alt+↓ opens the first column's menu when no cell is selected (after Escape).
- On phones, Export brings itself into view before its menu opens (the toolbar scrolls sideways), and the chart hint
  says to tap for exact values.

### Fixed
- Charts of a pivot counted its Total row as a category; comparing a whole number with "12.0" read as a change;
  pivot column counts could exceed the rows (approximate distinct counts).
- "Use row N as column names" was offered on tables whose columns all have real names.
- Opening a column menu or saving a view left the "save these steps" nudge on screen.
- Notices sat above dialogs (blocking their buttons on phones) and over the status bar's sum; the Anonymize dialog
  was wider than a phone screen.
- Keyboard: focus dropped to the page after opening a file from the landing page, taking a suggestion or removing
  a step; it now lands on the rows or the next chip. The SQL editor shows a focus ring; the shortcuts dialog opens on
  its heading (Done was below the fold); `>=` no longer draws as a ligature.
- The status bar shows the active cell as the grid does (12,500.00, not 12500.0); a column whose values are all
  different says so instead of listing "most common" values that each appear once; starter queries no longer group
  by an amount stored as text ("Qty by Rate"); generated SQL holds at four lines on short screens until edited.
- The bundle-size check counted only files named index/react/duckdb, missing the shared chunks `index.html`
  preloads with them (about 13 KB): it now measures exactly what the page loads first (budget 190 KB, honestly
  measured). Personal-data rules, pivot and chart code, the saved-view dialogs, SQL error explanations and file
  sniffing moved out of the first download.
- Cancelling a query could stop a file that was loading; a superseded query queued behind a load still ran; Cancel on
  a query waiting behind a load now stops it at once.
- Result tables could leak when a query was cancelled at the last moment, and an Excel export (or the result on
  screen) could lose its table when newer queries finished.
- A column name containing a line break could end a `--` comment in generated SQL.
- Plain `name` and spreadsheet-style headers ("Customer Name", "E-mail") are recognised as personal data again.
- Example queries no longer break on tables with their own `month` column or with list columns.
- Look up kept every row but could hand them back in another order (unmatched rows last); the preview count now uses
  the rows the look-up will see (after cleaning, earlier look-ups and filters); converting a key column later, or
  removing a look-up that other steps use, no longer breaks the query; blank keys match nothing; number keys match
  numbers written as text, and dates match timestamps.
- Two-digit years follow the spreadsheet window (30–99 → 1900s, 00–29 → 2000s).
- Undo: a new query starts a new history, failed steps leave no entry, "Count rows by" can be undone, and Undo
  never silently replaces SQL edits that haven't run. Find ignores hidden columns; each hidden column has its own chip.
- `product_name`-style columns were flagged as people's names; text birth dates like 15/08/1990 generalized to "15/0".
- An earlier script could redefine `pseudonym()` or its key.
- The compatibility check itself failed to parse in very old browsers.

## 1.0.0 – 2026-10-17

First production release.

### Added
- **Compare two tables**: added / removed / changed rows by a suggested key or by whole rows, changed cells
  highlighted, summary chips that filter; offered automatically for two versions of the same export.
- **Anonymize**: finds emails, phone numbers, Aadhaar (Verhoeff), PAN, card numbers (Luhn), IP addresses, names,
  birth dates, addresses and PIN codes; mask, keyed pseudonyms, labels, generalize or remove, with previews.
- Type-aware filters (between, at least, doesn't contain, starts with, is not), number validation, Excel-style value
  picking (IN lists), and an empty-result message with "Undo last filter".
- Spreadsheet-grade number display (locale grouping, data-driven decimals, exact 64-bit integers).
- Cancellable file loads with elapsed time; descriptive export file names.
- "A new version is ready · Reload" updates; crash screen; unsupported-browser screen.
- SEO and sharing (canonical, Open Graph, JSON-LD, og.png, robots, sitemap), privacy and 404 pages, PNG and
  maskable icons, install screenshots, OS file handling, "Try the sample data" app shortcut.
- Unit tests (`tests/unit`), robustness/production/compare/anonymize end-to-end suites, bundle-size budget.

### Fixed
- A running query could be aborted by scrolling, range stats or background snapshots (shared connection).
- A result column named `rowid` scrambled row order and left rows loading forever.
- Sample data replaced a user's own `orders` table and deleted its saved copy; opening a file could replace a
  table whose name differed only in case.
- The offline copy never updated after the first visit.
- Sorting after a multi-statement script failed; multi-line string literals changed when composed.
- Number filters lost precision on 64-bit IDs and failed on input like `1,000`; "contains" treated `%`/`_` as wildcards.
- Charts of a column named `value`; pivots rounded small averages to 0 and failed on blank values.
- Share links could inflate to gigabytes before the size check.
- Copy failed silently in Safari; the big-file warning was hidden by the loading message.

## 0.x

Development as "Quarry", then the rebrand to Sheetah: million-row canvas grid, SQL editor, saved views, pivots,
charts, share links, offline support, kept tables, accessibility and security hardening.
