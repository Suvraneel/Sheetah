import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getEngine, sqlName } from './engine/db'
import { isBalanceName, monthlySql, signedAmount, statementColumns } from './engine/statement'
import { isIdLike, isNumericType, isTemporal, LOCALE, quoteIdent } from './engine/sql'
import { ACCEPTED, FileKindError, cancelExcel, createDemo, dateOrders, ingestFile, listTables, type TableMeta } from './engine/ingest'
import { CancelledError, cancelRunning, colRef, exportResult, holdResult, rangeStats, rowOf, runSql, splitStatements, type RangeStats, type ResultSet } from './engine/result'
import { addFilter, compose, describeFilter, emptyOps, hasOps, onTidiedRows, pickedValues, plainTable, removePick, removePickAll, stepCount, stepMarks, tidySteps, type Filter, type Ops } from './engine/compose'
import { addClean, isConversion, percentColumns, type Clean, type DropRows } from './engine/clean'
import { isLoadFailure } from './engine/load-errors'
import { Grid, type DiffTones, type GridHandle, type SelectionInfo } from './grid/Grid'
// CodeMirror is only needed in the workspace: load it on demand (and warm it while the landing page is idle).
const loadEditor = () => import('./components/SqlEditor')
const SqlEditor = lazy(() => loadEditor().then((m) => ({ default: m.SqlEditor })))
import { focusEditor, insertIntoEditor } from './components/editorBridge'
import { Landing } from './components/Landing'
const loadPivotDialog = () => import('./components/PivotDialog')
const PivotDialog = lazy(() => loadPivotDialog().then((m) => ({ default: m.PivotDialog })))
const loadCompareDialog = () => import('./components/CompareDialog')
const CompareDialog = lazy(() => loadCompareDialog().then((m) => ({ default: m.CompareDialog })))
const loadLookupDialog = () => import('./components/LookupDialog')
const LookupDialog = lazy(() => loadLookupDialog().then((m) => ({ default: m.LookupDialog })))
const loadStackDialog = () => import('./components/StackDialog')
const StackDialog = lazy(() => loadStackDialog().then((m) => ({ default: m.StackDialog })))
// The column menu and the chart view load on first use too (and quietly once a result is on screen).
const loadColumnMenu = () => import('./components/ColumnMenu')
const ColumnMenu = lazy(() => loadColumnMenu().then((m) => ({ default: m.ColumnMenu })))
const loadChartPanel = () => import('./components/ChartPanel')
const ChartPanel = lazy(() => loadChartPanel().then((m) => ({ default: m.ChartPanel })))
const loadCategorizeDialog = () => import('./components/CategorizeDialog')
const CategorizeDialog = lazy(() => loadCategorizeDialog().then((m) => ({ default: m.CategorizeDialog })))
const loadUnpivotDialog = () => import('./components/UnpivotDialog')
const UnpivotDialog = lazy(() => loadUnpivotDialog().then((m) => ({ default: m.UnpivotDialog })))
import type { Lookup } from './engine/lookup'
const loadAnonymizeDialog = () => import('./components/AnonymizeDialog')
const AnonymizeDialog = lazy(() => loadAnonymizeDialog().then((m) => ({ default: m.AnonymizeDialog })))
import type { CompareLayout, CompareSpec } from './engine/compare'
import type { PivotSpec } from './engine/pivot'
import type { ColumnInfo } from './engine/result'
const loadAddColumn = () => import('./components/AddColumn')
const AddColumn = lazy(() => loadAddColumn().then((m) => ({ default: m.AddColumn })))
import { ExportMenu, type Format as ExportFormat } from './components/ExportMenu'
import { ThemeToggle } from './components/ThemeToggle'
const loadShortcutsDialog = () => import('./components/ShortcutsDialog')
const ShortcutsDialog = lazy(() => loadShortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })))
import { StarterQueries } from './components/StarterQueries'
import { Toasts, type Offer } from './components/Toasts'
import { Lazy } from './components/Lazy'
import { keepFocusIn } from './components/focus'
import { UPDATE_EVENT, applyUpdate, setHasWork, updateReady } from './sw-client'
import type { Starter } from './components/starters'
import { HintChips } from './components/HintChips'
import { StepChips } from './components/StepChips'
import { Checks } from './components/Checks'
import type { Check } from './engine/checks'
import { TablesPanel, type HistoryItem } from './components/Library'
const loadSidePanels = () => import('./components/SidePanels')
const SavedPanel = lazy(() => loadSidePanels().then((m) => ({ default: m.SavedPanel })))
const HistoryPanel = lazy(() => loadSidePanels().then((m) => ({ default: m.HistoryPanel })))
import { seriesColumns } from './engine/unpivot'
import { useMediaQuery } from './components/useMediaQuery'
import { THEME_KEY } from './theme'
import { EditorResizer } from './components/EditorResizer'
import { EDITOR_MIN, clampEditor } from './components/editorSize'
import { BtnIcon, Icon, Logo } from './components/Icon'
const loadViewDialogs = () => import('./components/ViewDialogs')
const RemapDialog = lazy(() => loadViewDialogs().then((m) => ({ default: m.RemapDialog })))
const SaveViewDialog = lazy(() => loadViewDialogs().then((m) => ({ default: m.SaveViewDialog })))
const SharedQueryDialog = lazy(() => loadViewDialogs().then((m) => ({ default: m.SharedQueryDialog })))
import { MAX_PERSIST_ROWS, clearSaved, persistSupported, removeTable, restoreAll, saveTable } from './engine/persist'
import { loadViews, newId, referencedTables, remapSteps, remapTables, stepsMake, stepsOf, storeViews, tableBase, viewsThatFit, type SavedView } from './engine/views'

const nf = new Intl.NumberFormat(LOCALE)

/** Turns engine errors people can act on into plain language. */
function friendly(message: string): string {
  if (/out of memory|failed to allocate|could not allocate/i.test(message)) {
    return 'This ran out of browser memory. Try filtering or selecting fewer columns first, or split the file. Parquet files use far less memory than CSV.'
  }
  return message
}
const GB = 1024 ** 3
/** How this reader writes 03/04/2024: April 3rd in most of the world, March 4th in the US. */
const DATE_HABIT: 'dmy' | 'mdy' = /^en-US$/i.test(LOCALE) ? 'mdy' : 'dmy'
/** Messages about files, exports and sharing (not a query's mistake): the banner says "Couldn’t finish that." */
const fileProblem = (m: string) =>
  /(support couldn’t|support isn’t included|Couldn’t open|Couldn’t read|Couldn’t copy|too long to share|can’t be exported|Excel file|Old \.xls|That workbook|took too long|views file| is empty\.$| is an? (PDF|image|zip|Word|PowerPoint|OpenDocument|Numbers|web page|UTF-16)|XML is damaged)/.test(m)

/** One state of the result for undo / redo: a query and the header actions on it. */
interface Step {
  id: number
  base: string
  ops: Ops
}
/** Today as YYYY-MM-DD, for file names. */
const today = () => new Date().toISOString().slice(0, 10)

/** Which columns of a compare result to colour (see Grid's DiffTones). */
function tonesFor(columns: ColumnInfo[], layout: CompareLayout): DiffTones | null {
  const at = (name: string | null) => (name === null ? -1 : columns.findIndex((c) => c.name === name))
  const change = at(layout.change)
  if (change < 0) return null
  const pairOf = new Map<number, string>()
  for (const p of layout.pairs) {
    for (const i of [at(p.before), at(p.after)]) if (i >= 0) pairOf.set(i, p.column)
  }
  return { change, changed: at(layout.changed), pairOf }
}
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 })
const num = (n: number | null) => (n === null ? '—' : Math.abs(n) >= 1e6 ? compact.format(n) : nf.format(Math.round(n * 100) / 100))

const HISTORY_KEY = 'sheetah:history'
const REMEMBER_KEY = 'sheetah:remember-history'
const KEEP_KEY = 'sheetah:keep-tables'
const EDITOR_KEY = 'sheetah:editor-height'
const editorElement = () => document.getElementById('sql-editor')
const STARTERS_KEY = 'sheetah:starters'
/** What a snapshot on disk corresponds to: row count + schema. A mutating query marks it 'dirty'. */
const signature = (t: TableMeta) => `${t.rows}|${t.columns.map((c) => `${c.name}:${c.type}`).join(',')}`
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* private mode */
    }
  },
  remove: (k: string) => {
    try {
      localStorage.removeItem(k)
    } catch {
      /* private mode */
    }
  },
}
/** A hint found by scanning a table, with the table's shape at the time (rows and columns). */
type Hint<T> = { sig: string; value: T }
const tableSig = (t?: TableMeta) => (t ? `${t.rows ?? ''}|${t.columns.map((c) => `${c.name}:${c.type}`).join(',')}` : '')

const loadHistory = (): HistoryItem[] => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryItem[]
  } catch {
    return []
  }
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [engineFailed, setEngineFailed] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(updateReady)
  const [busy, setBusy] = useState<string | null>(null)
  const [tables, setTables] = useState<TableMeta[]>([])
  useEffect(() => setHasWork(tables.length > 0), [tables.length])
  const [result, setResult] = useState<ResultSet | null>(null)
  // The result on screen is never dropped from under the grid, however many queries finish meanwhile.
  useEffect(() => (result ? holdResult(result) : undefined), [result])
  // Dialogs load on first use; once a result is on screen, fetch them quietly so they open instantly.
  const hasResult = !!result
  useEffect(() => {
    if (!hasResult) return
    const t = window.setTimeout(() => {
      for (const load of [loadColumnMenu, loadChartPanel, loadAddColumn, loadPivotDialog, loadLookupDialog, loadCompareDialog, loadStackDialog, loadUnpivotDialog, loadAnonymizeDialog, loadShortcutsDialog]) void load().catch(() => {})
    }, 1500)
    return () => window.clearTimeout(t)
  }, [hasResult])
  // A column just added (look-up, formula, split…) lands at the far right: bring it into view.
  const reveal = useRef<string | null>(null)
  useEffect(() => {
    const name = reveal.current
    if (!name || !result?.columns.some((c) => c.name === name)) return
    reveal.current = null
    requestAnimationFrame(() => gridRef.current?.scrollToColumn(name))
  }, [result])
  // A message (DuckDB's, explained when it's a common one), or one already in plain words with its details.
  const [error, setError] = useState<string | { text: string; detail?: string; heading?: string } | null>(null)
  const errorText = typeof error === 'string' ? error : (error?.text ?? null)
  // The plain-words explanations of SQL errors load with the first error (the raw message shows meanwhile).
  const [errorsModule, setErrorsModule] = useState<typeof import('./engine/errors') | null>(null)
  // A query that failed reading a table without its tidy-up steps: the fix is to run it on the tidied rows (the query it was for).
  const [tidyFix, setTidyFix] = useState<{ sql: string; label: string; run: () => void } | null>(null)
  useEffect(() => {
    if (error && !errorsModule) import('./engine/errors').then((m) => setErrorsModule(m), () => {})
  }, [error, errorsModule])
  const [editor, setEditor] = useState('')
  const [base, setBase] = useState('')
  const [ops, setOps] = useState<Ops>(emptyOps())
  // The ops the result on screen was made with (`ops` runs ahead while the next query is running).
  const [shownOps, setShownOps] = useState<Ops>(emptyOps())
  const shownRef = useRef<{ base: string; ops: Ops }>({ base: '', ops: emptyOps() })
  // Undo / redo of header actions (sort, filters, find, cleaning, look-ups…), and of "Count rows by",
  // which starts a new query from the current one. Running any other query starts a new history.
  const [past, setPast] = useState<Step[]>([])
  /** Tables tidied by steps (lower-case name → the tidied rows as SQL), for SQL typed against them. */
  const tidiedRef = useRef(new Map<string, { table: string; sql: string; steps: number; marks: string[] }>())
  // Results made from other rows (counted, unpivoted, column names from a row): what they came from.
  const [origins, setOrigins] = useState<Record<string, { label: string; from: Step }>>({})
  const [future, setFuture] = useState<Step[]>([])
  const stepId = useRef(0)
  const [running, setRunning] = useState(false)
  // Each run gets a number; a run that has been superseded (the user started another) is ignored when it ends.
  const runSeq = useRef(0)
  // The run the user pressed Cancel on (it may still be waiting for a file to finish loading), and a way
  // to give up waiting for it at once.
  const cancelledSeq = useRef(0)
  const abandonRun = useRef<(() => void) | null>(null)
  // The header actions last asked for: `ops` only changes when a query finishes, and a quick second
  // click must build on (and undo to) what the first click asked for, not what is still on screen.
  const wantedOps = useRef<{ base: string; ops: Ops } | null>(null)
  const runningRef = useRef(false)
  // The SQL last sent to the engine: if the editor differs, the user has unrun edits worth protecting.
  const lastRun = useRef('')
  const [pendingOps, setPendingOps] = useState<Ops | null>(null)
  // A new query made from the rows on screen (count by, unpivot) waiting on the same question.
  const [pendingRun, setPendingRun] = useState<(() => void) | null>(null)
  const [finding, setFinding] = useState(false)
  const [findText, setFindText] = useState('')
  const findInput = useRef<HTMLInputElement>(null)
  // Row count of the query itself (no header filters), for "459,688 of 1,000,000 rows".
  const [baseRows, setBaseRows] = useState<{ base: string; rows: number } | null>(null)
  const [menu, setMenu] = useState<{ col: number; anchor: DOMRect } | null>(null)
  const [adding, setAdding] = useState(false)
  const [sel, setSel] = useState<SelectionInfo | null>(null)
  // Range stats are kept with the selection and result they were computed for, so a stale answer never shows.
  const [statsFor, setStatsFor] = useState<{ sel: SelectionInfo; result: ResultSet; stats: RangeStats | null } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // What the checks found on a table's rows (its running balance, its total lines): shown while the table's
  // steps are on screen, each while the step it checked is (leaving out the total lines, the signed amount).
  type Found = Check & { step?: string }
  const [checks, setChecks] = useState<{ base: string; items: Found[] } | null>(null)
  const addChecks = useCallback((on: string, found: (Found | null)[]) => {
    const items = found.filter((c): c is Found => !!c)
    if (items.length) setChecks((c) => ({ base: on, items: [...(c?.base === on ? c.items.filter((x) => !items.some((i) => i.kind === x.kind)) : []), ...items] }))
  }, [])
  const [tab, setTab] = useState<'tables' | 'saved' | 'history'>('tables')
  // Column lists in the library shown or hidden by hand (kept while other tabs are open).
  const [colsOpen, setColsOpen] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<'grid' | 'chart'>('grid')
  const [pivoting, setPivoting] = useState(false)
  const [comparing, setComparing] = useState<{ before?: string; after?: string } | null>(null)
  const [stacking, setStacking] = useState<{ around?: string } | null>(null)
  // The compare behind the current result: "Edit compare", and the added/removed/changed counts.
  const [compareOrigin, setCompareOrigin] = useState<{ spec: CompareSpec; layout: CompareLayout; sql: string; counts?: Record<string, number> } | null>(null)
  // A suggestion with an action ("sales_nov looks like a newer sales_oct · Compare").
  const [anonymizing, setAnonymizing] = useState(false)
  // What scanning a table found, by the query that reads it, offered as quiet chips: personal data (to
  // anonymize), numbers or dates stored as text (to convert), total lines and empty rows (to leave out).
  const [piiHints, setPiiHints] = useState<Record<string, Hint<string[]>>>({})
  const [textHints, setTextHints] = useState<Record<string, Hint<Clean[]>>>({})
  const [junkHints, setJunkHints] = useState<Record<string, Hint<DropRows[]>>>({})
  const [namesHints, setNamesHints] = useState<Record<string, Hint<number[]>>>({})
  const [fillHints, setFillHints] = useState<Record<string, Hint<string[]>>>({})
  const [emptyHints, setEmptyHints] = useState<Record<string, Hint<string[]>>>({})
  const [spaceHints, setSpaceHints] = useState<Record<string, Hint<string[]>>>({})
  const [dateHints, setDateHints] = useState<Record<string, Hint<string[]>>>({})
  // Tables whose total lines are still being looked for (a big file takes seconds): a placeholder holds the chip's place.
  const [junkPending, setJunkPending] = useState<ReadonlySet<string>>(new Set())
  // The Look up dialog, and the column it was opened from (if any).
  const [lookingUp, setLookingUp] = useState<{ here?: string } | null>(null)
  const [unpivoting, setUnpivoting] = useState<{ around?: string } | null>(null)
  // Categories from a text column's words: a new column, or (edit) the rules of one added before.
  const [categorizing, setCategorizing] = useState<{ column?: string; edit?: string } | null>(null)
  // A pivot to start from (categories by month, after adding categories), rather than the usual first guess.
  const [pivotStart, setPivotStart] = useState<PivotSpec | null>(null)
  // The anonymizing query behind the current result (for export file names).
  const [anonSql, setAnonSql] = useState<string | null>(null)
  const [nudge, setNudge] = useState<Offer | null>(null)
  const tidyNudged = useRef(false)
  // Where the current pivot came from, so "Edit pivot" reopens it on the original data.
  const [pivotOrigin, setPivotOrigin] = useState<{ sql: string; columns: ColumnInfo[]; rowCount: number; spec: PivotSpec; pivotSql: string } | null>(null)
  const [views, setViews] = useState<SavedView[]>(loadViews)
  const viewsRef = useRef(views)
  const runViewOn = useRef<(view: SavedView, from: string, to: string) => void>(() => {})
  const [saving, setSaving] = useState(false)
  const [remap, setRemap] = useState<{ view: SavedView; missing: string[] } | null>(null)
  const [undo, setUndo] = useState<{ label: string; run: () => void } | null>(null)
  const [rememberHistory, setRememberHistory] = useState(() => store.get(REMEMBER_KEY) !== 'off')
  const [history, setHistory] = useState<HistoryItem[]>(() => (store.get(REMEMBER_KEY) === 'off' ? [] : loadHistory()))
  // Pinned editor height in px, or null to fit the query (see EditorResizer).
  const [editorHeight, setEditorHeight] = useState<number | null>(() => {
    const h = Number(store.get(EDITOR_KEY))
    return h >= EDITOR_MIN ? clampEditor(h) : null
  })
  const editorShell = useRef<HTMLElement>(null)
  // Phones: the sidebar becomes a bottom sheet and the SQL editor collapses to one line.
  // Same condition as the phone rules in index.css: narrow screens, or short touch screens (landscape).
  const isPhone = useMediaQuery('(max-width: 767px), (max-height: 500px) and (pointer: coarse)')
  const [sheetOpen, setSheetOpen] = useState(false)
  if (!isPhone && sheetOpen) setSheetOpen(false) // leaving phone width ends the sheet (state adjusted during render)
  const sheet = isPhone && sheetOpen
  const sheetButton = useRef<HTMLButtonElement>(null)
  const [sqlOpen, setSqlOpen] = useState(false)
  const sqlPeek = isPhone && !sqlOpen
  const peekButton = useRef<HTMLButtonElement>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [startersOff, setStartersOff] = useState(() => store.get(STARTERS_KEY) === 'off')
  const [sampleName, setSampleName] = useState<string | null>(null)

  // Example queries follow the table on screen: the sample's own, or ones built from any table's columns.
  // They stay while you click through them (their results aren't plain table reads).
  const [starterTable, setStarterTable] = useState<string | null>(null)
  // Built once per table (and schema): going back to a table doesn't scan it again.
  const [starterLists, setStarterLists] = useState<Record<string, Starter[]>>({})
  const starterMeta = starterTable ? tables.find((t) => t.name === starterTable) ?? tables.find((t) => t.name.toLowerCase() === starterTable.toLowerCase()) : undefined
  // Recomputed if the table is replaced with different columns.
  const starterKey = starterMeta ? `${starterMeta.name}\u0000${starterMeta.columns.map((c) => `${c.name}:${c.type}`).join('\u0000')}` : ''
  useEffect(() => {
    const meta = starterMeta
    if (!meta || starterLists[starterKey] || !meta.columns.length) return
    let live = true
    // The sample's own questions (written for it), loaded with the code that builds the others.
    if (meta.name === sampleName) {
      void import('./components/starters').then((m) => live && setStarterLists((all) => ({ ...all, [starterKey]: m.sampleStarters(meta.name) })))
      return () => {
        live = false
      }
    }
    const cols = meta.columns.map((c) => ({ ...c, numeric: isNumericType(c.type) }))
    // A moment later, so the grid's first rows aren't queued behind a scan of the whole table.
    const t = window.setTimeout(() => {
      Promise.all([import('./engine/pivot'), import('./components/starters')])
        .then(([pivot, s]) =>
          pivot
            .cardinalities(`SELECT * FROM ${sqlName(meta.name)}`, cols)
            .catch(() => ({}) as Record<string, number>)
            .then((counts) => s.startersFor(meta.name, cols.map((c) => ({ ...c, distinct: counts[c.name] })), meta.rows ?? undefined)),
        )
        .then((list) => live && setStarterLists((all) => ({ ...all, [starterKey]: list })))
        .catch(() => {})
    }, 600)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [starterMeta, starterKey, sampleName, starterLists])
  const [shared, setShared] = useState<string | null>(null)
  const [offlineReady, setOfflineReady] = useState(false)
  const [keepTables, setKeepTables] = useState(() => persistSupported() && store.get(KEEP_KEY) === 'on')
  const snapshots = useRef(new Map<string, string>()) // table → signature of its snapshot on disk
  const demoTables = useRef(new Set<string>()) // sample data is regenerated, never kept
  const warned = useRef(new Set<string>())
  const syncQueue = useRef(Promise.resolve())

  // Ask the service worker whether everything (engine included) is cached for offline use.
  useEffect(() => {
    if (editorHeight) store.set(EDITOR_KEY, String(editorHeight))
    else store.remove(EDITOR_KEY)
  }, [editorHeight])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => e.data?.type === 'status' && setOfflineReady(!!e.data.offlineReady)
    navigator.serviceWorker.addEventListener('message', onMessage)
    void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage('status'))
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const gridRef = useRef<GridHandle>(null)

  useEffect(() => {
    getEngine()
      .then(() => setReady(true))
      .catch((e) => {
        setEngineFailed(true)
        setError(
          `Sheetah couldn’t start its engine in this browser (${e instanceof Error ? e.message : e}). It needs a recent Chrome, Edge, Firefox or Safari. Reloading sometimes helps.`,
        )
      })
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('debug')) {
      ;(window as unknown as Record<string, unknown>).sheetah = { getEngine, runSql, createDemo, listTables }
    }
    const onUpdate = () => setUpdateAvailable(true)
    window.addEventListener(UPDATE_EVENT, onUpdate)
    return () => window.removeEventListener(UPDATE_EVENT, onUpdate)
  }, [])

  // A shared query in the URL fragment: decode it, strip it from the address bar, review later.
  useEffect(() => {
    // The decoder loads only for a shared link.
    if (!/^#q=/.test(location.hash)) return
    void import('./engine/share').then(({ takeSharedToken, decodeSql }) => {
      const token = takeSharedToken()
      if (token) void decodeSql(token).then((sql) => (sql ? setShared(sql) : setError('That shared link is damaged or too long to open.')))
    })
  }, [])

  const copyShareLink = async () => {
    const sql = editor.trim()
    if (!sql) return
    let url: string
    try {
      url = await (await import('./engine/share')).shareUrl(sql)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)) // too long to fit in a link
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      say('Link copied. It holds only the SQL, never your data.')
    } catch {
      setError('Couldn’t copy the link: this browser blocked clipboard access. Copy the SQL from the editor instead.')
    }
  }

  const say = useCallback((msg: string) => {
    setToast(msg)
    // Long messages stay up long enough to read.
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), Math.max(2400, msg.length * 50))
  }, [])

  const refreshTables = useCallback(async () => {
    const list = await listTables()
    setTables(list)
    // The sample's table was dropped or renamed: a later table with that name is the user's own.
    setSampleName((n) => {
      if (n && !list.some((t) => t.name === n)) {
        demoTables.current.delete(n)
        return null
      }
      return n
    })
  }, [])

  const execute = useCallback(
    async (sql: string, opts: { base?: string; ops?: Ops; remember?: boolean; history?: 'keep' } = {}) => {
      const seq = ++runSeq.current
      lastRun.current = sql
      setPendingOps(null)
      setPendingRun(null)
      // Starting a new query stops the one still running (clicking another table, a filter chip…).
      if (runningRef.current) await cancelRunning('query').catch(() => false)
      runningRef.current = true
      setRunning(true)
      setError(null)
      setMenu(null)
      const changesData = splitStatements(sql).some(
        (st) => !/^(\(|with\b|select\b|from\b|values\b|describe\b|show\b|summarize\b|explain\b|pivot\b|unpivot\b|table\b)/i.test(st.replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, '')),
      )
      try {
        const run = runSql(sql, { isCurrent: () => seq === runSeq.current && cancelledSeq.current !== seq })
        run.catch(() => {}) // if abandoned below, its own outcome no longer matters
        const res = await Promise.race([
          run,
          new Promise<never>((_, reject) => {
            abandonRun.current = () => reject(new CancelledError())
          }),
        ])
        if (seq !== runSeq.current) return null
        // Columns converted from "18%" text hold fractions: they're shown (and filtered) as percentages.
        const percent = new Set([...(opts.ops?.clean?.filter((c) => c.kind === 'percent').map((c) => c.column) ?? []), ...percentColumns(sql)])
        if (percent.size) res.columns = res.columns.map((c) => (percent.has(c.name) ? { ...c, percent: true } : c))
        setResult(res)
        // Header actions compose around the query itself (the last statement); earlier ones have run.
        let shownBase = shownRef.current.base
        if (opts.base !== undefined) {
          const b = splitStatements(opts.base).at(-1) ?? opts.base
          setBase(b)
          shownBase = b
          const read = plainTable(b)
          if (read) setStarterTable(read)
          if (!opts.ops || !hasOps(opts.ops)) setBaseRows({ base: b, rows: res.rowCount })
          if (opts.history !== 'keep') {
            // A new query (typed, a table, a starter…): its own undo history, starting from here.
            setPast([])
            setFuture([])
            wantedOps.current = { base: b, ops: opts.ops ?? emptyOps() }
          }
        }
        if (opts.ops) {
          setOps(opts.ops)
          setShownOps(opts.ops)
          shownRef.current = { base: shownBase, ops: opts.ops }
          // A table tidied by steps: kept, so SQL typed against the table can be offered its tidied rows.
          const t = plainTable(shownBase)
          if (t) {
            const tidy = tidySteps(opts.ops)
            if (tidy.count) tidiedRef.current.set(t.toLowerCase(), { table: t, sql: compose(shownBase, tidy.ops), steps: tidy.count, marks: stepMarks(tidy.ops) })
            else tidiedRef.current.delete(t.toLowerCase())
          }
        }
        if (opts.remember !== false) {
          setHistory((h) => {
            const next = [{ sql: sql.trim(), at: Date.now(), rows: res.rowCount }, ...h.filter((x) => x.sql !== sql.trim())].slice(0, 30)
            // Queries can contain sensitive literals (WHERE email = …): only persist if the user wants that.
            if (store.get(REMEMBER_KEY) !== 'off') store.set(HISTORY_KEY, JSON.stringify(next))
            return next
          })
        }
        return res
      } catch (e) {
        if (seq !== runSeq.current) return null
        wantedOps.current = null // what was asked for didn't happen: the screen is the truth again
        if (e instanceof CancelledError) say('Query cancelled')
        else setError(friendly(e instanceof Error ? e.message : String(e)))
        return null
      } finally {
        // Anything that may have changed tables (even a script that failed half-way) refreshes the list
        // and marks kept snapshots of the tables it mentions as out of date.
        if (changesData) {
          const lower = sql.toLowerCase()
          for (const name of snapshots.current.keys()) if (lower.includes(name.toLowerCase())) snapshots.current.set(name, 'dirty')
          await refreshTables().catch(() => {})
        }
        if (seq === runSeq.current) {
          runningRef.current = false
          setRunning(false)
        }
      }
    },
    [refreshTables, say],
  )

  /** Stops the file that is loading. */
  const cancelWork = useCallback(() => {
    cancelExcel()
    void cancelRunning('load').catch(() => false)
  }, [])

  /** Stops the running query (or the one waiting to run). */
  const cancelQuery = useCallback(() => {
    cancelledSeq.current = runSeq.current
    void cancelRunning('query').catch(() => false)
    // A query still queued behind a file load stops showing as running now; it is skipped when its turn comes.
    abandonRun.current?.()
  }, [])

  const openTable = useCallback(
    async (name: string) => {
      const sql = `SELECT * FROM ${sqlName(name)}`
      setEditor(sql)
      setChecks(null) // a table opened afresh: its rows as in the file, unchecked
      return execute(sql, { base: sql, ops: emptyOps(), remember: false })
    },
    [execute],
  )

  /**
   * Looks a result over for hints, after its first rows are on screen (these scan the table, and the
   * grid's own reads come first). 'all' for a table; 'text' for rows made from one (unpivoted months).
   */
  const tablesRef = useRef(tables)
  useEffect(() => {
    tablesRef.current = tables
  })
  const scanned = useRef(new Set<string>())
  // Queries that stand for a table (one whose column names were on a later row): suggestions as for a table.
  const [tableLike, setTableLike] = useState<ReadonlySet<string>>(new Set())
  const scanHints = useCallback((res: ResultSet, which: 'all' | 'text', metas?: TableMeta[]) => {
    if (!res.table) return
    const key = res.sql.trim()
    const read = plainTable(key)?.toLowerCase()
    const sig = tableSig(read ? (metas ?? tablesRef.current).find((t) => t.name.toLowerCase() === read) : undefined)
    // Kept while it's scanned: two quick sorts would otherwise drop the result table from under the scans.
    const release = holdResult(res)
    window.setTimeout(() => {
      // The scans' code arrives with the first table (the first screen doesn't wait for it).
      void import('./engine/scan').then(({ ambiguousDates, emptyTextColumns, fillDownColumns, junkRows, namesRow, textFindings }) => {
        const scans: Promise<unknown>[] = [
          textFindings(res).then(({ convert, spaces }) => {
            setTextHints((m) => ({ ...m, [key]: { sig, value: convert } }))
            setSpaceHints((m) => ({ ...m, [key]: { sig, value: spaces } }))
          }),
        ]
        if (which === 'all') {
          setJunkPending((p) => new Set(p).add(key))
          const junkDone = () =>
            setJunkPending((p) => {
              const next = new Set(p)
              next.delete(key)
              return next
            })
          scans.push(
            import('./engine/pii')
              .then((m) => m.detectPii(res))
              .then((d) => setPiiHints((m) => ({ ...m, [key]: { sig, value: d.map((x) => x.column) } }))),
            junkRows(res)
              .then((drop) => setJunkHints((m) => ({ ...m, [key]: { sig, value: drop } })))
              .finally(junkDone),
            namesRow(res).then((r) => setNamesHints((m) => ({ ...m, [key]: { sig, value: r === null ? [] : [r] } }))),
            fillDownColumns(res).then((cols) => setFillHints((m) => ({ ...m, [key]: { sig, value: cols } }))),
            emptyTextColumns(res).then((cols) => setEmptyHints((m) => ({ ...m, [key]: { sig, value: cols } }))),
            // Dates the file reader read the other way round from how this reader writes them (01/02: 1 Feb or Jan 2).
            read && dateOrders.has(read) && dateOrders.get(read) !== DATE_HABIT
              ? ambiguousDates(res).then((cols) => setDateHints((m) => ({ ...m, [key]: { sig, value: cols } })))
              : Promise.resolve(),
          )
        }
        // Only a scan that finished counts as done: one that failed is tried again next time the table opens.
        void Promise.allSettled(scans).then((done) => {
          release()
          if (which === 'all' && done.every((d) => d.status === 'fulfilled')) scanned.current.add(`${key}|${sig}`)
        })
      }, release)
    }, 400)
  }, [])
  /** A table opened from the list: scanned the first time it's seen (in this shape). */
  const openAndScan = async (name: string) => {
    const res = await openTable(name)
    if (!res?.table) return
    const meta = tables.find((t) => t.name === name)
    if (!scanned.current.has(`${res.sql.trim()}|${tableSig(meta)}`) && !demoTables.current.has(name)) scanHints(res, 'all')
  }

  const [busyCancel, setBusyCancel] = useState<(() => void) | null>(null)

  const loadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setError(null)
      let first = ''
      let last = ''
      let current = ''
      try {
        await getEngine()
        setBusyCancel(() => cancelWork)
        for (const [i, f] of files.entries()) {
          current = f.name
          const size = f.size > 1.5 * GB ? ` (${(f.size / GB).toFixed(1)} GB: big CSVs load into memory, so this can take a while)` : ''
          setBusy(`Reading ${f.name}${files.length > 1 ? ` · file ${i + 1} of ${files.length}` : ''}${size}`)
          // Notes about a file (title lines left out, ragged rows) are said once, after it opens.
          const notes: string[] = []
          const names = await ingestFile(f, undefined, (note) => notes.push(note))
          first ||= names[0]
          last = names[names.length - 1]
          if (names.length > 1) say([`Opened ${names.length} sheets from ${f.name}.`, ...notes].join(' '))
          else if (notes.length) say(notes.join(' '))
        }
        setBusy(null)
        setBusyCancel(null)
        const metas = await listTables()
        setTables(metas)
        if (first) {
          const res = await openTable(first)
          if (res) scanHints(res, 'all', metas)
          // Opened from the landing page (now gone) or a file dialog: keyboard focus lands on the rows.
          keepFocusIn(null, 0)
        }
        // Two versions of the same export side by side: offer to compare them (the newer file is "after").
        // Loaded only when a file opens (they look the open tables over), not with the page.
        const [{ similarTable }, { stackCandidates }] = await Promise.all([import('./engine/compare'), import('./engine/stack')])
        const twin = last ? similarTable(last, metas) : null
        const family = last ? stackCandidates(last, metas) : []
        // Next month's export: a saved view made on last month's, with the same columns, can run on it.
        const opened = files.length === 1 ? metas.find((t) => t.name === first) : undefined
        const fit = opened ? viewsThatFit(viewsRef.current, opened)[0] : undefined
        if (fit && first) {
          const label = `Your view “${fit.view.name}” fits ${first}.`
          setNudge({ label, action: 'Run it', run: () => runViewOn.current(fit.view, fit.from, first) })
          window.setTimeout(() => setNudge((n) => (n?.label === label ? null : n)), 20_000)
        } else if (family.length >= 3) {
          // Several exports of one kind (a month each…): offer to stack them.
          const label = `${family.length} tables look like the same export.`
          setNudge({ label, action: 'Stack them', run: () => setStacking({ around: last }) })
          window.setTimeout(() => setNudge((n) => (n?.label === label ? null : n)), 15_000)
        } else if (twin) {
          const label = `${last} looks like another version of ${twin}.`
          setNudge({ label, action: 'Compare them', run: () => setComparing({ before: twin, after: last }) })
          window.setTimeout(() => setNudge((n) => (n?.label === label ? null : n)), 15_000)
        }
        return first
      } catch (e) {
        setBusy(null)
        setBusyCancel(null)
        await refreshTables().catch(() => {}) // files that did load still show up
        if (first) await openTable(first)
        if (e instanceof CancelledError) {
          say(`Stopped reading ${current}`)
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        const plain = friendly(msg)
        // Whatever went wrong, the heading says which file didn't open (no query was run).
        const heading = `Couldn’t open ${current || 'that file'}.`
        setError(
          e instanceof FileKindError
            ? { heading, text: msg }
            : plain !== msg
              ? { heading, text: plain }
              : /\.xls[xm]$/i.test(current)
                ? { heading, text: `It may be a damaged Excel workbook: opening it in Excel and saving it again usually fixes that.`, detail: msg }
                : { heading, text: `Sheetah reads CSV, TSV, JSON, Parquet and Excel files, and this one didn’t read as any of them.`, detail: msg },
        )
      }
    },
    [refreshTables, openTable, say, cancelWork, scanHints],
  )

  // Cells copied from a spreadsheet (or this grid), pasted outside the editor and inputs: a new table.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], .cm-editor, [role="dialog"]') || document.querySelector('[aria-modal="true"]')) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      void import('./engine/paste').then(({ pastedFile }) => {
        const file = pastedFile(text)
        if (!file) return say('Paste cells copied from a spreadsheet (two rows or more) to make a table of them')
        void loadFiles([file]).then((name) => name && say(`Made a table of what you pasted: ${name}`))
      })
      e.preventDefault()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [loadFiles, say])

  const loadDemo = useCallback(async () => {
    setError(null)
    // Its example queries show with its first rows (fetched now, while the sample is generated), so
    // the row of them doesn't appear a moment later and move the grid.
    void import('./components/starters')
    // The sample is already open: show it again rather than generating a second copy.
    if (sampleName && tables.some((t) => t.name === sampleName)) {
      await openTable(sampleName)
      return
    }
    setBusy('Generating 1,000,000 orders…')
    try {
      await getEngine()
      const name = await createDemo()
      demoTables.current.add(name)
      setSampleName(name)
      await refreshTables()
      setBusy(null)
      await openTable(name)
      keepFocusIn(null, 0)
    } catch (e) {
      setBusy(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [refreshTables, openTable, sampleName, tables])

  // Installed-app entry points: the "Try the sample data" shortcut (?demo=1), and files opened with
  // Sheetah from the operating system (manifest file_handlers → launchQueue).
  const launched = useRef(false)
  useEffect(() => {
    if (!ready || launched.current) return
    launched.current = true
    const params = new URLSearchParams(location.search)
    if (params.has('demo')) {
      params.delete('demo')
      window.history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`)
      window.setTimeout(() => void loadDemo(), 0)
    }
    const queue = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue
    queue?.setConsumer((p) => {
      if (!p.files?.length) return
      void Promise.all(p.files.map((h) => h.getFile())).then((files) => loadFiles(files))
    })
  }, [ready, loadDemo, loadFiles])

  // "Keep my tables": restore snapshots once the engine is up.
  useEffect(() => {
    if (!ready || store.get(KEEP_KEY) !== 'on' || !persistSupported()) return
    void (async () => {
      setBusy('Restoring your tables…')
      try {
        const names = await restoreAll()
        const metas = await listTables()
        for (const t of metas) if (names.includes(t.name)) snapshots.current.set(t.name, signature(t))
        setTables(metas)
        setBusy(null)
        if (names.length) {
          say(`Restored ${names.length} ${names.length === 1 ? 'table' : 'tables'} kept in this browser`)
          const res = await openTable(names[0])
          if (res) scanHints(res, 'all', metas)
        }
      } catch {
        setBusy(null)
      }
    })()
  }, [ready, say, openTable, scanHints])

  // Keep snapshots in step with the tables: save new or changed ones, delete dropped ones.
  useEffect(() => {
    if (!keepTables) return
    const keep = tables.filter((t) => t.kind === 'table' && !demoTables.current.has(t.name))
    syncQueue.current = syncQueue.current.then(async () => {
      for (const t of keep) {
        const sig = signature(t)
        if (snapshots.current.get(t.name) === sig) continue
        if ((t.rows ?? 0) > MAX_PERSIST_ROWS) {
          if (!warned.current.has(t.name)) say(`${t.name} has more than ${compact.format(MAX_PERSIST_ROWS)} rows, so it isn’t kept. Re-open the file next time.`)
          warned.current.add(t.name)
          continue
        }
        try {
          await saveTable(t.name)
          snapshots.current.set(t.name, sig)
        } catch {
          if (!warned.current.has(t.name)) say(`Couldn’t keep ${t.name}: the browser’s storage is full or unavailable.`)
          warned.current.add(t.name)
        }
      }
      for (const name of [...snapshots.current.keys()]) {
        if (keep.some((t) => t.name === name)) continue
        await removeTable(name)
        snapshots.current.delete(name)
      }
    })
  }, [tables, keepTables, say])

  const toggleKeep = async (on: boolean) => {
    setKeepTables(on)
    if (on) {
      store.set(KEEP_KEY, 'on')
      void navigator.storage.persist?.().catch(() => false) // ask the browser not to evict it under pressure
      say('Your tables will be kept in this browser')
    } else {
      store.remove(KEEP_KEY)
      await syncQueue.current
      await clearSaved()
      snapshots.current.clear()
      say('Kept tables deleted from this browser')
    }
  }

  // Header actions compose SQL around the base query.
  const applyOps = useCallback(
    (next: Ops, force = false, record: 'undo' | 'redo' | 'new' = 'new') => {
      // Header actions rewrite the editor from the last query: don't silently throw away edits not yet run.
      if (!force && editor.trim() && editor.trim() !== lastRun.current.trim()) {
        setPendingOps(next)
        setMenu(null) // so the question about the edits is in view, not under the menu
        return
      }
      const now: Step = { id: ++stepId.current, ...(wantedOps.current?.base === base ? wantedOps.current : { base, ops }) }
      wantedOps.current = { base, ops: next }
      if (record === 'new') {
        setPast((p) => [...p, now].slice(-50))
        setFuture([])
      } else if (record === 'undo') setFuture((f) => [...f, now])
      else setPast((p) => [...p, now])
      const sql = compose(base, next)
      setEditor(sql)
      // A file tidied in several steps is usually next month's chore too: say once that the steps can be kept.
      const tidy = (o: Ops) => (o.clean?.length ?? 0) + (o.drop?.length ?? 0)
      if (record === 'new' && !tidyNudged.current && tidy(next) >= 3 && tidy(ops) < 3 && plainTable(base)) {
        tidyNudged.current = true
        const label = 'Tidy this export every month? Save these steps as a view and run them on next month’s file.'
        setNudge({ label, action: 'Save view', run: () => setSaving(true) })
        window.setTimeout(() => setNudge((n) => (n?.label === label ? null : n)), 10_000)
      }
      // Shown at once, so a second click before this query finishes builds on it. If it fails, the chips
      // go back to what's on screen, and a new step that never happened leaves no undo entry behind.
      setOps(next)
      void execute(sql, { ops: next, remember: false, history: 'keep' }).then((res) => {
        if (res !== null || wantedOps.current !== null) return
        if (shownRef.current.base === base) setOps(shownRef.current.ops)
        if (record === 'new') setPast((p) => (p.at(-1)?.id === now.id ? p.slice(0, -1) : p))
      })
    },
    [base, ops, execute, editor],
  )

  /** Goes to an earlier (or later) step, which may be another query (after "Count rows by"). */
  const goTo = useCallback(
    (step: Step, dir: 'undo' | 'redo') => {
      if (step.base === base) return applyOps(step.ops, true, dir)
      const now: Step = { id: ++stepId.current, ...(wantedOps.current?.base === base ? wantedOps.current : { base, ops }) }
      if (dir === 'undo') setFuture((f) => [...f, now])
      else setPast((p) => [...p, now])
      wantedOps.current = { base: step.base, ops: step.ops }
      const sql = compose(step.base, step.ops)
      setEditor(sql)
      setOps(step.ops)
      void execute(sql, { base: step.base, ops: step.ops, remember: false, history: 'keep' })
    },
    [base, ops, applyOps, execute],
  )
  /** Columns made later in the query (formulas, looked-up values): not cleanable in place. */
  const derived = new Set([...ops.computed.map((c) => c.name), ...(ops.lookups ?? []).flatMap((l) => l.bring.map((b) => b.as))])
  const origin = origins[base.trim()]
  const originHere = origin
    ? {
        label: origin.label,
        source: plainTable(origin.from.base) ?? 'the rows before',
        onBack: () => {
          if (editsPending()) return
          // The step it came from is usually Undo's next one: taken off, so Undo doesn't go there twice.
          const same = (x?: Step) => !!x && x.base === origin.from.base && JSON.stringify(x.ops) === JSON.stringify(origin.from.ops)
          setPast((p) => (same(p.at(-1)) ? p.slice(0, -1) : p))
          goTo(origin.from, 'undo')
        },
      }
    : null
  const canUndo = past.length > 0
  const canRedo = future.length > 0
  // Undo would replace SQL edits that haven't run: say so instead.
  const editsPending = () => {
    if (!editor.trim() || editor.trim() === lastRun.current.trim()) return false
    say('Run or undo your SQL edits first: Undo would replace them')
    return true
  }
  const undoOps = useCallback(() => {
    const prev = past.at(-1)
    if (!prev || editsPending()) return
    setPast((p) => p.slice(0, -1))
    goTo(prev, 'undo')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editsPending reads the current editor
  }, [past, goTo, editor])
  const redoOps = useCallback(() => {
    const next = future.at(-1)
    if (!next || editsPending()) return
    setFuture((f) => f.slice(0, -1))
    goTo(next, 'redo')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editsPending reads the current editor
  }, [future, goTo, editor])

  // Ctrl/⌘+Z and Ctrl/⌘+Shift+Z (or Ctrl+Y) undo and redo header actions, outside the editor and inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Allowed while a query runs: applying the earlier state replaces it.
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor, [role="dialog"]')) return
      const redo = key === 'y' || e.shiftKey
      if (redo ? !canRedo : !canUndo) return
      e.preventDefault()
      if (redo) redoOps()
      else undoOps()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoOps, redoOps, canUndo, canRedo])

  /**
   * The signed amount (money in less money out) as a column; and, when there's a running balance and
   * the rows are in their own order, a check that each balance follows from the one before.
   */
  const addSignedAmount = async () => {
    if (!result || !statement || !amountExpr) return
    const taken = new Set(result.columns.map((c) => c.name.toLowerCase()))
    const name = ['amount', 'net_amount', 'signed_amount'].find((n) => !taken.has(n)) ?? `amount_${result.columns.length}`
    const rows = result
    const on = base
    const inOrder = !ops.sort && !ops.filters.length && !ops.search && !ops.dedupe
    reveal.current = name
    const short = (n: string) => n.replace(/[\s_]*(amt\.?|amount)$/i, '') || n
    const note = `${short(statement.credit)} − ${short(statement.debit)}`
    applyOps({ ...ops, computed: [...ops.computed.filter((c) => c.name !== name), { name, expr: amountExpr, note }] })
    say(`Added ${name}: ${note}`)
    if (!statement.balance || !inOrder || !rows.table) return
    const release = holdResult(rows)
    try {
      const [{ conn }, m] = await Promise.all([getEngine(), import('./engine/checks')])
      const ref = (n: string) => colRef(rows.columns.find((c) => c.name === n)!)
      const check = m.readBalanceCheck((await conn.query(m.balanceCheckSql(rows.table, { ...statement, balance: statement.balance }, isNum, ref))).toArray()[0]?.toJSON() ?? {})
      const found = m.balanceText(check, statement.balance, nf.format)
      addChecks(on, [found && { ...found, step: name }])
    } catch {
      /* the column is added; the check is a bonus */
    } finally {
      release()
    }
  }

  /** Categories added as a column (or their rules changed); then a pivot of them by month is offered. */
  const addCategories = (name: string, expr: string, c: import('./engine/categorize').Categorize) => {
    setCategorizing(null)
    const editing = ops.computed.some((x) => x.name === name)
    const added = { name, expr, note: `by ${c.column}`, categorize: c }
    reveal.current = name
    applyOps({ ...ops, computed: editing ? ops.computed.map((x) => (x.name === name ? added : x)) : [...ops.computed, added] })
    const n = c.rules.length
    const label = `${editing ? 'Updated' : 'Added'} ${name}: ${n} ${n === 1 ? 'category' : 'categories'} by words in ${c.column}`
    // What people do next: each category month by month, when there's a date and an amount.
    const date = result?.columns.find(isTemporal)
    const money = result?.columns.find((x) => x.numeric && /^(amount|net_amount|signed_amount)$/i.test(x.name)) ?? result?.columns.find((x) => x.numeric && !isIdLike(x.name))
    if (!date || !money || editing) return say(label)
    setNudge({
      label: `${label}.`,
      action: 'Pivot by month',
      run: () => {
        setPivotStart({ rows: [{ column: name, grain: 'none' }], columns: { column: date.name, grain: 'month' }, values: [{ agg: 'sum', column: money.name }], totals: true, sort: 'label' })
        setPivoting(true)
      },
    })
    window.setTimeout(() => setNudge((x) => (x?.label === `${label}.` ? null : x)), 20_000)
  }

  /**
   * The checks again, on a saved view's rows (next month's file): the total lines its steps leave out
   * against the rows they keep, a statement's running balance (while the rows are in their own order), and
   * whether it opens where the file the view last ran on closed. What it closes at is kept with the view.
   * Quiet (nothing shown) when the view has just been saved: its checks are on screen already.
   */
  const recheck = async (table: string, o: Ops, rows: ResultSet, view?: SavedView, quiet = false) => {
    const meta = tables.find((t) => t.name === table)
    const release = holdResult(rows)
    try {
      const [{ conn }, m] = await Promise.all([getEngine(), import('./engine/checks')])
      const found: (Found | null)[] = []
      const cols = meta?.columns.filter((c) => !isBalanceName(c.name)).map((c) => ({ name: c.name, numeric: isNumericType(c.type) })) ?? []
      const tie = o.drop?.length ? m.tieOutSql(table, cols, o.drop) : null
      const totals = o.drop?.find((d) => (d.kind ? d.kind === 'totals' : /total line/.test(d.label)))
      const tied = tie ? m.tieOutText(m.readTieOutRow(cols, (await conn.query(tie)).toArray()[0]?.toJSON() ?? {}), nf.format) : null
      if (tied && totals) found.push({ ...tied, step: totals.keep })
      const st = statementColumns(rows.columns)
      let closing: number | undefined
      if (st?.balance && rows.table && !o.sort && !o.filters.length && !o.search && !o.dedupe) {
        const col = (n: string) => rows.columns.find((c) => c.name === n)!
        const s = { ...st, balance: st.balance }
        const isN = (n: string) => !!col(n).numeric
        const ref = (n: string) => colRef(col(n))
        const counts = (await conn.query(m.balanceCheckSql(rows.table, s, isN, ref))).toArray()[0]?.toJSON() ?? {}
        found.push(m.balanceText(m.readBalanceCheck(counts), st.balance, nf.format))
        // Where it starts and ends, read the way round the rows run (not at all if they don't run either way).
        const order = m.readOrder(counts)
        const ends = order && m.readEnds((await conn.query(m.endsSql(rows.table, s, isN, ref))).toArray()[0]?.toJSON() ?? {}, order)
        const prev = view && (viewsRef.current.find((x) => x.id === view.id) ?? view).last
        // Last time's rows again (the same file run twice), or another month's: a file can keep its name each month.
        const sameName = !!prev && prev.table.toLowerCase() === table.toLowerCase()
        const again = sameName && prev.rows === rows.rowCount && (!ends || (typeof prev.closing === 'number' && Math.abs(prev.closing - ends.closing) < 0.005))
        if (ends && prev && typeof prev.closing === 'number' && !again)
          found.push(m.continuityText(ends.opening, { table: sameName ? `the last ${prev.table}` : prev.table, closing: prev.closing }, nf.format))
        closing = ends?.closing ?? undefined
      }
      if (view) updateViews((v) => v.map((x) => (x.id === view.id ? { ...x, last: { table, rows: rows.rowCount, ...(closing !== undefined ? { closing } : {}) } } : x)))
      if (!quiet) addChecks(tableBase(table), found)
    } catch {
      /* the view ran; the checks are a bonus */
    } finally {
      release()
    }
  }

  /** Applies an error's one-click fix to the SQL on screen and runs it (the fix shows only when it changes something). */
  const fixFor = (fix: import('./engine/errors').Fix | undefined) => (fix && errorsModule && editor.trim() && errorsModule.applyFix(editor, fix) !== editor ? fix : null)
  const runFix = (fix: import('./engine/errors').Fix) => {
    if (!errorsModule) return
    const next = errorsModule.applyFix(editor, fix)
    setEditor(next)
    setError(null)
    void execute(next.trim(), { base: next.trim(), ops: emptyOps() })
  }

  const runEditor = useCallback(() => {
    const sql = editor.trim()
    if (!sql) return
    setTidyFix(null) // an offer was for the query that failed, not this run
    // Typed SQL reading a table that has tidy-up steps, without them (not the steps' own SQL, edited):
    // it sees the file as it is, total lines and text amounts included. Offer the tidied rows.
    // Only a query that reads (an INSERT or CREATE … AS would copy the rows twice), and not the steps' own
    // SQL, edited: anything carrying a step's own text is left as it is.
    const statements = splitStatements(sql)
    const reads = statements.length === 1 && /^(\(|with\b|select\b|from\b|pivot\b|unpivot\b|table\b)/i.test(sql.replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, ''))
    const tidy = reads
      ? referencedTables(sql, tables.map((t) => t.name))
          .map((t) => tidiedRef.current.get(t.toLowerCase()))
          .find((t) => t && !sql.includes(t.sql) && !t.marks.some((m) => sql.includes(m)))
      : undefined
    const offer = (ran: boolean) => {
      if (!tidy) return
      const run = () => {
        const wrapped = onTidiedRows(sql, tidy.table, tidy.sql, tidy.steps)
        setEditor(wrapped)
        setError(null)
        void execute(wrapped, { base: wrapped, ops: emptyOps() })
      }
      const steps = `${tidy.steps} tidy-up ${tidy.steps === 1 ? 'step' : 'steps'}`
      // Failed: the offer is the error's own fix (its explanation, about the file as it is, would mislead).
      if (!ran) return setTidyFix({ sql, label: `This query skips ${tidy.table}’s ${steps}: it reads the file as it is.`, run })
      const label = `This query read ${tidy.table} as it is in the file, without its ${steps}.`
      setNudge({ label, action: 'Run on the tidied rows', run })
      window.setTimeout(() => setNudge((n) => (n?.label === label ? null : n)), 20_000)
    }
    // execute numbers the run: the offer stands for this query, whether it ran or failed (sum over the
    // raw text is the classic), not one superseded or cancelled since.
    const mine = runSeq.current + 1
    // "SELECT Region City": it runs, with Region's values under City. Said, with the comma put back.
    const slips = (res: ResultSet | null) => {
      if (!res || tidy) return
      const reads = new Set(referencedTables(sql, tables.map((t) => t.name)).map((t) => t.toLowerCase()))
      const columns = tables.filter((t) => reads.has(t.name.toLowerCase())).flatMap((t) => t.columns.map((c) => c.name))
      void import('./engine/errors').then(({ missingCommas }) => {
        const slip = missingCommas(sql, columns)[0]
        if (!slip || runSeq.current !== mine) return
        const label = `${slip.second} here is ${slip.first} renamed: SQL reads “${slip.first} ${slip.second}” as one column. A missing comma?`
        setNudge({
          label,
          action: 'Add the comma',
          run: () => {
            setEditor(slip.fixed)
            void execute(slip.fixed, { base: slip.fixed, ops: emptyOps() })
          },
        })
        window.setTimeout(() => setNudge((n) => (n?.label === label ? null : n)), 20_000)
      })
    }
    void execute(sql, { base: sql, ops: emptyOps() }).then((res) => {
      if (runSeq.current === mine && cancelledSeq.current !== mine) offer(!!res)
      if (runSeq.current === mine) slips(res)
      if (res && isPhone) {
        // Give the results the screen; if focus was in the editor, keep it on the collapsed peek.
        const inEditor = !!document.activeElement?.closest('.cm-editor')
        setSqlOpen(false)
        if (inEditor) requestAnimationFrame(() => peekButton.current?.focus())
      }
    })
  }, [editor, execute, isPhone, tables])

  /**
   * Ops with a new list of cleaning steps. A filter typed against a column's old values can't survive
   * its conversion (price = '₹1,234' on a number column is an error), so those filters are dropped,
   * and so are picked values on a column whose text changed (a picked ' pune' after trimming).
   */
  /**
   * A report whose column names are on row N (titles above them that the file reader took for data):
   * that row's values become the names, and the rows above it go. Plain SQL, undoable like count-by.
   */
  const rowAsNames = async (r: number) => {
    // The rows on screen, as they are now: a header action still running hasn't changed them yet.
    const shown = shownRef.current
    if (shown.ops.sort) return
    // Hidden columns too, so none is lost (they come back shown, under their new names).
    const rows = compose(shown.base, { ...shown.ops, sort: undefined, hidden: undefined })
    try {
      const row = await rowOf(rows, r + 1)
      if (!row) return
      const taken = new Set<string>()
      const names = row.values.map((v, i) => {
        let first = (v ?? '').trim().replace(/\s+/g, ' ') || `column_${i + 1}`
        // Never one of the names Sheetah's own SQL uses for row positions.
        if (/^__sheetah/i.test(first)) first = `${first}_col`
        let name = first
        for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${first}_${k}`
        taken.add(name.toLowerCase())
        return name
      })
      runDerived(
        [
          `-- Row ${r + 1} as the column names`,
          `SELECT ${row.columns.map((c, i) => `${sqlName(c)} AS ${quoteIdent(names[i])}`).join(', ')}`,
          `FROM (SELECT *, row_number() OVER () AS __sheetah_row FROM (\n${rows}\n))`,
          `WHERE __sheetah_row > ${r + 1}`,
          'ORDER BY __sheetah_row',
        ].join('\n'),
        { label: `Row ${r + 1} as column names`, asTable: true },
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** A dialog, the column menu or the chart couldn't load (or crashed): it's closed, and the reason said. */
  const partFailed = (e: Error, close?: () => void) => {
    close?.()
    setError(
      isLoadFailure(e)
        ? 'Couldn’t open that: part of Sheetah couldn’t load (offline, or a new version is out). Reload to update; tables you keep in this browser come back.'
        : `Couldn’t open that: ${e.message}. Your tables are untouched.`,
    )
  }

  /** Runs a query made from the rows on screen (counted, unpivoted…) as the new base: Undo comes back to those rows. */
  const runDerived = (sql: string, how: { label: string; asTable?: boolean; force?: boolean }) => {
    // Like a header action, it rewrites the editor: never over SQL that was edited but not run.
    if (!how.force && editor.trim() && editor.trim() !== lastRun.current.trim()) {
      setPendingRun(() => () => runDerived(sql, { ...how, force: true }))
      return
    }
    const asTable = !!how.asTable
    // Rows that stand for the table itself (its real column names found): looked over like a table.
    if (asTable) setTableLike((s) => new Set(s).add(sql.trim()))
    setEditor(sql)
    // The table's example queries don't fit counted or unpivoted rows (they come back with Undo).
    const starter = starterTable
    setStarterTable(null)
    const now: Step = { id: ++stepId.current, ...(wantedOps.current?.base === base ? wantedOps.current : { base, ops }) }
    // Where these rows came from, said above them, with a way back (as Undo, but at any point).
    setOrigins((o) => ({ ...o, [sql.trim()]: { label: how.label, from: now } }))
    const redo = future
    setPast((p) => [...p, now].slice(-50))
    setFuture([])
    wantedOps.current = { base: sql, ops: emptyOps() }
    void execute(sql, { base: sql, ops: emptyOps(), history: 'keep' }).then((res) => {
      // Unpivoted months ("Apr-24") are text: offer them as dates. A table with its names found gets
      // every suggestion a freshly opened one would.
      if (res) scanHints(res, asTable ? 'all' : 'text')
      // It didn't run: no undo step for something that never happened, and redo and examples come back.
      if (res !== null || wantedOps.current !== null) return
      setPast((p) => (p.at(-1)?.id === now.id ? p.slice(0, -1) : p))
      setFuture(redo)
      setStarterTable(starter)
    })
  }

  const withCleans = (next: Clean[]): Ops => {
    const before = ops.clean ?? []
    const steps = (list: Clean[], column: string, conv: boolean) => JSON.stringify(list.filter((c) => c.column === column && isConversion(c) === conv))
    const columns = new Set([...before, ...next].map((c) => c.column))
    const retyped = [...columns].filter((col) => steps(before, col, true) !== steps(next, col, true))
    const retexted = [...columns].filter((col) => steps(before, col, false) !== steps(next, col, false))
    const filters = ops.filters.filter((f) => !retyped.includes(f.column) && !(retexted.includes(f.column) && f.exact))
    const gone = [...new Set(ops.filters.filter((f) => !filters.includes(f)).map((f) => f.column))]
    if (gone.length) say(`Removed the ${gone.length === 1 ? 'filter' : 'filters'} on ${gone.join(', ')}: the values changed`)
    // A look-up matching on a converted column now matches its new type (number, date, or text again).
    const typeAfter = (col: string) => {
      const conv = next.find((c) => c.column === col && isConversion(c))
      return !conv ? 'VARCHAR' : conv.kind === 'date' ? 'DATE' : 'DOUBLE'
    }
    const lookups = ops.lookups?.map((l) => (retyped.includes(l.here) ? { ...l, types: { ...l.types, here: typeAfter(l.here) } } : l))
    return { ...ops, clean: next.length ? next : undefined, filters, lookups }
  }

  /**
   * Ops without look-up number i, and without everything that used its columns: filters, sorting,
   * duplicates, hidden columns and later look-ups matching on them (they would fail otherwise).
   */
  const withoutLookup = (i: number): Ops => {
    const all = ops.lookups ?? []
    const gone = new Set(all[i].bring.map((b) => b.as))
    const lookups: Lookup[] = []
    all.forEach((l, j) => {
      if (j === i) return
      if (gone.has(l.here)) return void l.bring.forEach((b) => gone.add(b.as))
      lookups.push(l)
    })
    return {
      ...ops,
      lookups: lookups.length ? lookups : undefined,
      filters: ops.filters.filter((f) => !gone.has(f.column)),
      sort: ops.sort && gone.has(ops.sort.column) ? undefined : ops.sort,
      dedupe: ops.dedupe && gone.has(ops.dedupe.column) ? undefined : ops.dedupe,
      hidden: ops.hidden?.filter((h) => !gone.has(h)).length ? ops.hidden.filter((h) => !gone.has(h)) : undefined,
      computed: ops.computed,
    }
  }

  const runStarter = (s: Starter) => {
    setEditor(s.sql)
    setView(s.chart ? 'chart' : 'grid')
    void execute(s.sql, { base: s.sql, ops: emptyOps() })
  }

  /** A pick inside the phone sheet closes it and puts focus on the results it opens. */
  const pickFromSheet = () => {
    setSheetOpen(false)
    requestAnimationFrame(() => gridRef.current?.focus())
  }

  const closeSheet = useCallback((refocus = true) => {
    setSheetOpen(false)
    // The topbar is inert until this state commits, so focus the trigger on the next frame.
    if (refocus) requestAnimationFrame(() => sheetButton.current?.focus())
  }, [])

  // Fetch the editor chunk in the background, so the workspace opens without waiting for it.
  useEffect(() => {
    const warm = () => void loadEditor().catch(() => {})
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm, { timeout: 4000 })
      return () => window.cancelIdleCallback(id)
    }
    const t = window.setTimeout(warm, 1500)
    return () => window.clearTimeout(t)
  }, [])

  // Ctrl/⌘+F finds text in every column of the result (the SQL editor keeps the browser's own find).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f' || e.altKey || !document.querySelector('.grid-scroll')) return
      if ((e.target as Element | null)?.closest?.('.cm-editor, [role="dialog"]')) return
      e.preventDefault()
      setFinding(true)
      requestAnimationFrame(() => findInput.current?.select())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // "?" opens the shortcut list, unless the key is being typed into something.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || !document.querySelector('.app')) return
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor, [role="dialog"]')) return
      e.preventDefault()
      setShowKeys(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The phone sheet is modal: focus moves in, Escape closes it.
  useEffect(() => {
    if (!sheet) return
    document.querySelector<HTMLElement>('#library [role="tab"][aria-selected="true"]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSheet()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet, closeSheet])

  /* ------------------------------ Saved views ------------------------------ */

  const updateViews = useCallback((fn: (v: SavedView[]) => SavedView[]) => {
    setViews((prev) => {
      const next = fn(prev)
      storeViews(next)
      return next
    })
  }, [])

  const tableNames = useMemo(() => tables.map((t) => t.name), [tables])
  const editorTables = useMemo(() => referencedTables(editor, tableNames), [editor, tableNames])

  const saveView = (name: string) => {
    // The tables' columns, so next month's file (another name, same columns) is recognised when it's opened.
    const shapes = Object.fromEntries(editorTables.map((t) => [t, tables.find((x) => x.name === t)?.columns.map((c) => c.name) ?? []]))
    // Made by header actions on a table (not edited since): the steps are kept, to come back as chips.
    // Not a day/month swap (it's about how this file was read; next month's is read afresh), and not
    // the tie-out's sums (those are this file's data, and views files travel).
    const from = plainTable(base)
    const fromSteps = !!from && hasOps(ops) && editor.trim() === compose(base, ops).trim()
    const kept: Ops = { ...ops, clean: ops.clean?.filter((c) => c.kind !== 'swapdm'), drop: ops.drop?.map(({ label, keep, kind }) => ({ label, keep, ...(kind ? { kind } : {}) })) }
    if (kept.clean && !kept.clean.length) kept.clean = undefined
    const unswapped = fromSteps && (ops.clean?.length ?? 0) !== (kept.clean?.length ?? 0)
    const sql = fromSteps ? compose(base, kept).trim() : editor.trim()
    const view: SavedView = { id: newId(), name, sql, tables: editorTables, shapes, savedAt: Date.now(), ...(fromSteps && from ? { steps: { table: from, ops: kept } } : {}) }
    updateViews((v) => [view, ...v.filter((x) => x.name !== name)])
    // Where these rows leave off (a statement's closing balance), for next month's file to be checked against.
    if (fromSteps && from && result?.table && !result.message) void recheck(from, kept, result, view, true)
    setSaving(false)
    // "Save these steps as a view" has been answered.
    setNudge(null)
    setTab('saved')
    say(unswapped ? `Saved “${name}”, without the day/month swap: each month’s file has its dates read afresh` : `Saved “${name}”`)
  }

  const runViewSql = (view: SavedView, sql: string, mapping: Record<string, string> = {}) => {
    setEditor(sql)
    // A view from a views file is shown before it first runs, like a shared link: someone else wrote it.
    if ((viewsRef.current.find((x) => x.id === view.id) ?? view).imported) {
      updateViews((v) => v.map((x) => (x.id === view.id ? { ...x, imported: false } : x)))
      say(`“${view.name}” came from a views file: check its SQL, then Run (${isMac ? '⌘' : 'Ctrl'}+Enter).`)
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.cm-content')?.focus())
      return
    }
    // Views saved before they remembered their tables' columns learn them now (for next month's file).
    const meta = (t: string) => tables.find((x) => x.name.toLowerCase() === t.toLowerCase())
    const learn = !view.shapes && view.tables.length > 0 && view.tables.every((t) => meta(t))
    const shapes = learn ? Object.fromEntries(view.tables.map((t) => [t, meta(t)!.columns.map((c) => c.name)])) : undefined
    // Only what's learnt is written: a view re-pointed a moment ago keeps its re-pointed shapes.
    updateViews((v) => v.map((x) => (x.id === view.id ? { ...x, lastRunAt: Date.now(), ...(shapes ? { shapes } : {}) } : x)))
    // Saved from a table's steps: they come back as chips (each removable), on this month's table.
    const steps = stepsOf(view)
    const s = steps && remapSteps(steps, mapping)
    const on = s && tables.find((t) => t.name.toLowerCase() === s.table.toLowerCase())
    // Re-pointed steps must still be the SQL re-pointed (a table named inside an added column isn't moved): else the SQL runs.
    if (s && on && stepsMake({ ...s, table: on.name }, sql)) {
      const b = tableBase(on.name)
      const composed = compose(b, s.ops)
      setEditor(composed)
      // The file it last ran on (last month's), for comparing this one with it.
      const prev = (viewsRef.current.find((x) => x.id === view.id) ?? view).last
      void execute(composed, { base: b, ops: s.ops }).then((res) => {
        if (!res) return
        const n = stepCount(s.ops)
        const sameName = !!prev && prev.table.toLowerCase() === on.name.toLowerCase()
        const vs = prev && (!sameName || prev.rows !== res.rowCount) ? ` · ${nf.format(res.rowCount)} rows (${sameName ? `${nf.format(prev.rows)} last time` : `${prev.table} had ${nf.format(prev.rows)}`})` : ''
        say(`Ran “${view.name}” on ${on.name}: ${n} ${n === 1 ? 'step' : 'steps'}, shown above the rows${vs}`)
        void recheck(on.name, s.ops, res, view)
      })
      return
    }
    void execute(sql, { base: sql, ops: emptyOps() })
  }

  // For the "your view fits this file" offer, made when a file loads (refs, so loading needn't re-subscribe).
  useEffect(() => {
    viewsRef.current = views
    runViewOn.current = (view, from, to) => runViewSql(view, remapTables(view.sql, { [from]: to }), { [from]: to })
  })

  const runView = (view: SavedView) => {
    const open = new Set(tableNames.map((t) => t.toLowerCase()))
    const missing = view.tables.filter((t) => !open.has(t.toLowerCase()))
    if (missing.length) setRemap({ view, missing })
    else runViewSql(view, view.sql)
  }

  const deleteView = (view: SavedView) => {
    updateViews((v) => v.filter((x) => x.id !== view.id))
    setUndo({ label: `Deleted “${view.name}”`, run: () => updateViews((v) => [view, ...v]) })
    window.setTimeout(() => setUndo((u) => (u?.label === `Deleted “${view.name}”` ? null : u)), 5000)
  }

  // Drag-and-drop anywhere
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      void loadFiles(Array.from(e.dataTransfer?.files ?? []))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [loadFiles])

  // Status-bar math for multi-cell selections, done in SQL so it works on any range size.
  useEffect(() => {
    if (!sel || !result?.table || (sel.r0 === sel.r1 && sel.c0 === sel.c1)) return
    const cols = result.columns.slice(sel.c0, sel.c1 + 1)
    const t = window.setTimeout(() => {
      rangeStats(result, cols, sel.r0, sel.r1)
        .then((stats) => setStatsFor({ sel, result, stats }))
        .catch(() => {})
    }, 120)
    return () => window.clearTimeout(t)
  }, [sel, result])
  const stats = statsFor && statsFor.sel === sel && statsFor.result === result ? statsFor.stats : null

  const source = useMemo(
    () =>
      result && !result.message
        ? { key: result.id, rowCount: result.rowCount, columns: result.columns, fetch: result.fetch }
        : null,
    [result],
  )

  const doExport = async (format: ExportFormat, excelSafe: boolean, withRows = false) => {
    if (!result) return
    setBusy(`Exporting ${format === 'xlsx' ? 'Excel' : format.toUpperCase()}…`)
    let stopped = false
    try {
      let blob: Blob
      let rows = result.rowCount
      if (format === 'xlsx') {
        // Written in this tab, a window of rows at a time; loaded only when someone exports to Excel.
        const { writeWorkbook, XLSX_MAX_ROWS } = await import('./engine/xlsx-write')
        rows = Math.min(rows, XLSX_MAX_ROWS)
        setBusyCancel(() => () => {
          stopped = true
        })
        // The rows are read a window at a time: keep this result's table even if newer queries run meanwhile.
        const release = holdResult(result)
        // A pivot's own rows, on a second sheet: run now (they're not on screen).
        const behind = withRows && editingPivot ? await runSql(pivotOrigin!.sql) : null
        const releaseBehind = behind ? holdResult(behind) : () => {}
        try {
          const sheet = (r: ResultSet, label: string) => ({
            name: label,
            src: {
              columns: r.columns,
              rowCount: r.rowCount,
              fetch: (s: number, e: number) => r.fetch(s, e),
              onProgress: (done: number) => rows > 20_000 && setBusy(`Exporting Excel… ${Math.floor((100 * done) / Math.max(rows, 1))}%`),
              cancelled: () => stopped,
            },
          })
          blob = await writeWorkbook(behind ? [sheet(result, 'pivot'), sheet(behind, 'rows')] : [sheet(result, resultLabel())])
        } finally {
          release()
          releaseBehind()
        }
      } else {
        blob = await exportResult(result, format, { excelSafe })
      }
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = exportName(format)
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      const cut = rows < result.rowCount ? ` (the first ${nf.format(rows)}: Excel's limit; use CSV or Parquet for all ${nf.format(result.rowCount)})` : ''
      say(`Downloaded ${a.download} · ${nf.format(rows)} rows${cut}${format === 'csv' && !excelSafe ? ' (exact values)' : ''}`)
    } catch (e) {
      if (stopped || (e instanceof DOMException && e.name === 'AbortError')) say('Export cancelled')
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setBusyCancel(null)
    }
  }

  const fileInputEl = (
    <input
      ref={fileInput}
      type="file"
      multiple
      accept={ACCEPTED}
      hidden
      onChange={(e) => {
        void loadFiles(Array.from(e.target.files ?? []))
        e.target.value = ''
      }}
    />
  )

  const dropOverlay = dragging && (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-overlay-card">
        <Icon name="upload" size={28} />
        <strong>Drop to open</strong>
        <span>It stays on this computer</span>
      </div>
    </div>
  )

  if (!tables.length && !result) {
    return (
      <>
        <div className="atmosphere" aria-hidden />
        <Landing
          ready={ready}
          failed={engineFailed}
          offlineReady={offlineReady}
          busy={busy}
          sharedSql={shared}
          onPick={() => fileInput.current?.click()}
          onDemo={() => void loadDemo()}
          onMessy={() => void import('./engine/messy').then((m) => loadFiles([m.messyFile()]))}
        />
        {error && (
          <p className="toast toast-error" role="alert">
            <span className="toast-text">
              {errorText}
              {typeof error !== 'string' && error.detail && (
                <details className="error-detail">
                  <summary>Details</summary>
                  <code>{error.detail}</code>
                </details>
              )}
            </span>
            <button className="toast-action" onClick={() => setError(null)}>
              Dismiss
            </button>
          </p>
        )}
        {/* The landing page shows what's loading in its drop zone: only a load that can be cancelled is a toast. */}
        <Toasts onUpdate={updateAvailable ? applyUpdate : undefined} busy={busyCancel ? busy : null} onCancelBusy={busyCancel} message={toast} />
        {fileInputEl}
        {dropOverlay}
      </>
    )
  }

  const menuCol = menu && result ? result.columns[menu.col] : null
  const menuPicked = menuCol ? pickedValues(ops.filters, menuCol.name) : []
  const starters = !starterMeta ? null : (starterLists[starterKey] ?? null)
  const editingPivot = !!pivotOrigin && base.trim() === pivotOrigin.pivotSql.trim()
  const editingCompare = !!compareOrigin && base.trim() === compareOrigin.sql.trim()
  const compareCounts = editingCompare ? compareOrigin!.counts : undefined
  const diffTones = editingCompare && result ? tonesFor(result.columns, compareOrigin!.layout) : null
  const changeCol = editingCompare ? compareOrigin!.layout.change : 'change'
  const isAnonymized = !!anonSql && base.trim() === anonSql.trim()
  const openName = plainTable(base)?.toLowerCase() ?? null
  // A hint counts while the table is still the one that was scanned (not replaced since, under the same name).
  const sigNow = tableSig(openName ? tables.find((t) => t.name.toLowerCase() === openName) : undefined)
  const hintFor = <T,>(m: Record<string, Hint<T[]>>): T[] | null => {
    const h = m[base.trim()]
    return h && h.sig === sigNow && h.value.length ? h.value : null
  }
  const piiHere = !isAnonymized ? hintFor(piiHints) : null
  // A freshly opened table laid out one column per month (quarter, year): offer to turn them into rows.
  // Still offered after the tidy-up suggestions (total lines left out, text converted): they come first.
  const onlyTidy = !shownOps.filters.length && !shownOps.sort && !shownOps.computed.length && !shownOps.search && !shownOps.dedupe && !shownOps.lookups?.length && !shownOps.hidden?.length
  const seriesHere = result && (openName || tableLike.has(base.trim())) && onlyTidy && !result.message ? seriesColumns(result.columns) : null
  const junkHere = !ops.drop?.length ? hintFor(junkHints) : null
  const junkChecking = !ops.drop?.length && !junkHere && junkPending.has(base.trim())
  // Checks still about the rows on screen: their table's, while the step each checked is still there.
  const checksHere =
    checks?.base === base ? checks.items.filter((c) => !c.step || ops.drop?.some((d) => d.keep === c.step) || ops.computed.some((x) => x.name === c.step)) : []
  // Column names found on a later row: offered first, before anything else is tidied.
  const namesHere = !hasOps(ops) && !running ? (hintFor(namesHints)?.[0] ?? null) : null
  // Which columns the "Convert" suggestion is about, said in their headers until they're converted (even
  // once other columns have been cleaned up).
  const textFound = hintFor(textHints)
  const unconverted = textFound?.filter((c) => !ops.clean?.some((x) => x.column === c.column && isConversion(x)))
  // Offered until something's converted (filling down or trimming first doesn't count).
  const textHere = !ops.clean?.some(isConversion) && unconverted?.length ? unconverted : null
  // Amounts stored as text that the chart and pivot can't measure until converted (each said there, with the conversion).
  const textNumbersHere = unconverted?.filter((c) => c.kind !== 'date' && result?.columns.some((x) => x.name === c.column && !x.numeric)) ?? []
  // Group names written once per group, until they're filled down.
  // Dates readable both ways, read the other way from this reader's habit: until they're swapped.
  const datesHere = hintFor(dateHints)?.filter((c) => result?.columns.some((x) => x.name === c) && !ops.clean?.some((x) => x.kind === 'swapdm' && x.column === c)) ?? []
  // Text typed with stray spaces, until each is trimmed.
  const spacesHere = hintFor(spaceHints)?.filter((c) => result?.columns.some((x) => x.name === c) && !ops.clean?.some((x) => x.kind === 'trim' && x.column === c)) ?? []
  // Columns with nothing in them, until they're hidden.
  const emptyHere = hintFor(emptyHints)?.filter((c) => result?.columns.some((x) => x.name === c)) ?? []
  // A bank statement (money in and out in two columns): offered a signed amount, until it's added.
  const statement = result && !result.message ? statementColumns(result.columns) : null
  const isNum = (name: string) => !!result?.columns.find((c) => c.name === name)?.numeric
  const amountExpr = statement ? signedAmount(statement, isNum) : null
  const amountHere = statement && !ops.computed.some((c) => c.expr === amountExpr) ? statement : null
  // Once a statement's amount is signed: its month-by-month summary (by its date column), and its narrations
  // grouped into categories (for a pivot by month).
  const monthlyHere = statement && !amountHere && plainTable(base) ? (result?.columns.find(isTemporal)?.name ?? null) : null
  const narrationHere =
    statement && !amountHere && !ops.computed.some((c) => c.categorize) ? (result?.columns.find((c) => !c.numeric && /narration|description|particulars|details|remarks|memo/i.test(c.name))?.name ?? null) : null
  const fillHere = hintFor(fillHints)?.filter((c) => result?.columns.some((x) => x.name === c) && !ops.clean?.some((x) => x.kind === 'filldown' && x.column === c)) ?? []
  const headerNotes = unconverted?.length ? Object.fromEntries(unconverted.map((c) => [c.column, c.kind === 'date' ? 'date as text' : 'number as text'])) : null
  const ofRows = baseRows?.base === base && (shownOps.filters.length || shownOps.search || shownOps.dedupe || shownOps.drop?.length) ? ` of ${nf.format(baseRows.rows)}` : ''

  /** What the current result is about, for SQL comments and file names: "customers", "oct-vs-nov". */
  function resultLabel() {
    if (editingCompare) return `${compareOrigin!.spec.before}-vs-${compareOrigin!.spec.after}`
    return referencedTables(base, tableNames)[0] ?? 'result'
  }
  /** customers-anonymized-2026-10-17.csv, orders-pivot-filtered-….parquet */
  function exportName(ext: string) {
    const parts = [resultLabel()]
    if (editingCompare) parts.push('changes')
    else if (editingPivot) parts.push('pivot')
    if (isAnonymized) parts.push('anonymized')
    if (ops.filters.length) parts.push('filtered')
    return `${parts.join('-')}-${today()}.${ext}`.replace(/[^A-Za-z0-9._-]+/g, '_')
  }
  const activeName = sel && result ? result.columns[sel.active.c]?.name : null
  // Most columns got made-up names (column1, column_2): the real names may be on a row.
  const madeUpNames = !!result && result.columns.filter((c) => /^column_?\d+$/i.test(c.name)).length >= Math.ceil((result.columns.length - 1) / 2)
  const explained: { text: string; detail?: string; code?: boolean; fix?: import('./engine/errors').Fix } | null =
    typeof error === 'string'
      ? (errorsModule?.explainError(error, {
          tables: tableNames,
          columns: tables.flatMap((t) => t.columns.map((c) => c.name)),
          monthFirst: /^en-US$/i.test(LOCALE),
          sum: errorsModule.sumExample(tables.find((t) => t.name === plainTable(base)) ?? tables[0]),
        }) ?? { text: error })
      : error
  const fixHere = fixFor(explained?.fix)
  // The query on screen failed reading a table without its tidy-up steps. When it failed on what those steps
  // change (text where a number belongs: a total line, an amount as text), running it on the tidied rows is
  // the fix, said instead of the error; otherwise it's offered beside the error's own explanation.
  const tidyHere = typeof error === 'string' && tidyFix && tidyFix.sql === editor.trim() ? tidyFix : null
  const tidyCures =
    !!tidyHere && /Could not convert|Conversion Error|No function matches the given name and argument types '\w+\(VARCHAR|Cannot compare values of type VARCHAR|Cannot mix values of type VARCHAR/i.test(error as string)

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden />

      <a
        className="skip-link"
        inert={sheet || undefined}
        href={view === 'chart' ? '#results-chart' : '#results-grid'}
        onClick={(e) => {
          e.preventDefault()
          if (view === 'chart') document.querySelector<SVGElement>('#results-chart svg')?.focus()
          else gridRef.current?.focus()
        }}
      >
        {view === 'chart' ? 'Skip to results chart' : 'Skip to results grid'}
      </a>
      <header className="topbar" inert={sheet || undefined}>
        <span className="brand">
          <Logo /> <span className="collapse-sm">Sheetah</span>
        </span>
        <button
          ref={sheetButton}
          className="btn btn-ghost btn-sm phone-only"
          aria-expanded={sheet}
          aria-controls="library"
          onClick={() => setSheetOpen(true)}
        >
          <Icon name="panel" /> <span className="collapse-sm">Tables</span>
        </button>
        <span className="topbar-sep" aria-hidden />
        <details className="netlock">
          <summary>
            <Icon name="lock" size={14} /> <span className="collapse-sm">Network locked</span>
          </summary>
          <div className="netlock-panel" role="note">
            <strong>Your data can’t leave this tab.</strong>
            <p>
              The engine can only read files you open here: URLs and other paths are switched off and locked, so even a
              pasted query can’t send data anywhere. As a second layer, the page’s security policy blocks every server
              except this site.
            </p>
            <p className="fine">Check it yourself: open DevTools → Network while you work. Nothing goes out.</p>
            {offlineReady && <p className="fine">Sheetah is saved for offline use, so it opens even without internet.</p>}
          </div>
        </details>
        <span className="spacer" />
        <button
          className="icon-pill desktop-only"
          aria-label="Keyboard shortcuts"
          aria-keyshortcuts="?"
          title="Keyboard shortcuts (?)"
          onClick={() => setShowKeys(true)}
        >
          <Icon name="keyboard" size={16} />
        </button>
        <ThemeToggle />
        <button className="btn btn-ghost btn-sm" onClick={() => void loadDemo()} disabled={!!busy}>
          <Icon name="spark" /> <span className="collapse-sm">Sample data</span>
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => fileInput.current?.click()} disabled={!!busy}>
          Open file
          <BtnIcon name="plus" />
        </button>
      </header>

      {sheet && <div className="sheet-backdrop" aria-hidden onClick={() => closeSheet()} />}
      {/* A div, not <aside>: it's the complementary landmark on desktop but a modal sheet on phones,
          and <aside> may not take role="dialog". */}
      <div
        id="library"
        className={`sidebar shell${sheet ? ' is-open' : ''}`}
        inert={(isPhone && !sheetOpen) || undefined}
        {...(sheet
          ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Tables, saved views and history' }
          : { role: 'complementary', 'aria-label': 'Tables, saved views and history' })}
      >
        <div className="core side-core">
          <div className="side-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'tables'} onClick={() => setTab('tables')}>
              Tables
            </button>
            <button role="tab" aria-selected={tab === 'saved'} onClick={() => setTab('saved')}>
              Saved{views.length ? <span className="tab-count">{views.length}</span> : null}
            </button>
            <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
              History
            </button>
          </div>
          {tab === 'tables' ? (
            <TablesPanel
              tables={tables}
              openName={openName}
              onOpen={(name) => {
                if (sheet) pickFromSheet()
                void openAndScan(name)
              }}
              onInsert={insertIntoEditor}
              onCompare={() => {
                if (sheet) closeSheet(false)
                // Opens on the pair worth comparing (the open table's other version, or the most alike).
                void import('./engine/compare').then(({ likelyPair }) => setComparing(likelyPair(tables, openName) ?? {}))
              }}
              onStack={() => {
                if (sheet) closeSheet(false)
                setStacking({})
              }}
              keep={persistSupported() ? { on: keepTables, onChange: (on) => void toggleKeep(on) } : undefined}
              colsOpen={colsOpen}
              onToggleCols={(name, open) => setColsOpen((m) => ({ ...m, [name]: open }))}
            />
          ) : tab === 'saved' ? (
            <Lazy onFail={(e) => partFailed(e, () => setTab('tables'))}>
            <SavedPanel
              views={views}
              tableNames={tableNames}
              onRun={(v) => {
                if (sheet) pickFromSheet()
                runView(v)
              }}
              onCopy={(v) => void navigator.clipboard.writeText(v.sql).then(() => say('SQL copied'))}
              onDelete={deleteView}
              fitsOn={(v) => {
                const open = tables.find((t) => t.name.toLowerCase() === openName)
                return open && viewsThatFit([v], open).length ? open.name : null
              }}
              onExport={async () => {
                const { exportViews } = await import('./engine/views-file')
                const a = document.createElement('a')
                a.href = URL.createObjectURL(new Blob([exportViews(views)], { type: 'application/json' }))
                a.download = `sheetah-views-${today()}.json`
                a.click()
                setTimeout(() => URL.revokeObjectURL(a.href), 2000)
                say(`Downloaded ${a.download} · ${views.length} ${views.length === 1 ? 'view' : 'views'}`)
              }}
              onImport={(file) => {
                // Checked before reading: a big file picked by mistake mustn't be loaded whole.
                if (file.size > 1_000_000) return setError('That file is too big to be a Sheetah views file.')
                void Promise.all([file.text(), import('./engine/views-file')])
                  .then(([text, { parseViews, mergeViews }]) => ({ incoming: parseViews(text), mergeViews }))
                  .then(({ incoming, mergeViews }) => {
                    const { views: merged, added, skipped } = mergeViews(viewsRef.current, incoming)
                    updateViews(() => merged)
                    const n = (x: number) => `${x} ${x === 1 ? 'view' : 'views'}`
                    say(
                      added.length
                        ? `Added ${n(added.length)} from ${file.name}${skipped ? ` (${skipped} already saved)` : ''}. Each shows its SQL before it first runs.`
                        : `Every view in ${file.name} is already saved.`,
                    )
                    // A colleague's tidy-up for this very export: offer it on the table that's open.
                    const open = tables.find((t) => t.name.toLowerCase() === openName)
                    const fit = open ? viewsThatFit(added, open)[0] : undefined
                    if (fit && open) {
                      const label = `“${fit.view.name}” fits ${open.name}.`
                      setNudge({ label, action: 'Review it', run: () => runViewOn.current(fit.view, fit.from, open.name) })
                      window.setTimeout(() => setNudge((n) => (n?.label === label ? null : n)), 20_000)
                    }
                  })
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              }}
            />
            </Lazy>
          ) : (
            <Lazy onFail={(e) => partFailed(e, () => setTab('tables'))}>
            <HistoryPanel
              history={history}
              remember={rememberHistory}
              onRemember={(on) => {
                setRememberHistory(on)
                store.set(REMEMBER_KEY, on ? 'on' : 'off')
                if (on) store.set(HISTORY_KEY, JSON.stringify(history))
                else store.remove(HISTORY_KEY)
              }}
              onWipe={async () => {
                await syncQueue.current
                await clearSaved()
                snapshots.current.clear()
                setKeepTables(false)
                try {
                  Object.keys(localStorage)
                    .filter((k) => k.startsWith('sheetah:') && k !== REMEMBER_KEY && k !== THEME_KEY)
                    .forEach((k) => localStorage.removeItem(k))
                } catch {
                  /* nothing stored */
                }
                setHistory([])
                setViews([])
                say('Cleared everything Sheetah stored in this browser')
              }}
              onRun={(sql) => {
                if (sheet) pickFromSheet()
                setEditor(sql)
                void execute(sql, { base: sql, ops: emptyOps() })
              }}
            />
            </Lazy>
          )}
        </div>
      </div>

      <main className="main" inert={sheet || undefined}>
        <h1 className="sr-only">Sheetah workspace</h1>
        {/* Always there, so the first result is read too; the count is the answer to a filter ("16 of 23 rows"). */}
        <p className="sr-only" role="status" aria-atomic="true">
          {result && !result.message ? `${nf.format(result.rowCount)}${ofRows} rows, ${result.columns.length} columns` : ''}
        </p>
        <section
          ref={editorShell}
          className={`shell editor-shell${sqlPeek ? ' is-peek' : ''}`}
          style={editorHeight ? ({ '--editor-h': `${editorHeight}px` } as CSSProperties) : undefined}
        >
          <div className="core editor-core">
            {sqlPeek && (
              <button
                ref={peekButton}
                className="sql-peek"
                aria-expanded="false"
                aria-controls="sql-editor"
                onClick={() => {
                  setSqlOpen(true)
                  requestAnimationFrame(focusEditor)
                }}
              >
                <code>{editor.trim().split('\n')[0] || 'Write a query'}</code>
                <span className="sql-peek-cta">
                  Edit SQL <Icon name="chevronDown" size={14} />
                </span>
              </button>
            )}
            <Suspense fallback={<div className="editor editor-loading" id="sql-editor" aria-busy="true" />}>
              <SqlEditor id="sql-editor" value={editor} onChange={setEditor} onRun={runEditor} tables={tables} />
            </Suspense>
            <div className="run-bar">
              <button className="btn btn-ghost btn-sm" onClick={() => setSaving(true)} disabled={!editor.trim()}>
                <Icon name="bookmark" /> <span className="collapse-sm">Save view</span>
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void copyShareLink()} disabled={!editor.trim()} title="Copy a link to this query (SQL only, no data)">
                <Icon name="share" /> <span className="collapse-sm">Share</span>
              </button>
              {isPhone && sqlOpen && (
                <button
                  className="btn btn-ghost btn-sm"
                  aria-expanded="true"
                  aria-controls="sql-editor"
                  onClick={() => {
                    setSqlOpen(false)
                    requestAnimationFrame(() => peekButton.current?.focus())
                  }}
                >
                  <Icon name="chevronUp" /> <span className="collapse-sm">Hide SQL</span>
                </button>
              )}
              <span className="spacer" />
              <span className="kbd-hint">
                <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd>
                <kbd>Enter</kbd> to run
              </span>
              {running ? (
                <button className="btn btn-ghost btn-danger-outline" onClick={cancelQuery}>
                  <span className="spinner" aria-hidden /> Cancel
                </button>
              ) : (
                <button className="btn btn-primary" onClick={runEditor} disabled={!editor.trim()}>
                  Run query
                  <BtnIcon name="play" />
                </button>
              )}
            </div>
          </div>
          <EditorResizer
            height={editorHeight}
            onChange={setEditorHeight}
            target={editorElement}
            controls="sql-editor"
          />
        </section>

        {/* Example queries make way once you start working on the result. */}
        {starters && !startersOff && !hasOps(ops) && (
          <StarterQueries
            starters={starters}
            current={editor}
            disabled={running}
            onRun={runStarter}
            onDismiss={() => {
              setStartersOff(true)
              store.set(STARTERS_KEY, 'off')
              requestAnimationFrame(() => document.querySelector<HTMLElement>('.view-switch button.is-on, .grid-scroll')?.focus())
            }}
          />
        )}

        {(pendingOps || pendingRun) && (
          <div className="edit-guard" role="alert">
            <span>
              <strong>You’ve edited the SQL but haven’t run it.</strong> That change would replace your edits.
            </span>
            <span className="edit-guard-actions">
              <button className="btn btn-primary btn-sm" onClick={() => runEditor()}>
                Run my edits
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => (pendingRun ? pendingRun() : pendingOps && applyOps(pendingOps, true))}>
                Replace them
              </button>
              <button
                className="link-btn"
                onClick={() => {
                  setPendingOps(null)
                  setPendingRun(null)
                }}
              >
                Cancel
              </button>
            </span>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <strong>{typeof error !== 'string' ? (error.heading ?? 'Couldn’t finish that.') : fileProblem(error) ? 'Couldn’t finish that.' : 'That query didn’t run.'}</strong>{' '}
            {tidyHere && tidyCures ? (
              <>
                <span className="is-plain">{tidyHere.label}</span>
                <button className="btn btn-primary btn-sm" onClick={tidyHere.run}>
                  Run on the tidied rows
                </button>
                <details className="error-detail">
                  <summary>Details</summary>
                  <code>{error as string}</code>
                </details>
              </>
            ) : (
              <span className={explained!.code ? undefined : 'is-plain'}>{explained!.text}</span>
            )}
            {!tidyCures && fixHere && (
              <button className="btn btn-ghost btn-sm" onClick={() => runFix(fixHere)}>
                {fixHere.label}
              </button>
            )}
            {tidyHere && !tidyCures && (
              <button className="btn btn-ghost btn-sm" onClick={tidyHere.run} title={tidyHere.label}>
                Run on the tidied rows
              </button>
            )}
            {!tidyCures && explained!.detail && (
              <details className="error-detail">
                <summary>Details</summary>
                <code>{explained!.detail}</code>
              </details>
            )}
            <button className="link-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* A query that didn't run leaves the last result on screen: dimmed, so it isn't taken for the answer. */}
        <section className={`shell grid-shell${running ? ' is-running' : ''}${typeof error === 'string' && !fileProblem(error) ? ' is-stale' : ''}`}>
          <div className="core grid-core">
            <div className="grid-toolbar">
              {result && (
                <span className="result-meta">
                  <strong>{nf.format(result.rowCount)}</strong>
                  {ofRows} rows · {result.columns.length} columns ·{' '}
                  <span className="mono">{result.elapsedMs < 1000 ? `${Math.round(result.elapsedMs)} ms` : `${(result.elapsedMs / 1000).toFixed(2)} s`}</span>
                </span>
              )}
              <HintChips
                namesRow={namesHere}
                onNames={(r) => void rowAsNames(r)}
                junk={junkHere}
                checkingTotals={junkChecking}
                fill={fillHere.length ? fillHere : null}
                empty={emptyHere.length ? emptyHere : null}
                spaces={spacesHere.length ? spacesHere : null}
                dates={datesHere.length ? { columns: datesHere, read: DATE_HABIT === 'mdy' ? 'dmy' : 'mdy' } : null}
                onSwapDates={(cols) => applyOps(withCleans(cols.map((column): Clean => ({ column, kind: 'swapdm' })).reduce(addClean, ops.clean ?? [])))}
                onTrim={(cols) => applyOps(withCleans(cols.map((column): Clean => ({ column, kind: 'trim' })).reduce(addClean, ops.clean ?? [])))}
                onHideEmpty={(cols) => applyOps({ ...ops, hidden: [...new Set([...(ops.hidden ?? []), ...cols])] })}
                onFill={(cols) => applyOps(withCleans(cols.map((column): Clean => ({ column, kind: 'filldown' })).reduce(addClean, ops.clean ?? [])))}
                amount={amountHere}
                onAmount={() => void addSignedAmount()}
                categorize={narrationHere}
                onCategorize={(column) => setCategorizing({ column })}
                monthly={!!monthlyHere}
                onMonthly={() => {
                  if (!statement || !monthlyHere) return
                  const rows = compose(base, { ...ops, sort: undefined, hidden: undefined })
                  runDerived(monthlySql(rows, statement, monthlyHere, isNum), { label: 'Money in and out by month' })
                }}
                series={seriesHere}
                text={textHere}
                personal={piiHere}
                compact={isPhone}
                onDrop={(drop) => {
                  applyOps({ ...ops, drop })
                  // The tie-out, kept above the rows: the figure people would check by hand, or the column that's short.
                  const tied = drop.find((d) => d.checked)
                  const on = base
                  if (tied?.checked) {
                    const c = tied.checked
                    void import('./engine/checks').then((m) => {
                      const found = m.tieOutText(c, nf.format)
                      addChecks(on, [found && { ...found, step: tied.keep }])
                    })
                  }
                }}
                onUnpivot={() => setUnpivoting({})}
                onConvert={(cleans) => applyOps(withCleans(cleans.reduce(addClean, ops.clean ?? [])))}
                onAnonymize={() => setAnonymizing(true)}
              />
              {compareCounts && (
                <span className="change-chips" role="group" aria-label="Filter by change">
                  {(['removed', 'added', 'changed', 'same'] as const)
                    .filter((k) => compareCounts[k])
                    .map((k) => {
                      const on = pickedValues(ops.filters, changeCol).includes(k)
                      return (
                        <button
                          key={k}
                          className={`change-chip is-${k}${on ? ' is-on' : ''}`}
                          aria-pressed={on}
                          onClick={() =>
                            applyOps({
                              ...ops,
                              filters: on
                                ? removePick(ops.filters, changeCol, k)
                                : addFilter(ops.filters, { column: changeCol, op: 'equals', value: k, exact: true, type: 'VARCHAR' }),
                            })
                          }
                        >
                          {nf.format(compareCounts[k])} {k}
                        </button>
                      )
                    })}
                </span>
              )}
              <StepChips
                ops={ops}
                onApply={applyOps}
                withoutClean={(i) => withCleans((ops.clean ?? []).filter((_, j) => j !== i))}
                withoutCleans={(is) => withCleans((ops.clean ?? []).filter((_, j) => !is.includes(j)))}
                withoutLookup={withoutLookup}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={undoOps}
                onRedo={redoOps}
                origin={originHere}
              />
              <span className="spacer" />
              {source && finding && (
                <form
                  className="find-bar"
                  role="search"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const q = findText.trim()
                    applyOps({ ...ops, search: q || undefined })
                    setFinding(false)
                    requestAnimationFrame(() => gridRef.current?.focus())
                  }}
                >
                  <Icon name="search" size={14} />
                  <input
                    ref={findInput}
                    value={findText}
                    onChange={(e) => setFindText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setFinding(false)
                        gridRef.current?.focus()
                      }
                    }}
                    placeholder="Show rows containing…"
                    aria-label="Find in every column"
                    autoFocus
                  />
                  <button className="btn btn-primary btn-sm">Find</button>
                </form>
              )}
              {source && (
                <span className="grid-actions">
                  {!finding && (
                    <button
                      className="icon-pill"
                      aria-label="Find in every column"
                      aria-keyshortcuts="Control+F Meta+F"
                      title={`Find in every column (${isMac ? '⌘' : 'Ctrl'}+F)`}
                      onClick={() => {
                        setFindText(ops.search ?? '')
                        setFinding(true)
                      }}
                    >
                      <Icon name="search" size={16} />
                    </button>
                  )}
                  <span className="view-switch" role="group" aria-label="Show result as">
                    <button className={view === 'grid' ? 'is-on' : ''} aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
                      <Icon name="table" size={14} /> Grid
                    </button>
                    <button className={view === 'chart' ? 'is-on' : ''} aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
                      <Icon name="stats" size={14} /> Chart
                    </button>
                  </span>
                  {editingCompare && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setComparing({})}>
                      <Icon name="compare" /> Edit compare
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => setPivoting(true)} disabled={!result?.table}>
                    <Icon name="layers" /> {editingPivot ? 'Edit pivot' : 'Pivot'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)} disabled={!base}>
                    <Icon name="plus" /> Add column
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setLookingUp({})}
                    disabled={!base || !result?.columns.length}
                    title="Bring in columns from another table, matched by a column (like VLOOKUP)"
                  >
                    <Icon name="link" /> Look up
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAnonymizing(true)} disabled={!result?.table}>
                    <Icon name="shield" /> Anonymize
                  </button>
                  <ExportMenu
                    disabled={!!busy}
                    onExport={(format, excelSafe, withRows) => void doExport(format, excelSafe, withRows)}
                    summary={editingPivot}
                    onAnonymize={result?.table && !isAnonymized ? () => setAnonymizing(true) : undefined}
                    personal={piiHere ?? undefined}
                    textNumbers={textHere?.map((c) => c.column)}
                    onConvert={textHere ? () => applyOps(withCleans(textHere.reduce(addClean, ops.clean ?? []))) : undefined}
                  />
                </span>
              )}
            </div>
            {result && !result.message && <Checks items={checksHere} onDismiss={() => setChecks(null)} />}

            <div className="grid-area">
              {source && view === 'chart' && result ? (
                <Lazy onFail={(e) => partFailed(e, () => setView('grid'))}>
                  <ChartPanel
                    result={result}
                    textNumbers={textNumbersHere.map((c) => c.column)}
                    onConvert={textNumbersHere.length ? () => applyOps(withCleans(textNumbersHere.reduce(addClean, ops.clean ?? []))) : undefined}
                    onOpenSql={(sql) => {
                      setView('grid')
                      setEditor(sql)
                      void execute(sql, { base: sql, ops: emptyOps() })
                    }}
                  />
                </Lazy>
              ) : source ? (
                <Grid
                  ref={gridRef}
                  source={source}
                  sort={ops.sort}
                  notes={headerNotes}
                  onHeaderClick={(col, anchor) => {
                    setMenu({ col, anchor })
                    // A suggestion toast would sit over the menu's lower half (on phones, its clean-up controls).
                    setNudge(null)
                  }}
                  onSelection={setSel}
                  onCopy={(rows, cells, truncated) =>
                    say(
                      truncated
                        ? `Copied the first ${nf.format(rows)} rows. Use Export for all ${nf.format(result?.rowCount ?? rows)}.`
                        : `Copied ${nf.format(cells)} ${cells === 1 ? 'cell' : 'cells'} from ${nf.format(rows)} ${rows === 1 ? 'row' : 'rows'}`,
                    )
                  }
                  onCopyFailed={() => setError('Couldn’t copy: the browser blocked clipboard access. Try again, or use Export.')}
                  tones={diffTones}
                />
              ) : (
                <div className="grid-empty">
                  {result?.message ? (
                    <p>
                      <Icon name="spark" /> {result.message}
                    </p>
                  ) : (
                    <p>Pick a table on the left, or write a query above.</p>
                  )}
                </div>
              )}
              {source && view === 'grid' && result && result.rowCount === 0 && (
                <div className="grid-none" role="status">
                  {ops.filters.length ? (
                    <>
                      <p>
                        No rows match <b>{describeFilter(ops.filters[ops.filters.length - 1])}</b>
                        {ops.filters.length > 1 ? ` and ${ops.filters.length - 1} other ${ops.filters.length === 2 ? 'filter' : 'filters'}` : ''}.
                      </p>
                      <span className="grid-none-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => applyOps({ ...ops, filters: ops.filters.slice(0, -1) })}>
                          Undo last filter
                        </button>
                        {ops.filters.length > 1 && (
                          <button className="btn btn-ghost btn-sm" onClick={() => applyOps({ ...ops, filters: [] })}>
                            Clear all filters
                          </button>
                        )}
                      </span>
                    </>
                  ) : openName && !hasOps(ops) ? (
                    // A header-only CSV, or a table emptied by a script: say so, rather than blame a query.
                    <p>
                      <b>{tables.find((t) => t.name.toLowerCase() === openName)?.name ?? openName}</b> has column names but no rows yet.
                    </p>
                  ) : ops.search ? (
                    <p>No rows contain “{ops.search}”.</p>
                  ) : (
                    <p>This query returned no rows.</p>
                  )}
                </div>
              )}
            </div>

            <p className="sr-only" aria-live="polite">
              {stats
                ? `Selection: ${nf.format(stats.count)} values` +
                  (stats.numericCount ? `, sum ${num(stats.sum)}, average ${num(stats.avg)}, minimum ${num(stats.min)}, maximum ${num(stats.max)}` : '')
                : ''}
            </p>
            <footer className="statusbar">
              {sel && result && view === 'grid' ? (
                <>
                  <span className="mono">
                    Row {nf.format(sel.active.r + 1)} · {activeName}
                  </span>
                  <span className="status-value" title={sel.value ?? ''}>
                    {sel.value === undefined ? '…' : sel.value === null ? 'empty (NULL)' : (sel.shown ?? sel.value)}
                  </span>
                  {/* A whole row picked near the top (its number clicked): it may be where the column names are. */}
                  {sel.r0 === sel.r1 && sel.c0 === 0 && sel.c1 === result.columns.length - 1 && result.columns.length > 1 && sel.r0 < 100 && !ops.sort && !running && madeUpNames && (
                    <button className="link-btn" onClick={() => void rowAsNames(sel.r0)}>
                      Use row {nf.format(sel.r0 + 1)} as column names
                    </button>
                  )}
                  <span className="spacer" />
                  {stats && (
                    <span className="status-stats">
                      <span>
                        Count <b>{nf.format(stats.count)}</b>
                      </span>
                      {stats.numericCount > 0 && (
                        <>
                          <span>
                            Sum <b>{num(stats.sum)}</b>
                          </span>
                          <span>
                            Average <b>{num(stats.avg)}</b>
                          </span>
                          <span>
                            Min <b>{num(stats.min)}</b>
                          </span>
                          <span>
                            Max <b>{num(stats.max)}</b>
                          </span>
                        </>
                      )}
                    </span>
                  )}
                </>
              ) : (
                <span className="muted">
                  {view === 'chart'
                    ? isPhone
                      ? 'Tap the chart to read exact values.'
                      : 'Hover the chart, or focus it and use the arrow keys, to read exact values.'
                    : isPhone
                      ? 'Tap a column name to sort, filter, clean or profile it.'
                      : 'Click a column name to sort, filter, clean or profile it. Drag across cells to see their sum and average.'}
                </span>
              )}
            </footer>
          </div>
        </section>
      </main>

      {pivoting && result && (
        <Lazy
          onFail={(e) =>
            partFailed(e, () => {
              setPivoting(false)
              setPivotStart(null)
            })
          }
        >
          <PivotDialog
            sourceSql={editingPivot ? pivotOrigin!.sql : result.sql}
            columns={editingPivot ? pivotOrigin!.columns : result.columns}
            rowCount={editingPivot ? pivotOrigin!.rowCount : result.rowCount}
            initial={editingPivot ? pivotOrigin!.spec : undefined}
            start={editingPivot ? undefined : (pivotStart ?? undefined)}
            textNumbers={editingPivot ? undefined : textNumbersHere.map((c) => c.column)}
            onConvert={!editingPivot && textNumbersHere.length ? () => applyOps(withCleans(textNumbersHere.reduce(addClean, ops.clean ?? []))) : undefined}
            onClose={() => {
              setPivoting(false)
              setPivotStart(null)
            }}
            onCreate={(sql, spec) => {
              const origin = editingPivot ? pivotOrigin! : { sql: result.sql, columns: result.columns, rowCount: result.rowCount }
              setPivotOrigin({ ...origin, spec, pivotSql: sql })
              setPivoting(false)
              setPivotStart(null)
              setView('grid')
              setEditor(sql)
              void execute(sql, { base: sql, ops: emptyOps() }).then((res) => res && say(`Pivot: ${res.rowCount.toLocaleString(LOCALE)} rows × ${res.columns.length} columns`))
            }}
          />
        </Lazy>
      )}

      {anonymizing && result && (
        <Lazy onFail={(e) => partFailed(e, () => setAnonymizing(false))}>
          <AnonymizeDialog
            result={result}
            label={resultLabel()}
            onClose={() => setAnonymizing(false)}
            onCreate={(sql, summary) => {
              setAnonymizing(false)
              setAnonSql(sql)
              setView('grid')
              setEditor(sql)
              void execute(sql, { base: sql, ops: emptyOps() }).then(
                (res) => res && say(`Anonymized result: ${summary}. Export it, or save it as a view to re-run next month.`),
              )
            }}
          />
        </Lazy>
      )}
      {stacking && (
        <Lazy onFail={(e) => partFailed(e, () => setStacking(null))}>
          <StackDialog
            tables={tables}
            around={stacking.around}
            onClose={() => setStacking(null)}
            onStack={(sql) => {
              setStacking(null)
              setView('grid')
              setEditor(sql)
              void execute(sql, { base: sql, ops: emptyOps() })
            }}
          />
        </Lazy>
      )}
      {comparing && (
        <Lazy onFail={(e) => partFailed(e, () => setComparing(null))}>
          <CompareDialog
            tables={tables}
            before={comparing.before}
            after={comparing.after}
            initial={editingCompare ? compareOrigin!.spec : undefined}
            onClose={() => setComparing(null)}
            onCompare={async (sql, spec) => {
              const { compareLayout, changeCounts } = await import('./engine/compare') // loaded with the dialog
              const layout = compareLayout(spec)
              setComparing(null)
              setCompareOrigin({ spec, sql, layout })
              setView('grid')
              setEditor(sql)
              void execute(sql, { base: sql, ops: emptyOps() }).then(async (res) => {
                if (!res?.table) return
                const counts = await changeCounts(res.table, layout.change).catch(() => ({}) as Record<string, number>)
                setCompareOrigin((o) => (o?.sql === sql ? { ...o, counts } : o))
              })
            }}
          />
        </Lazy>
      )}

      {menu && menuCol && result && (
        <Lazy onFail={(e) => partFailed(e, () => setMenu(null))}>
          <ColumnMenu
            result={result}
            column={menuCol}
            anchor={menu.anchor}
            sortDir={ops.sort?.column === menuCol.name ? ops.sort.dir : undefined}
            onClose={() => {
              setMenu(null)
              gridRef.current?.focus()
            }}
            onSort={(dir) => applyOps({ ...ops, sort: dir ? { column: menuCol.name, dir } : undefined })}
            onFilter={(f: Filter) => applyOps({ ...ops, filters: addFilter(ops.filters, f) })}
            picked={menuPicked}
            valuesSql={menuPicked.length ? compose(base, { ...ops, sort: undefined, filters: removePickAll(ops.filters, menuCol.name) }) : null}
            onUnpick={(v) => applyOps({ ...ops, filters: removePick(ops.filters, menuCol.name, v) })}
            onDedupe={(mode) => applyOps({ ...ops, dedupe: { column: menuCol.name, mode } })}
            // Columns added with "Add column" are formulas: clean the columns they're made from instead.
            // Formula columns and looked-up columns are made later in the query: clean what they're made from.
            onClean={derived.has(menuCol.name) ? undefined : (c) => applyOps(withCleans(addClean(ops.clean ?? [], c)))}
            onCleans={derived.has(menuCol.name) ? undefined : (cs) => applyOps(withCleans(cs.reduce(addClean, ops.clean ?? [])))}
            cleaned={ops.clean?.filter((c) => c.column === menuCol.name)}
            onUnclean={() => applyOps(withCleans((ops.clean ?? []).filter((c) => c.column !== menuCol.name)))}
            onInsert={() => {
              insertIntoEditor(sqlName(menuCol.name))
              setMenu(null)
            }}
            onLookup={
              ops.computed.some((c) => c.name === menuCol.name)
                ? undefined
                : () => {
                    setLookingUp({ here: menuCol.name })
                    setMenu(null)
                  }
            }
            onAddColumns={(list) => {
              setMenu(null)
              reveal.current = list[0]?.name ?? null
              applyOps({ ...ops, computed: [...ops.computed.filter((c) => !list.some((l) => l.name === c.name)), ...list] })
            }}
            onHide={result.columns.length > 1 ? () => applyOps({ ...ops, hidden: [...new Set([...(ops.hidden ?? []), menuCol.name])] }) : undefined}
            onCountBy={() => {
              const c = sqlName(menuCol.name)
              const rows = compose(base, { ...ops, sort: undefined, hidden: undefined })
              // Dates and times are counted per month (counting each timestamp would be one row per row).
              const sql = isTemporal(menuCol)
                ? `SELECT date_trunc('month', ${c}) AS month, count(*) AS row_count\nFROM (\n${rows}\n)\nGROUP BY 1\nORDER BY 1`
                : `SELECT ${c}, count(*) AS row_count\nFROM (\n${rows}\n)\nGROUP BY ${c}\nORDER BY row_count DESC`
              setMenu(null)
              runDerived(sql, { label: `Rows counted by ${menuCol.name}${isTemporal(menuCol) ? ' (per month)' : ''}` })
            }}
            onUnpivot={result.columns.length > 1 ? () => {
              setMenu(null)
              setUnpivoting({ around: menuCol.name })
            } : undefined}
            onCategorize={
              base && !isTemporal(menuCol) && !menuCol.numeric && !ops.computed.some((x) => x.name === menuCol.name && !x.categorize)
                ? () => {
                    setMenu(null)
                    const added = ops.computed.find((x) => x.name === menuCol.name && x.categorize)
                    setCategorizing(added ? { edit: added.name } : { column: menuCol.name })
                  }
                : undefined
            }
            categorized={ops.computed.some((x) => x.name === menuCol.name && x.categorize)}
          />
        </Lazy>
      )}
      {categorizing && result?.table && (
        <Lazy onFail={(e) => partFailed(e, () => setCategorizing(null))}>
          <CategorizeDialog
            table={result.table}
            // Words are looked for in the rows' own columns (not in another added column).
            columns={result.columns.filter((c) => !ops.computed.some((x) => x.name === c.name))}
            rowCount={result.rowCount}
            column={categorizing.column}
            initial={(() => {
              const added = categorizing.edit ? ops.computed.find((x) => x.name === categorizing.edit) : undefined
              return added?.categorize ? { ...added.categorize, name: added.name } : undefined
            })()}
            // Every name in use: shown, hidden, and added columns still on their way.
            taken={[...result.columns.map((c) => c.name), ...(ops.hidden ?? []), ...ops.computed.map((c) => c.name)]}
            onClose={() => setCategorizing(null)}
            onAdd={addCategories}
          />
        </Lazy>
      )}
      {unpivoting && result && (
        <Lazy onFail={(e) => partFailed(e, () => setUnpivoting(null))}>
          <UnpivotDialog
            columns={result.columns}
            rows={result.rowCount}
            source={compose(base, { ...ops, sort: undefined })}
            around={unpivoting.around}
            onClose={() => setUnpivoting(null)}
            onApply={(sql) => {
              setUnpivoting(null)
              setView('grid')
              runDerived(sql, { label: 'Columns turned into rows' })
            }}
          />
        </Lazy>
      )}
      {lookingUp && result && (
        <Lazy onFail={(e) => partFailed(e, () => setLookingUp(null))}>
          <LookupDialog
            // Formula columns can't be matched on (they're computed after look-ups).
            columns={result.columns.filter((c) => !ops.computed.some((x) => x.name === c.name))}
            // Names already used, hidden ones included, so brought columns never clash.
            taken={[...result.columns.map((c) => c.name), ...(ops.hidden ?? [])]}
            // The match preview runs on exactly the rows the look-up will see (cleaned, earlier look-ups, filters).
            source={compose(base, { ...ops, sort: undefined, hidden: undefined })}
            tables={tables.filter((t) => t.name.toLowerCase() !== (plainTable(base) ?? '').toLowerCase())}
            initialHere={lookingUp.here}
            onClose={() => setLookingUp(null)}
            onApply={(l) => {
              setLookingUp(null)
              reveal.current = l.bring[0]?.as ?? null
              applyOps({ ...ops, lookups: [...(ops.lookups ?? []), l] })
            }}
          />
        </Lazy>
      )}
      {adding && result && (
        <Lazy onFail={(e) => partFailed(e, () => setAdding(false))}>
          <AddColumn
            columns={result.columns}
            source={compose(base, { ...ops, sort: undefined, hidden: undefined })}
            onClose={() => setAdding(false)}
            onAdd={(name, expr) => {
              setAdding(false)
              reveal.current = name
              applyOps({ ...ops, computed: [...ops.computed.filter((c) => c.name !== name), { name, expr }] })
            }}
          />
        </Lazy>
      )}
      {shared && (
        <Lazy onFail={(e) => partFailed(e, () => setShared(null))}>
          <SharedQueryDialog
            sql={shared}
            onClose={() => setShared(null)}
            onUse={() => {
              setEditor(shared)
              setShared(null)
              say('Shared query is in the editor. Review it, then press Run.')
            }}
          />
        </Lazy>
      )}
      {saving && (
        <Lazy onFail={(e) => partFailed(e, () => setSaving(false))}>
          <SaveViewDialog
            sql={editor.trim()}
            tables={editorTables}
            initialName={editorTables[0] ? `${editorTables[0].replace(/_/g, ' ')} view` : 'My view'}
            onSave={saveView}
            onClose={() => setSaving(false)}
          />
        </Lazy>
      )}
      {remap && (
        <Lazy onFail={(e) => partFailed(e, () => setRemap(null))}>
          <RemapDialog
            view={remap.view}
            missing={remap.missing}
            available={tableNames}
            shapes={Object.fromEntries(tables.map((t) => [t.name, t.columns.map((c) => c.name)]))}
            prefer={tables.find((t) => t.name.toLowerCase() === openName)?.name}
            onClose={() => setRemap(null)}
            onRun={(mapping, remember) => {
              const sql = remapTables(remap.view.sql, mapping)
              if (remember) {
                updateViews((v) =>
                  v.map((x) =>
                    x.id === remap.view.id
                      ? {
                          ...x,
                          sql,
                          tables: x.tables.map((t) => mapping[t] ?? t),
                          shapes: x.shapes && Object.fromEntries(Object.entries(x.shapes).map(([t, cols]) => [mapping[t] ?? t, cols])),
                          steps: x.steps && remapSteps(x.steps, mapping),
                        }
                      : x,
                  ),
                )
              }
              setRemap(null)
              runViewSql(remap.view, sql, mapping)
            }}
          />
        </Lazy>
      )}
      <Toasts
        onUpdate={updateAvailable ? applyUpdate : undefined}
        busy={busy}
        onCancelBusy={busyCancel}
        undo={undo}
        onUndone={() => setUndo(null)}
        nudge={nudge}
        onNudgeDone={() => setNudge(null)}
        message={toast}
      />
      {showKeys && (
        <Lazy onFail={(e) => partFailed(e, () => setShowKeys(false))}>
          <ShortcutsDialog onClose={() => setShowKeys(false)} />
        </Lazy>
      )}
      {fileInputEl}
      {dropOverlay}
    </div>
  )
}
