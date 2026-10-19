import { compose, type Ops } from './compose'
import { sqlName } from './sql'

/**
 * Saved views: named queries kept in this browser. The point is re-use: next month's export arrives
 * with a different table name, so a view remembers which tables it reads and can be re-pointed.
 */
export interface SavedView {
  id: string
  name: string
  sql: string
  tables: string[]
  /** Column names of each table when the view was saved: how next month's file is recognised. */
  shapes?: Record<string, string[]>
  savedAt: number
  lastRunAt?: number
  /** Came from a views file and hasn't been looked at yet: shown for review before it first runs. */
  imported?: boolean
  /** The table's steps it was saved from (header actions): back as chips when it runs. */
  steps?: ViewSteps
  /**
   * The rows it last ran on: their table, how many, and (a statement's) closing balance, so next month's file
   * is checked to open there. The file's data: kept in this browser, never written to a views file.
   */
  last?: { table: string; rows: number; closing?: number }
  /**
   * Each statement period it has run on (first and last date), with where it closed: next month's file is
   * checked to open where the period just before it closed. Also kept in this browser only.
   */
  periods?: { from: string; to: string; closing: number; table: string; rows: number }[]
}

/** A table and the steps on it (sort, filters, clean-up, look-ups…) that a view's SQL was made from. */
export interface ViewSteps {
  table: string
  ops: Ops
}

/** The rows of a table, as the workspace reads them: the base its steps are composed on. */
export const tableBase = (table: string) => `SELECT * FROM ${sqlName(table)}`

/**
 * A view's steps, when they are exactly its SQL. Anything else (edited SQL, a views file whose steps
 * say something its SQL doesn't) is ignored and the SQL runs as written: steps never run unseen.
 */
export function stepsOf(view: SavedView): ViewSteps | null {
  const s = view.steps as Partial<ViewSteps> | undefined
  if (!s || typeof s.table !== 'string' || !s.ops || typeof s.ops !== 'object' || !Array.isArray(s.ops.filters) || !Array.isArray(s.ops.computed)) return null
  return stepsMake(s as ViewSteps, view.sql) ? (s as ViewSteps) : null
}

/** SQL without its comments (real ones: never a "--" inside 'text' or "a name"), spacing evened out. */
export function withoutComments(sql: string): string {
  let out = ''
  let plain = '' // text outside quotes since the last quoted part (a comment counts as a space)
  let last = 0
  for (const m of sql.matchAll(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g)) {
    plain += sql.slice(last, m.index)
    last = m.index + m[0].length
    if (m[0].startsWith('--') || m[0].startsWith('/*')) {
      plain += ' '
      continue
    }
    // Quoted text and names exactly as written.
    out += plain.replace(/\s+/g, ' ') + m[0]
    plain = ''
  }
  return (out + (plain + sql.slice(last)).replace(/\s+/g, ' ')).trim()
}

/**
 * Whether steps compose to exactly this SQL (comments aside: a re-pointed view's comment can still name
 * last month's table). Malformed steps (a views file) never do.
 */
export function stepsMake(steps: ViewSteps, sql: string): boolean {
  try {
    const made = withoutComments(compose(tableBase(steps.table), steps.ops))
    // Saved before the steps' SQL was read from one more SELECT (so a WHERE typed after it works): the
    // same steps, in the SQL they made then.
    return made === withoutComments(sql) || made === withoutComments(`SELECT *\nFROM (\n${sql}\n)`)
  } catch {
    return false
  }
}

/** Steps pointed at other tables (next month's file, and a look-up's table if that moved too). */
export function remapSteps(steps: ViewSteps, mapping: Record<string, string>): ViewSteps {
  const lower = new Map(Object.entries(mapping).map(([from, to]) => [from.toLowerCase(), to]))
  const to = (t: string) => lower.get(t.toLowerCase()) ?? t
  return { table: to(steps.table), ops: { ...steps.ops, lookups: steps.ops.lookups?.map((l) => ({ ...l, table: to(l.table) })) } }
}

const KEY = 'sheetah:views'

export function loadViews(): SavedView[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedView[]
    // Stored views are checked like imported ones: a bad entry is dropped, never trusted.
    return Array.isArray(list)
      ? list
          .filter((v) => v && typeof v.sql === 'string' && typeof v.name === 'string')
          .map((v) => ({ ...v, tables: strings(v.tables) ? v.tables : [], shapes: cleanShapes(v.shapes, v.tables), last: cleanLast(v.last), periods: cleanPeriods(v.periods) }))
      : []
  } catch {
    return []
  }
}

/** A view's last run, only if it's the shape it should be (a number that isn't one would make a check lie). */
function cleanLast(v: unknown): SavedView['last'] {
  const l = v as Partial<NonNullable<SavedView['last']>> | null | undefined
  if (!l || typeof l !== 'object' || typeof l.table !== 'string' || typeof l.rows !== 'number' || !Number.isFinite(l.rows)) return undefined
  return { table: l.table, rows: l.rows, ...(typeof l.closing === 'number' && Number.isFinite(l.closing) ? { closing: l.closing } : {}) }
}

/** A view's periods, only those of the right shape (dates as YYYY-MM-DD, a number for the closing balance). */
function cleanPeriods(v: unknown): SavedView['periods'] {
  if (!Array.isArray(v)) return undefined
  const day = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)
  const ok = v.filter((p) => p && day(p.from) && day(p.to) && typeof p.closing === 'number' && Number.isFinite(p.closing) && typeof p.table === 'string' && typeof p.rows === 'number')
  return ok.length ? ok.slice(-36).map(({ from, to, closing, table, rows }) => ({ from, to, closing, table, rows })) : undefined
}

export const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * A view's column shapes, rebuilt as a plain record with no prototype: only the view's own tables, each a
 * list of names. ("__proto__" or "constructor" as a table name must never reach an inherited property.)
 */
export function cleanShapes(shapes: unknown, tables: unknown): Record<string, string[]> | undefined {
  if (!shapes || typeof shapes !== 'object' || Array.isArray(shapes) || !strings(tables)) return undefined
  const out = Object.create(null) as Record<string, string[]>
  for (const t of tables) {
    const cols = Object.hasOwn(shapes, t) ? (shapes as Record<string, unknown>)[t] : undefined
    if (strings(cols)) out[t] = cols.slice(0, 2000)
  }
  return Object.keys(out).length ? out : undefined
}

/** A view's column names for one of its tables (own entries only). */
export const shapeOf = (v: SavedView, table: string): string[] | undefined => (v.shapes && Object.hasOwn(v.shapes, table) ? v.shapes[table] : undefined)

export function storeViews(views: SavedView[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(views))
  } catch {
    /* storage unavailable: views live for this session only */
  }
}

/** Words after which an identifier names a table: FROM sales, JOIN regions, UNPIVOT wide. */
const TABLE_BEFORE = new Set(['from', 'join', 'unpivot', 'pivot', 'summarize', 'describe', 'table', 'into', 'update'])
/** Words that end a FROM list (so a later "x, y" is a list of columns again). */
const FROM_ENDS = new Set(['where', 'group', 'order', 'having', 'limit', 'qualify', 'window', 'union', 'except', 'intersect', 'on', 'using', 'select', 'set', 'values', 'returning', 'offset'])

/**
 * Walks SQL tokens outside strings and comments, calling `visit` for each identifier with whether it is
 * in a table's place: after FROM / JOIN (or a comma in a FROM list), or qualifying a column (sales.amount).
 * A column that happens to share a table's name ("sales" in sales.csv) is left alone.
 */
function rewriteIdentifiers(sql: string, visit: (name: string, quoted: boolean, afterDot: boolean, table: boolean) => string | null): string {
  let out = ''
  let i = 0
  let lastSignificant = ''
  let prevWord = ''
  const inFrom: boolean[] = [false]
  const nextIsDot = (from: number) => {
    let k = from
    while (k < sql.length && /\s/.test(sql[k])) k++
    return sql[k] === '.'
  }
  const tablePlace = (end: number, afterDot: boolean) =>
    !afterDot && ((lastSignificant === 'w' && TABLE_BEFORE.has(prevWord)) || (lastSignificant === ',' && inFrom[inFrom.length - 1]) || nextIsDot(end))
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'") {
      const end = findClose(sql, i, "'")
      out += sql.slice(i, end)
      i = end
      lastSignificant = "'"
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      out += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '"') {
      const end = findClose(sql, i, '"')
      const raw = sql.slice(i, end)
      const name = raw.slice(1, -1).replace(/""/g, '"')
      const afterDot = lastSignificant === '.'
      const replaced = visit(name, true, afterDot, tablePlace(end, afterDot))
      out += replaced ?? raw
      i = end
      lastSignificant = '"'
      prevWord = ''
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++
      const word = sql.slice(i, j)
      const afterDot = lastSignificant === '.'
      const replaced = visit(word, false, afterDot, tablePlace(j, afterDot))
      out += replaced ?? word
      i = j
      const lower = word.toLowerCase()
      if (lower === 'from' || lower === 'join') inFrom[inFrom.length - 1] = true
      else if (FROM_ENDS.has(lower)) inFrom[inFrom.length - 1] = false
      lastSignificant = 'w'
      prevWord = lower
      continue
    }
    if (ch === '(') inFrom.push(false)
    if (ch === ')' && inFrom.length > 1) inFrom.pop()
    if (!/\s/.test(ch)) {
      lastSignificant = ch
      prevWord = ''
    }
    out += ch
    i++
  }
  return out
}

function findClose(sql: string, start: number, q: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

/** Which of the known tables does this SQL mention? */
export function referencedTables(sql: string, known: string[]): string[] {
  const lower = new Map(known.map((t) => [t.toLowerCase(), t]))
  const found = new Set<string>()
  rewriteIdentifiers(sql, (name, _q, _afterDot, table) => {
    const hit = table && lower.get(name.toLowerCase())
    if (hit) found.add(hit)
    return null
  })
  return [...found]
}

/** Replaces table identifiers (bare or quoted) according to `mapping` (old → new). */
export function remapTables(sql: string, mapping: Record<string, string>): string {
  const lower = new Map(Object.entries(mapping).map(([from, to]) => [from.toLowerCase(), to]))
  return rewriteIdentifiers(sql, (name, _q, _afterDot, table) => {
    const to = table && lower.get(name.toLowerCase())
    if (!to) return null
    return sqlName(to) // quoted as the steps' own SQL would quote it
  })
}

/** Best guess for which current table replaces a missing one (shared prefix, then shared words). */
export function suggestTable(missing: string, candidates: string[]): string | undefined {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !/^\d+$/.test(w)))
  const mw = words(missing)
  let best: string | undefined
  let bestScore = -1
  for (const c of candidates) {
    let prefix = 0
    while (prefix < Math.min(c.length, missing.length) && c[prefix] === missing[prefix]) prefix++
    let shared = 0
    for (const w of words(c)) if (mw.has(w)) shared++
    const score = shared * 10 + prefix
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/**
 * Saved views that would run on `table` in place of the table they were saved on: views that read one
 * table, whose columns the new table has too (next month's export, under another file name). The most
 * recently used first.
 */
export function viewsThatFit(views: SavedView[], table: { name: string; columns: { name: string }[] }, open: string[] = []): { view: SavedView; from: string }[] {
  const have = new Set(table.columns.map((c) => c.name.toLowerCase()))
  const isOpen = new Set(open.map((t) => t.toLowerCase()))
  // A view of one table; or of several (this month's sales looked up in the product list), when the table that
  // changes month to month is the one that fits and the others are open as they were.
  const fits = (v: SavedView, from: string) => {
    const shape = shapeOf(v, from)
    return !!shape && shape.length >= 2 && from.toLowerCase() !== table.name.toLowerCase() && shape.every((c) => have.has(c.toLowerCase()))
  }
  return [...views]
    .sort((a, b) => (b.lastRunAt ?? b.savedAt) - (a.lastRunAt ?? a.savedAt))
    .flatMap((view) => {
      const from = view.tables.length === 1 ? view.tables[0] : view.tables.find((t) => fits(view, t) && view.tables.every((o) => o === t || isOpen.has(o.toLowerCase())))
      return from && fits(view, from) ? [{ view, from }] : []
    })
}

/** The tables a query reads (names in a table's place, as written). */
export function tablesIn(sql: string): string[] {
  const found = new Map<string, string>()
  rewriteIdentifiers(sql, (name, _q, _afterDot, table) => {
    if (table && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), name)
    return null
  })
  return [...found.values()]
}

export const newId = () => Math.random().toString(36).slice(2, 10)

const MONTH = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)'

/**
 * A name for a view of a table, without the table's month or year: the view is for every month's file
 * (stmt_apr_2024 → "stmt view", sales-2024-04 → "sales view"). The table's own name if nothing else is left.
 */
export function viewNameFor(table: string): string {
  const words = table.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim()
  const left = words
    .replace(new RegExp(`(^| )${MONTH}(?= |$|\\d)`, 'gi'), ' ')
    .replace(/(^| )(fy|q[1-4])? ?\d{2,8}(?= |$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${left || words || 'My'} view`
}
