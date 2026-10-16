import { quoteIdent } from './db'

/**
 * Saved views: named queries kept in this browser. The point is re-use: next month's export arrives
 * with a different table name, so a view remembers which tables it reads and can be re-pointed.
 */
export interface SavedView {
  id: string
  name: string
  sql: string
  tables: string[]
  savedAt: number
  lastRunAt?: number
}

const KEY = 'quarry:views'

export function loadViews(): SavedView[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedView[]
  } catch {
    return []
  }
}

export function storeViews(views: SavedView[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(views))
  } catch {
    /* storage unavailable: views live for this session only */
  }
}

/** Walks SQL tokens outside strings and comments, calling `visit` for each identifier. */
function rewriteIdentifiers(sql: string, visit: (name: string, quoted: boolean, afterDot: boolean) => string | null): string {
  let out = ''
  let i = 0
  let lastSignificant = ''
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
      const replaced = visit(name, true, lastSignificant === '.')
      out += replaced ?? raw
      i = end
      lastSignificant = '"'
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++
      const word = sql.slice(i, j)
      const replaced = visit(word, false, lastSignificant === '.')
      out += replaced ?? word
      i = j
      lastSignificant = 'w'
      continue
    }
    if (!/\s/.test(ch)) lastSignificant = ch
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
  rewriteIdentifiers(sql, (name, _q, afterDot) => {
    const hit = !afterDot && lower.get(name.toLowerCase())
    if (hit) found.add(hit)
    return null
  })
  return [...found]
}

/** Replaces table identifiers (bare or quoted) according to `mapping` (old → new). */
export function remapTables(sql: string, mapping: Record<string, string>): string {
  const lower = new Map(Object.entries(mapping).map(([from, to]) => [from.toLowerCase(), to]))
  return rewriteIdentifiers(sql, (name, _q, afterDot) => {
    const to = !afterDot && lower.get(name.toLowerCase())
    if (!to) return null
    return /^[a-z_][a-z0-9_]*$/.test(to) ? to : quoteIdent(to)
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

export const newId = () => Math.random().toString(36).slice(2, 10)
