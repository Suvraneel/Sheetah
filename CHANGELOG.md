# Changelog

All notable changes. Dates are release dates; versions follow [semver](https://semver.org).

## Unreleased

### Added
- **Charts split by a column**: *Split by* Region (or Status, or any column that names things) draws a line for
  each over time, or each bar in parts that add up to it (side by side for averages, which don't add up). The
  largest five are shown and the rest put together as Other; every series' value is in the tooltip, by keyboard
  too, and *Open as query* gives the table behind it, a column per series.
- **A pivot's chart is a pivot chart**: a pivot with a field across charts its columns as the parts of each bar
  (Food, Rent and Travel in each month), titled in the pivot's own words, its Total row and column left out. *Each
  number column* does the same for any result with several amounts side by side.
- **An amount typed wrong, said in the match**: a line left over beside one on the other side, within the days
  allowed, with the same digits in another order (5,400 and 4,500) or a zero more or less (500 and 5,000) says
  so: *amount differs: 4,500.00 in books on 2024-04-04 (digits swapped?)*. The match preview counts them.
- **A statement with one Amount and a Dr / Cr column** (Kotak's, card statements) is offered *Split Amount into
  money in and out*: two columns, after which it sums, summarises by month, matches and reconciles like any
  statement.
- **Saved views and next month's file, both open**: the Saved tab says a view *also fits* the newer table and
  offers *Run on* it, rather than running on last month's without a word.
- **Amounts written with the currency in letters** convert too: `Rs. 25,000.00`, `INR 7,500`, `USD 99.95`,
  `1,200/-`, and a trailing minus as SAP writes it (`1,500.00-` is −1,500).
- **A workbook's cells Excel couldn't give a value** are said as it opens: error cells (#DIV/0!, #N/A) and formulas
  saved without their result (a program wrote the file without calculating it), which are empty here.
- **Spreadsheet habits in SQL, put right in one click**: `city & ' - ' & state` (SQL joins text with `||`),
  `""` for empty text, `"Pune"` and `"1000"` in double quotes, a bare `Pune` where a value goes, dates typed without
  quotes (`2024-04-01` is a subtraction, `01/04/2024` a division), `SELECT TOP 10`, a `LIMIT` before `WHERE`,
  `1,000` with its separator, `&&` for AND, `GROUP BY 'city'` and `ORDER BY 'amount'` (the text, the same on every
  row), `=AVERAGE(amount)` typed as a formula (its SQL, on the table on screen), and Sheetah's own functions given
  the wrong values (each says how it's written). "Did you mean" only for a name that's a near miss.
- **Why a query found nothing**: `= NULL` (never true: `IS NULL`), `LIKE 'UPI*'` (`%` is any text), a
  date-and-time compared with a day (only midnight matches), and text that differs only in capitals or spaces
  (`'pune'`, when the table writes `'Pune'`: looked up, and offered as the table writes it, or `ILIKE`).
- **Example queries on the tidied rows**: once a report's total line is left out (or text converted), its example
  queries read those rows, not the file (a sum no longer counts the total twice). They aren't offered while total
  lines are still in the rows.
- **Undo across typed queries**: a query typed (or a slip put right) over the rows on screen is a step Undo takes
  back; running the steps' own SQL again keeps the steps. A script that changes data starts a history of its own,
  so Undo and Redo never run it again.
- **Edited, not run**: said beside Run while the SQL on screen isn't what made the rows below.
- **Completion** of Sheetah's own functions (`number_from_text`, `date_from_text`, `tidy_spaces`…), each with
  what it does; the open table's columns complete without its name, and a name with spaces is completed quoted.
- **A total in a formula column** (`sum(total)`) is offered as the same total on every row: `sum(total) OVER ()`.
- **Dates typed into a filter as people write them**: `31/01/2024`, `01/31/2024` (the reader's way round, unless a
  part over 12 settles it), `1 Apr 2024`, `Apr 1, 2024`; one that isn't a date is said, not run.
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
- **Financial years**: pivots group dates by financial year (April to March: *FY 2024-25*) and its quarters; with
  years down the side, quarters across read *Q1 (Apr–Jun)* to *Q4 (Jan–Mar)*.
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
- A `WHERE` typed after the steps' SQL reads the converted values: SQL ending on a clean-up (or on keeping the first
  of each value) is read from one more `SELECT`. Views saved with the earlier SQL keep their steps.
- Step chips are in the order the steps apply: rows left out, columns cleaned, looked up and added, then filters,
  hidden columns and the sort. "Trim extra spaces" is "Tidy spaces" everywhere, as its SQL (`tidy_spaces`) says.
- The shortcuts list gives Redo its own line (Ctrl+Shift+Z or Ctrl+Y).
- The landing page's sketch rolls once (under five seconds), and on while hovered.
- **Kept tables come back with the work**: with *Keep my tables* on, a reload brings back the query on screen (a
  stack, a pivot, a table with its steps) and each table's steps, not just the tables. Only a query that reads, as
  DuckDB itself says, is run again (never a CREATE, DELETE, or a WITH … UPDATE).
- Example queries sum an amount still written as text (*Amount by customer*, read as a number, with a decimal comma
  where its figures use one) rather than passing it over for the quantity beside it; not when nothing says how
  its decimals are written.
- **Excel exports are about 40% faster and smaller**: each distinct text is written once (shared strings, as Excel
  does), the checksum comes from the browser's own compressor, and the page draws between every thousand rows
  instead of freezing on a million.
- The messy sample is in dollars with sales tax for a reader in the US (rupees with GST elsewhere); the year end
  among ageing's quick days is 31 December outside India; *Zip code* is said as the US says it.
- Saving a view lists its steps (*Without 4 total lines*, *Taxable Value as number*), with the SQL they make folded
  under them. Undo and Clear all stay in view at the end of a phone's row of steps; the phone's folded SQL shows
  the whole query on one line (*SELECT * FROM report WHERE …*).
- A pseudonym is named for the column's people (*Customer 1*, *Vendor 2*), so a list of companies reads right.
- Look up says 99.7% matched, never 100% with rows left without a match.
- Step chips are named for what clicking them does (*Remove step: Without 1 total line*); an added category column's
  chip opens its rules, and its × removes it. Category words come from the rows no category has taken yet, and
  focus stays among them as they're used.
- *1 row*, *1 column*; the sidebar says text, number, date (the database's type on hover); a view's suggested name
  leaves out the table's month and year; Excel dates use Excel's own short date (as the reader's computer writes
  dates); the chart's date grain reads *Auto (month)*.
- Each table keeps its checks and its steps while another is open: opened again from the list, it comes back
  tidied (Clear all shows the file as it is).
- Dates that read both ways (no day past the 12th) are read the reader's way when the file opens: 01/02/2024 is
  January 2nd in the US, 1 February in India.
- A register whose running balance follows Debit as money in (QuickBooks, Xero) has its columns turned round.
- Identifier checks run only where the values begin the Indian way (not Canada's GST numbers, or a card's PAN).
- Personal data: US phone numbers, and columns named for a phone or ZIP; a column of company names isn't a
  person's name.
- The sidebar says what a converted column now is (*date (converted)*); notices sit to the right in the workspace,
  clear of the rows being read; the Export menu's items load as it's first opened.
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
- **Clicking another table no longer waits for the last one to be looked over**: the look-over scans (numbers
  stored as text, total lines, personal data…) give way to whatever is asked for, one query at a time, and work
  each distinct value out once, skipping the costly readings for values that can't be a number or a date. A
  20,000-row table clicked just after a 300,000-row file opened took 4 seconds; it takes under one.
- **Big files and long sessions** (from a scale audit up to 1 GB):
  - A table read whole (`SELECT * FROM t`) is shown from the table itself, not a copy: half the memory, so a
    sort of an 18-million-row file no longer runs out.
  - CSV exports are written in pieces of rows (cancellable, with progress), not as one block: 9 million rows
    export instead of running out of memory.
  - Keeping tables in this browser writes each snapshot batch by batch from the engine to the disk (a 2.5M-row
    table crashed the tab), columns of fixed choices (ENUM) as their text; a write the disk refuses stops the save
    at once rather than leaving it waiting; a snapshot that didn't finish is never restored; one that can't be updated is
    removed rather than coming back out of date; leaving asks while a snapshot is still being written; turning
    Keep off in one tab is followed (and said) in the others.
  - A file too big for the memory left is said before reading it, and a read the engine couldn't do is a
    failure, never an empty table. Cancelling while a file is being put right (codes re-read as text) no longer
    leaves the table half-done.
  - A workbook with a sheet too big for the browser to read as one piece says so and what to do; a line over the
    file reader's 2 MB is explained; a table of thousands of columns lists its first 200 in the sidebar.
- **Month-end, as an accountant does it**:
  - A match leaves out balance lines (Tally's dated Opening Balance in Debit was a "deposit not yet credited").
  - Compare reads tables tidied by steps as tidied (no total lines, text converted), and never picks an amount
    (Gross Total) as the key (a GSTIN or a Corporate ID still can be).
  - A statement saved from Excel, its title lines padded with commas, opens from its real column names (a
    one-column frame's `,amount` header is still names), and a
    table whose names were found on a row gets every statement feature (signed amount, match, summary).
  - The total check accepts Tally's Current Total either way (with the opening balance or without it).
  - A ledger from the books is summarised as debit and credit by month, not money in and out.
  - Exports carry what the rows are in their name (an ageing as on its date, a reconciliation).
  - Money columns (money_in, gross, sales, Invoice Total) show to the paisa; a pivot's count named Total doesn't.
  - Splitting by Dr / Cr reads the side the way the check does (CR, C, Credit; DR, D, Debit), never a Deposit or a
    Cheque by its first letter, and never takes a Value Date for the amount.
- **Numbers no longer change on the way in**: a code longer than a number keeps (an ICCID, 20 digits) stays text,
  in a CSV and in a workbook that holds it as text, as do codes like `1E5` and `00123` there; in a file that writes
  decimals with a comma (2,50), whole numbers grouped with points (1.500) are read as text, to convert as fifteen
  hundred, not 1.5; a column called Zipcode or Pincode keeps the zeros in front of its codes past the first
  20,000 rows; times from a workbook keep their minute (01:00 was 00:59:59).
- **One-click conversions are checked over the whole column**: a big table's sample saying every value reads is
  no longer enough; a value written another way further down keeps the chip away, and the column menu says how many
  values would become empty.
- **Two-digit years** are read as spreadsheets read them when a file opens (15/08/55 is 1955, not 2055).
- **Rows that are data stay**: a vendor or brand called TOTAL isn't taken for a total line when its numbers add up
  to nothing the other rows come to; dates written `1st April 2024` or `Apr-15-2024` aren't undated notes.
- **SQL help, sharper**: dates typed in a query are read the same way round as each other (a 30 or a 31 anywhere
  settles it) and fixed all at once, and are never blamed on the data; a name after `>` or in a join's ON isn't
  offered as text; `₹1000` is offered as 1000; TOP inside a WITH, TOP n PERCENT and TOP with a LIMIT are explained,
  not rewritten wrong; names in single quotes are only whole GROUP BY / ORDER BY items, all fixed at once, each said
  by its own clause; India's `10,00,000`, `LIMIT 1,000`, `FROM order`, a FROM after WHERE and a date the calendar
  doesn't have are explained; ROUNDUP, DATEDIF, SUMPRODUCT, EOMONTH and more say what does the job in SQL.
- **No rows, explained in more places**: after a table's alias (`o.city = 'pune'`), in a join (the table that has the
  column), and `= ''` where empty cells are NULL. The "Use IS NULL" button names what it writes.
- "Run on the tidied rows" no longer stands in for an error the tidy-up can't change (a typo, a syntax error, a date
  typed without quotes). A fix pressed from the keyboard moves focus on to the rows; fix buttons say what they do
  ("Join with ||").
- Accessibility: chips and suggested words are named as they read on screen (voice control finds them); the pivot
  dialog starts on its first field once it's ready, the categories dialog on the category just added; notices are a
  labelled region of their own; focus kept for the rows after an action no longer pulls it back from a click
  elsewhere.
- A notice removed under the pointer no longer keeps the next ones up for good; an offer made for one query (Add
  the comma, Run on the tidied rows) isn't applied to a query typed since. Ctrl+Z in the editor no longer splices
  text from before a header action into its SQL.
- **Open data, as statistics offices publish it** (ONS, Destatis, Eurostat, the Census):
  - A note below the table written with another separator ("Source: ONS | Licence: OGL v3", a legend with
    semicolons) made the file reader take it for the header: no rows, or every line one column. The file is read
    by its own columns, and notes in the table (*Source:*, *[note 3] …*, *©*, a legend) are offered for leaving out.
  - Figures with notes on them (*92,338[note 3]*, *108,021 (p)*, *56\**) and thousands grouped by spaces (*1 234 567*)
    became empty; they're read as the figures they are. Placeholders for no figure (*x*, *..*, *:*, *-*, *c*) become
    empty in the one-click conversion, and the column menu says how many.
  - One suppressed "x" on line 350,003 stopped a file opening: the file is read again looking at every line (said),
    so those columns are text and nothing is lost.
  - Codes with zeros in front only further down a big file (ZIP 00020, FIPS 01001 after 56001) lost them: read as
    text, said so.
  - A browser that writes decimal commas read a UK file's *194,661* as 194.661 in one click (1000× too small), and
    an English one a German *1.500* as 1.5: values in groups of three that only the browser's habit reads as decimals
    are said, and left out of the one-click conversion.
  - Years with notes (*2023 [note 3]*) are part of the series to turn into rows, named without the notes; years
    chart as a line over time (not a histogram, or the top 20 of them); a rate isn't summed by default.
  - Hiding an empty column no longer takes away *Turn N year columns into rows*; *CSV* writes 224918, not 224918.0,
    and leaves a lone "-" alone.
  - A saved view with *Use row 4 as column names* runs on next year's release (its columns are taken by position,
    not by the title the file gave them) while row 4 still names them the same; when the years have moved on, it
    stops and says so rather than putting 2016's figures under 2015. Running a view says which columns the new
    file has that the view doesn't (*new in mye_2024, not in the view: 2024*).
  - A Census file's NAME column of counties isn't flagged as people's names.
- **Security**: a script could define a macro named for a built-in (*sha256* as md5, *right*, even *duckdb_functions*
  to hide the others) or change one of Sheetah's own, so Anonymize's pseudonyms or masks quietly stopped protecting
  anything while their SQL read the same. After every script, however the macro was made (IMPORT DATABASE too), the
  catalog is read by its system name, such a macro is removed (and said), and Sheetah's own and the pseudonym key
  are put back; pseudonym() calls the built-ins by their catalog name. *CSV* (safe for Excel) now also quotes a column name that would start a formula and every column
  that isn't a number, date or true/false (a union, a list); cells copied from the grid are pasted the same way.
  Query history is kept on the computer only when *Remember queries in this browser* is ticked (history kept before
  stays). Community extensions and persistent secrets are switched off before the engine is sealed.
- **Decimal commas read 1000× too big**: a column of 1,500 and 0,750 (kilograms) beside a price of 2,49 was read as
  thousands. A value only a decimal comma explains (0,750; 1,2345) settles a column, and a column that can't tell
  is read the way the file's other columns of amounts write decimals (not codes: "1001,1002" in a cell), before
  the reader's own habit.
- **US dates in QuickBooks reports** (group lines with no commas) were read day first, 10/02/2026 as 10 February:
  the reader's habit applies to them as to any file, with *Read Date day first* a click away.
- **Stacking months counted rows twice** when a month and its revision were both picked: rows in two of the tables
  are said before stacking (*2 rows are in both sales_dec and sales_dec_rev*). A month whose amounts were read as
  text (one "N/A") stacks as numbers, saying what becomes empty, instead of turning every month's amounts to text;
  an identifier (INV/24/1003 one month, a number the next), or a column of which more than one value in ten
  isn't a number, stacks as text with nothing emptied.
- A table of 300 columns ran the engine out of memory looking itself over, and the error was taken for a new
  version: *Reload* lost every table. The look-over runs in parts, and only a missing file counts as a new version.
- A CSV saved by Excel on Windows (Windows-1252: £, é) didn't open; it's read as that, and said so.
- A workbook saved as .csv or .xls by a portal opens as the workbook it is; a Word file renamed (even .xlsx) is named
  as one, and so is an Excel binary workbook (.xlsb).
- Leaving the page with tables that aren't kept in this browser asks first.
- *CSV* export: a UTF-8 mark so Excel shows £ and é as written; a plain negative number in a text column (−12.50)
  isn't quoted as text (a phone number written +91… still is); a sum's float noise (519314.16000000003) is written
  as Excel would keep it, in CSV and Excel.
- QuickBooks' "Total for …" lines are offered however many customers there are, when they add up; a US bank's
  *Beginning Balance* and *Ending Balance* are balance lines, and a short statement's summary (one block above or
  below its transactions) is offered for leaving out; never "Pending" in a Payment or Due Date column.
- Dates that read both ways (01/04/24, no day past the 12th) are offered in the one-click conversion the reader's way.
- Ageing is offered on an open items list with a plain Amount and a due date; whole-number amounts show two
  decimals like other money (not rates or periods: GST %, Credit Period).
- A header in two rows (a group merged over its columns) reads as one: *Sales Units*, *Sales Price*.
- A view that looks a table up in another (this month's sales in the product list) is offered on next month's file.
- Stacked months are exported as *sales_2024_01-12*, not after the first month.
- *Add signed amount* on a register says which way round once its balance is read, rather than turning round.
- Parquet or JSON in a build without them says only that.
- Dates that read both ways, read the reader's way at load, are offered the other way as one click (*Read paid_on
  day first*): nothing in the file said which was meant.
- A table opened again keeps its steps only while it has the same rows and columns and the steps still read it; one
  made again under its name opens as it is.
- After a filter or search, leaving lines out no longer looks the columns over again on the filtered rows.
- *Add signed amount* clicked before the look-over had finished on a QuickBooks or Xero register signed it the bank's
  way round: it now asks the running balance first.
- A CSV whose rows end in a trailing separator was taken for a report with title lines; one that failed to read after
  its title lines were found kept the file registered.
- Checks are said to screen readers once, as they arrive, not again as they fold and open. On a touch screen the
  column menu takes focus itself, so the keyboard doesn't open.
- Columns named for money (Taxable Value, Cost, Fees, Salary…) show two decimals; a count of things doesn't, even
  when named Total or Net (*Total Units*, *Net Qty*).
- Ageing took a payment's date (*Paid On*, *Receipt Date*) for the bill's own when leaving out bills after the day.
- A Customer column with a few people among the companies is personal data again; US card and merchant words
  (Walmart, Lyft, Comcast; *PURCHASE*, *AUTOPAY*) are read for categories.
- Tie-outs counted a Tally ledger's closing balance line (and not its opening, which its Current Total includes):
  a correct ledger was flagged. "Total for Acme Corp" lines weren't seen as totals.
- Ageing as of a past day counted bills raised after it.
- A CSV report whose title lines had no separators failed to open, or opened as one column.
- A statement whose total line has a field missing (read again with its separator) had its two-digit years read
  year first (13/04/24 as 2013-04-24): now day first, as any other.
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
