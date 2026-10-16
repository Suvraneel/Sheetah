import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getEngine, quoteIdent } from './engine/db'
import { ACCEPTED, createDemo, ingestFile, listTables, type TableMeta } from './engine/ingest'
import { CancelledError, cancelRunning, exportResult, rangeStats, runSql, type RangeStats, type ResultSet } from './engine/result'
import { compose, describeFilter, emptyOps, hasOps, type Filter, type Ops } from './engine/compose'
import { Grid, type GridHandle, type SelectionInfo } from './grid/Grid'
import { SqlEditor } from './components/SqlEditor'
import { focusEditor, insertIntoEditor } from './components/editorBridge'
import { Landing } from './components/Landing'
import { ChartPanel } from './components/ChartPanel'
import { PivotDialog } from './components/PivotDialog'
import type { PivotSpec } from './engine/pivot'
import type { ColumnInfo } from './engine/result'
import { ColumnMenu } from './components/ColumnMenu'
import { AddColumn } from './components/AddColumn'
import { ExportMenu } from './components/ExportMenu'
import { ThemeToggle } from './components/ThemeToggle'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { StarterQueries } from './components/StarterQueries'
import { sampleStarters, type Starter } from './components/starters'
import { useMediaQuery } from './components/useMediaQuery'
import { THEME_KEY } from './theme'
import { EditorResizer } from './components/EditorResizer'
import { EDITOR_MIN, clampEditor } from './components/editorSize'
import { BtnIcon, Icon, Logo } from './components/Icon'
import { RemapDialog, SaveViewDialog, SharedQueryDialog } from './components/ViewDialogs'
import { decodeSql, shareUrl, takeSharedToken } from './engine/share'
import { MAX_PERSIST_ROWS, clearSaved, persistSupported, removeTable, restoreAll, saveTable } from './engine/persist'
import { loadViews, newId, referencedTables, remapTables, storeViews, type SavedView } from './engine/views'

const nf = new Intl.NumberFormat('en-US')

/** Turns engine errors people can act on into plain language. */
function friendly(message: string): string {
  if (/out of memory|failed to allocate|could not allocate/i.test(message)) {
    return 'This ran out of browser memory. Try filtering or selecting fewer columns first, or split the file. Parquet files use far less memory than CSV.'
  }
  return message
}
const GB = 1024 ** 3
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const num = (n: number | null) => (n === null ? '—' : Math.abs(n) >= 1e6 ? compact.format(n) : nf.format(Math.round(n * 100) / 100))

interface HistoryItem {
  sql: string
  at: number
  rows: number
}
const HISTORY_KEY = 'quarry:history'
const REMEMBER_KEY = 'quarry:remember-history'
const KEEP_KEY = 'quarry:keep-tables'
const EDITOR_KEY = 'quarry:editor-height'
const editorElement = () => document.getElementById('sql-editor')
const STARTERS_KEY = 'quarry:starters'
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
const loadHistory = (): HistoryItem[] => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryItem[]
  } catch {
    return []
  }
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [tables, setTables] = useState<TableMeta[]>([])
  const [result, setResult] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState('')
  const [base, setBase] = useState('')
  const [ops, setOps] = useState<Ops>(emptyOps())
  const [running, setRunning] = useState(false)
  const [menu, setMenu] = useState<{ col: number; anchor: DOMRect } | null>(null)
  const [adding, setAdding] = useState(false)
  const [sel, setSel] = useState<SelectionInfo | null>(null)
  const [stats, setStats] = useState<RangeStats | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [tab, setTab] = useState<'tables' | 'saved' | 'history'>('tables')
  const [view, setView] = useState<'grid' | 'chart'>('grid')
  const [pivoting, setPivoting] = useState(false)
  // Where the current pivot came from, so "Edit pivot" reopens it on the original data.
  const [pivotOrigin, setPivotOrigin] = useState<{ sql: string; columns: ColumnInfo[]; rowCount: number; spec: PivotSpec; pivotSql: string } | null>(null)
  const [views, setViews] = useState<SavedView[]>(loadViews)
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
  const isPhone = useMediaQuery('(max-width: 767px)')
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
  const [confirmWipe, setConfirmWipe] = useState(false)
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
      .catch((e) => setError(`The engine couldn’t start: ${e instanceof Error ? e.message : e}`))
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('debug')) {
      ;(window as unknown as Record<string, unknown>).quarry = { getEngine, runSql, createDemo, listTables }
    }
  }, [])

  // A shared query in the URL fragment: decode it, strip it from the address bar, review later.
  useEffect(() => {
    const token = takeSharedToken()
    if (token) void decodeSql(token).then((sql) => (sql ? setShared(sql) : setError('That shared link is damaged or too long to open.')))
  }, [])

  const copyShareLink = async () => {
    const sql = editor.trim()
    if (!sql) return
    try {
      await navigator.clipboard.writeText(await shareUrl(sql))
      say('Link copied. It holds only the SQL, never your data.')
    } catch {
      setError('Couldn’t copy the link. Your browser blocked clipboard access.')
    }
  }

  const say = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400)
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
    async (sql: string, opts: { base?: string; ops?: Ops; remember?: boolean } = {}) => {
      setRunning(true)
      setError(null)
      setMenu(null)
      try {
        const res = await runSql(sql)
        setResult(res)
        if (opts.base !== undefined) setBase(opts.base)
        if (opts.ops) setOps(opts.ops)
        if (res.message || /\b(create|drop|alter|insert|update|delete|copy|attach)\b/i.test(sql)) {
          const lower = sql.toLowerCase()
          for (const name of snapshots.current.keys()) if (lower.includes(name.toLowerCase())) snapshots.current.set(name, 'dirty')
          await refreshTables()
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
        if (e instanceof CancelledError) say('Query cancelled')
        else setError(friendly(e instanceof Error ? e.message : String(e)))
        return null
      } finally {
        setRunning(false)
      }
    },
    [refreshTables, say],
  )

  const openTable = useCallback(
    async (name: string) => {
      const sql = `SELECT * FROM ${quoteIdent(name)}`
      setEditor(sql)
      await execute(sql, { base: sql, ops: emptyOps(), remember: false })
    },
    [execute],
  )

  const loadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      setError(null)
      try {
        await getEngine()
        const taken = new Set(tables.map((t) => t.name))
        let first = ''
        for (const f of files) {
          if (f.size > 1.5 * GB) {
            say(`${f.name} is ${(f.size / GB).toFixed(1)} GB. Reading it can take a while, and very large CSVs can exceed browser memory.`)
          }
          setBusy(`Reading ${f.name}…`)
          const names = await ingestFile(f, taken)
          names.forEach((n) => taken.add(n))
          first ||= names[0]
          if (names.length > 1) say(`Opened ${names.length} sheets from ${f.name}`)
        }
        await refreshTables()
        setBusy(null)
        await openTable(first)
      } catch (e) {
        setBusy(null)
        const msg = e instanceof Error ? e.message : String(e)
        setError(/^(Old \.xls|That workbook)/.test(msg) ? msg : `Couldn’t open that file. Check that it’s CSV, TSV, JSON, Parquet or Excel (.xlsx). ${msg}`)
      }
    },
    [tables, refreshTables, openTable, say],
  )

  const loadDemo = useCallback(async () => {
    setError(null)
    setBusy('Generating 1,000,000 orders…')
    try {
      await getEngine()
      const name = await createDemo()
      demoTables.current.add(name)
      setSampleName(name)
      await refreshTables()
      setBusy(null)
      await openTable(name)
    } catch (e) {
      setBusy(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [refreshTables, openTable])

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
          await openTable(names[0])
        }
      } catch {
        setBusy(null)
      }
    })()
  }, [ready, say, openTable])

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
    (next: Ops) => {
      const sql = compose(base, next)
      setEditor(sql)
      void execute(sql, { ops: next, remember: false })
    },
    [base, execute],
  )

  const runEditor = useCallback(() => {
    const sql = editor.trim()
    if (!sql) return
    void execute(sql, { base: sql, ops: emptyOps() }).then((res) => {
      if (res && isPhone) {
        // Give the results the screen; if focus was in the editor, keep it on the collapsed peek.
        const inEditor = !!document.activeElement?.closest('.cm-editor')
        setSqlOpen(false)
        if (inEditor) requestAnimationFrame(() => peekButton.current?.focus())
      }
    })
  }, [editor, execute, isPhone])

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
    const view: SavedView = { id: newId(), name, sql: editor.trim(), tables: editorTables, savedAt: Date.now() }
    updateViews((v) => [view, ...v.filter((x) => x.name !== name)])
    setSaving(false)
    setTab('saved')
    say(`Saved “${name}”`)
  }

  const runViewSql = (view: SavedView, sql: string) => {
    setEditor(sql)
    updateViews((v) => v.map((x) => (x.id === view.id ? { ...x, lastRunAt: Date.now() } : x)))
    void execute(sql, { base: sql, ops: emptyOps() })
  }

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
    setStats(null)
    if (!sel || !result?.table || (sel.r0 === sel.r1 && sel.c0 === sel.c1)) return
    const cols = result.columns.slice(sel.c0, sel.c1 + 1)
    const t = window.setTimeout(() => {
      rangeStats(result, cols, sel.r0, sel.r1).then(setStats).catch(() => setStats(null))
    }, 120)
    return () => window.clearTimeout(t)
  }, [sel, result])

  const source = useMemo(
    () =>
      result && !result.message
        ? { key: result.id, rowCount: result.rowCount, columns: result.columns, fetch: result.fetch }
        : null,
    [result],
  )

  const doExport = async (format: 'csv' | 'parquet', excelSafe: boolean) => {
    if (!result) return
    setBusy(`Exporting ${format.toUpperCase()}…`)
    try {
      const blob = await exportResult(result, format, { excelSafe })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `quarry-result.${format}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      say(`Downloaded ${nf.format(result.rowCount)} rows as ${format.toUpperCase()}${format === 'csv' && !excelSafe ? ' (exact values)' : ''}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
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
        <Landing ready={ready} offlineReady={offlineReady} busy={busy} sharedSql={shared} onPick={() => fileInput.current?.click()} onDemo={() => void loadDemo()} />
        {error && (
          <p className="toast toast-error" role="alert">
            {error}
          </p>
        )}
        {fileInputEl}
        {dropOverlay}
      </>
    )
  }

  const menuCol = menu && result ? result.columns[menu.col] : null
  const sampleTable = sampleName && tables.some((t) => t.name === sampleName) ? sampleName : undefined
  const editingPivot = !!pivotOrigin && base.trim() === pivotOrigin.pivotSql.trim()
  const activeName = sel && result ? result.columns[sel.active.c]?.name : null

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
          <Logo /> <span className="collapse-sm">Quarry</span>
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
            {offlineReady && <p className="fine">Quarry is saved for offline use, so it opens even without internet.</p>}
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
            <ul className="side-list">
              {tables.map((t) => (
                <li key={t.name}>
                  <button
                    className="side-table"
                    onClick={() => {
                      if (sheet) pickFromSheet()
                      void openTable(t.name)
                    }}
                  >
                    <Icon name={t.kind === 'view' ? 'layers' : 'table'} />
                    <span className="side-name">{t.name}</span>
                    <span className="side-count">{t.rows === null ? 'view' : compact.format(t.rows)}</span>
                  </button>
                  <ul className="side-cols">
                    {t.columns.map((c) => (
                      <li key={c.name}>
                        <button onClick={() => insertIntoEditor(/^[a-z_][a-z0-9_]*$/.test(c.name) ? c.name : quoteIdent(c.name))} title="Insert into SQL">
                          <span>{c.name}</span>
                          <span className="side-type">{c.type.toLowerCase()}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {persistSupported() && (
                <li className="history-controls side-keep">
                  <label className="inline">
                    <input type="checkbox" checked={keepTables} onChange={(e) => void toggleKeep(e.target.checked)} />
                    Keep my tables in this browser
                  </label>
                  <span className="fine">Stored on this device only, unencrypted. Turn off to delete them.</span>
                </li>
              )}
            </ul>
          ) : tab === 'saved' ? (
            <ul className="side-list">
              {!views.length && (
                <li className="muted small pad">
                  Save a query with <b>Save view</b> to re-run it later, even on next month’s file.
                </li>
              )}
              {views.map((v) => {
                const missing = v.tables.some((t) => !tableNames.some((n) => n.toLowerCase() === t.toLowerCase()))
                return (
                  <li key={v.id} className="view-item">
                    <button
                      className="side-view"
                      onClick={() => {
                        if (sheet) pickFromSheet()
                        runView(v)
                      }}
                      title={v.sql}
                    >
                      <span className="side-view-name">
                        <Icon name="bookmark" size={14} /> {v.name}
                      </span>
                      <span className="side-type">
                        {v.tables.length ? v.tables.join(', ') : 'no tables'}
                        {missing ? ' · pick a table' : ''}
                      </span>
                    </button>
                    <span className="view-actions">
                      <button
                        className="icon-btn"
                        title="Copy SQL"
                        aria-label={`Copy SQL of ${v.name}`}
                        onClick={() => void navigator.clipboard.writeText(v.sql).then(() => say('SQL copied'))}
                      >
                        <Icon name="copy" size={14} />
                      </button>
                      <button className="icon-btn" title="Delete" aria-label={`Delete ${v.name}`} onClick={() => deleteView(v)}>
                        <Icon name="trash" size={14} />
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <ul className="side-list">
              <li className="history-controls">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={rememberHistory}
                    onChange={(e) => {
                      const on = e.target.checked
                      setRememberHistory(on)
                      store.set(REMEMBER_KEY, on ? 'on' : 'off')
                      if (on) store.set(HISTORY_KEY, JSON.stringify(history))
                      else store.remove(HISTORY_KEY)
                    }}
                  />
                  Remember queries in this browser
                </label>
                {confirmWipe ? (
                  <span className="wipe-confirm">
                    Delete history, saved views and kept tables?{' '}
                    <button
                      className="link-btn danger-link"
                      onClick={async () => {
                        await syncQueue.current
                        await clearSaved()
                        snapshots.current.clear()
                        setKeepTables(false)
                        try {
                          Object.keys(localStorage)
                            .filter((k) => k.startsWith('quarry:') && k !== REMEMBER_KEY && k !== THEME_KEY)
                            .forEach((k) => localStorage.removeItem(k))
                        } catch {
                          /* nothing stored */
                        }
                        setHistory([])
                        setViews([])
                        setConfirmWipe(false)
                        say('Cleared everything Quarry stored in this browser')
                      }}
                    >
                      Yes, clear
                    </button>{' '}
                    <button className="link-btn" onClick={() => setConfirmWipe(false)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button className="link-btn" onClick={() => setConfirmWipe(true)}>
                    Clear all local data
                  </button>
                )}
              </li>
              {!history.length && (
                <li className="muted small pad">
                  {rememberHistory ? 'Queries you run will show up here.' : 'History is kept for this tab only.'}
                </li>
              )}
              {history.map((h) => (
                <li key={h.at}>
                  <button
                    className="side-history"
                    onClick={() => {
                      if (sheet) pickFromSheet()
                      setEditor(h.sql)
                      void execute(h.sql, { base: h.sql, ops: emptyOps() })
                    }}
                  >
                    <code>{h.sql}</code>
                    <span className="side-type">
                      {nf.format(h.rows)} rows · {new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <main className="main" inert={sheet || undefined}>
        <h1 className="sr-only">Quarry workspace</h1>
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
            <SqlEditor id="sql-editor" value={editor} onChange={setEditor} onRun={runEditor} tables={tables} />
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
                <button className="btn btn-ghost btn-danger-outline" onClick={() => void cancelRunning()}>
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

        {sampleTable && !startersOff && (
          <StarterQueries
            starters={sampleStarters(sampleTable)}
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

        {error && (
          <div className="error-banner" role="alert">
            <strong>{/(support couldn’t|support isn’t included|Couldn’t open|can’t be exported|Old \.xls|That workbook|took too long)/.test(error) ? 'Couldn’t finish that.' : 'That query didn’t run.'}</strong>{' '}
            <span>{error.replace(/^.*?Error: /, '')}</span>
            <button className="link-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <section className={`shell grid-shell${running ? ' is-running' : ''}`}>
          <div className="core grid-core">
            <div className="grid-toolbar">
              {result && (
                <span className="result-meta">
                  <strong>{nf.format(result.rowCount)}</strong> rows · {result.columns.length} columns ·{' '}
                  <span className="mono">{result.elapsedMs < 1000 ? `${Math.round(result.elapsedMs)} ms` : `${(result.elapsedMs / 1000).toFixed(2)} s`}</span>
                </span>
              )}
              <span className="op-chips">
                {ops.sort && (
                  <button className="op-chip" onClick={() => applyOps({ ...ops, sort: undefined })} title="Remove sort">
                    <Icon name={ops.sort.dir === 'asc' ? 'sortAsc' : 'sortDesc'} size={14} /> {ops.sort.column}
                    <Icon name="close" size={12} />
                  </button>
                )}
                {ops.filters.map((f, i) => (
                  <button
                    key={i}
                    className="op-chip"
                    onClick={() => applyOps({ ...ops, filters: ops.filters.filter((_, j) => j !== i) })}
                    title="Remove filter"
                  >
                    <Icon name="filter" size={14} /> {describeFilter(f)}
                    <Icon name="close" size={12} />
                  </button>
                ))}
                {ops.computed.map((c, i) => (
                  <button
                    key={c.name}
                    className="op-chip"
                    onClick={() => applyOps({ ...ops, computed: ops.computed.filter((_, j) => j !== i) })}
                    title="Remove column"
                  >
                    <Icon name="column" size={14} /> {c.name}
                    <Icon name="close" size={12} />
                  </button>
                ))}
                {hasOps(ops) && (
                  <button className="link-btn" onClick={() => applyOps(emptyOps())}>
                    Clear all
                  </button>
                )}
              </span>
              <span className="spacer" />
              {source && (
                <span className="grid-actions">
                  <span className="view-switch" role="group" aria-label="Show result as">
                    <button className={view === 'grid' ? 'is-on' : ''} aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
                      <Icon name="table" size={14} /> Grid
                    </button>
                    <button className={view === 'chart' ? 'is-on' : ''} aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
                      <Icon name="stats" size={14} /> Chart
                    </button>
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPivoting(true)} disabled={!result?.table}>
                    <Icon name="layers" /> {editingPivot ? 'Edit pivot' : 'Pivot'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)} disabled={!base}>
                    <Icon name="plus" /> Add column
                  </button>
                  <ExportMenu disabled={!!busy} onExport={(format, excelSafe) => void doExport(format, excelSafe)} />
                </span>
              )}
            </div>

            <div className="grid-area">
              {source && view === 'chart' && result ? (
                <ChartPanel
                  result={result}
                  onOpenSql={(sql) => {
                    setView('grid')
                    setEditor(sql)
                    void execute(sql, { base: sql, ops: emptyOps() })
                  }}
                />
              ) : source ? (
                <Grid
                  ref={gridRef}
                  source={source}
                  sort={ops.sort}
                  onHeaderClick={(col, anchor) => setMenu({ col, anchor })}
                  onSelection={setSel}
                  onCopy={(rows, cells) => say(`Copied ${nf.format(cells)} ${cells === 1 ? 'cell' : 'cells'} from ${nf.format(rows)} ${rows === 1 ? 'row' : 'rows'}`)}
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
                    {sel.value === undefined ? '…' : sel.value === null ? 'NULL' : sel.value}
                  </span>
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
                    ? 'Hover the chart, or focus it and use the arrow keys, to read exact values.'
                    : 'Click a column name to sort, filter or profile it. Drag across cells to see their sum and average.'}
                </span>
              )}
            </footer>
          </div>
        </section>
      </main>

      {pivoting && result && (
        <PivotDialog
          sourceSql={editingPivot ? pivotOrigin!.sql : result.sql}
          columns={editingPivot ? pivotOrigin!.columns : result.columns}
          rowCount={editingPivot ? pivotOrigin!.rowCount : result.rowCount}
          initial={editingPivot ? pivotOrigin!.spec : undefined}
          onClose={() => setPivoting(false)}
          onCreate={(sql, spec) => {
            const origin = editingPivot ? pivotOrigin! : { sql: result.sql, columns: result.columns, rowCount: result.rowCount }
            setPivotOrigin({ ...origin, spec, pivotSql: sql })
            setPivoting(false)
            setView('grid')
            setEditor(sql)
            void execute(sql, { base: sql, ops: emptyOps() }).then((res) => res && say(`Pivot: ${res.rowCount.toLocaleString('en-US')} rows × ${res.columns.length} columns`))
          }}
        />
      )}

      {menu && menuCol && result && (
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
          onFilter={(f: Filter) => applyOps({ ...ops, filters: [...ops.filters, f] })}
          onInsert={() => {
            insertIntoEditor(/^[a-z_][a-z0-9_]*$/.test(menuCol.name) ? menuCol.name : quoteIdent(menuCol.name))
            setMenu(null)
          }}
        />
      )}
      {adding && result && (
        <AddColumn
          columns={result.columns}
          onClose={() => setAdding(false)}
          onAdd={(name, expr) => {
            setAdding(false)
            applyOps({ ...ops, computed: [...ops.computed.filter((c) => c.name !== name), { name, expr }] })
          }}
        />
      )}
      {shared && (
        <SharedQueryDialog
          sql={shared}
          onClose={() => setShared(null)}
          onUse={() => {
            setEditor(shared)
            setShared(null)
            say('Shared query is in the editor. Review it, then press Run.')
          }}
        />
      )}
      {saving && (
        <SaveViewDialog
          sql={editor.trim()}
          tables={editorTables}
          initialName={editorTables[0] ? `${editorTables[0].replace(/_/g, ' ')} view` : 'My view'}
          onSave={saveView}
          onClose={() => setSaving(false)}
        />
      )}
      {remap && (
        <RemapDialog
          view={remap.view}
          missing={remap.missing}
          available={tableNames}
          onClose={() => setRemap(null)}
          onRun={(mapping, remember) => {
            const sql = remapTables(remap.view.sql, mapping)
            if (remember) {
              updateViews((v) =>
                v.map((x) =>
                  x.id === remap.view.id ? { ...x, sql, tables: x.tables.map((t) => mapping[t] ?? t) } : x,
                ),
              )
            }
            setRemap(null)
            runViewSql(remap.view, sql)
          }}
        />
      )}
      {undo && !busy && (
        <p className="toast" role="status">
          {undo.label}
          <button
            className="toast-action"
            onClick={() => {
              undo.run()
              setUndo(null)
            }}
          >
            Undo
          </button>
        </p>
      )}
      {(busy || toast) && !(undo && !busy) && (
        <p className="toast" role="status">
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="spark" />} {busy ?? toast}
        </p>
      )}
      {showKeys && <ShortcutsDialog onClose={() => setShowKeys(false)} />}
      {fileInputEl}
      {dropOverlay}
    </div>
  )
}
