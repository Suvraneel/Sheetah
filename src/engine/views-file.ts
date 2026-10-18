/*
 * Views files: saved views exported to hand to someone or move to another browser, and imported from
 * one (loaded only when a file is exported or picked).
 */
import { categorizeExpr, type Categorize } from './categorize'
import { cleanShapes, newId, stepsOf, strings, tablesIn, type SavedView, type ViewSteps } from './views'

/** An added column's category rules, kept only if they are exactly its formula (what runs is what's edited). */
function rulesThatFit(c: { expr: string; categorize?: unknown }): Categorize | undefined {
  const r = c.categorize as Categorize | undefined
  try {
    const ok = !!r && typeof r.column === 'string' && Array.isArray(r.rules) && r.rules.every((x) => x && typeof x.category === 'string' && Array.isArray(x.words) && x.words.every((w) => typeof w === 'string'))
    return ok && (r.otherwise === undefined || typeof r.otherwise === 'string') && categorizeExpr(r) === c.expr ? r : undefined
  } catch {
    return undefined
  }
}

/*
 * Views travel as a small JSON file (Saved › Export), so a tidy-up made once can be handed to a colleague
 * or moved to another browser. Only the SQL and names travel, never data; an imported view runs only
 * when it's clicked, like a shared link.
 */
const FORMAT = 'sheetah-views'
const MAX_IMPORT = 1_000_000

export function exportViews(views: SavedView[]): string {
  return JSON.stringify(
    {
      format: FORMAT,
      version: 1,
      // Steps travel without the tie-out's sums (those are the file's data, not the view's).
      views: views.map(({ name, sql, tables, shapes, savedAt, steps }) => ({
        name,
        sql,
        tables,
        shapes,
        savedAt,
        ...(steps ? { steps: { ...steps, ops: { ...steps.ops, drop: steps.ops.drop?.map(({ label, keep, kind }) => ({ label, keep, ...(kind ? { kind } : {}) })) } } } : {}),
      })),
    },
    null,
    2,
  )
}

/**
 * Views from an exported file, checked field by field (anything else in the file is ignored). A view's
 * tables are the ones its SQL reads, whatever the file says, and every imported view is marked for
 * review: its SQL is shown before it first runs.
 */
export function parseViews(text: string): SavedView[] {
  if (text.length > MAX_IMPORT) throw new Error('That file is too big to be a Sheetah views file.')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('That isn’t a Sheetah views file (it isn’t JSON).')
  }
  const list = (data as { format?: unknown; views?: unknown })?.format === FORMAT ? (data as { views: unknown }).views : null
  if (!Array.isArray(list)) throw new Error('That isn’t a Sheetah views file.')
  const out: SavedView[] = []
  const now = Date.now()
  for (const v of list.slice(0, 500) as Record<string, unknown>[]) {
    if (!v || typeof v !== 'object' || typeof v.name !== 'string' || typeof v.sql !== 'string' || !v.name.trim() || !v.sql.trim()) continue
    const read = new Set(tablesIn(v.sql).map((t) => t.toLowerCase()))
    const tables = (strings(v.tables) ? v.tables : []).filter((t) => read.has(t.toLowerCase()))
    out.push({
      id: newId(),
      // Printable text only: a name is shown in lists and toasts.
      // oxlint-disable-next-line no-control-regex -- control characters are what this removes
      name: v.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, 120) || 'Imported view',
      sql: v.sql,
      tables,
      shapes: cleanShapes(v.shapes, tables),
      // Never later than now, so a file can't put its views first.
      savedAt: typeof v.savedAt === 'number' && Number.isFinite(v.savedAt) ? Math.min(v.savedAt, now) : now,
      imported: true,
      // Kept only if they're exactly the SQL (checked again whenever the view runs).
      ...(v.steps && typeof v.steps === 'object' ? { steps: v.steps as ViewSteps } : {}),
    })
    const last = out.at(-1)!
    if (last.steps && !stepsOf(last)) delete last.steps
    if (last.steps)
      last.steps = {
        ...last.steps,
        ops: { ...last.steps.ops, computed: last.steps.ops.computed.map(({ categorize, ...c }) => ({ ...c, ...(rulesThatFit({ ...c, categorize }) ? { categorize } : {}) })) },
      }
  }
  if (!out.length) throw new Error('That views file has no views in it.')
  return out
}

/**
 * Imported views added to the saved ones. One already saved (same name and SQL) is skipped; a name
 * already taken by another view gets "(2)", "(3)"…
 */
export function mergeViews(current: SavedView[], incoming: SavedView[]): { views: SavedView[]; added: SavedView[]; skipped: number } {
  const key = (v: SavedView) => `${v.name.toLowerCase()}\u0000${v.sql.trim()}`
  const seen = new Set(current.map(key))
  const taken = new Set(current.map((v) => v.name.toLowerCase()))
  const added: SavedView[] = []
  let skipped = 0
  for (const v of incoming) {
    if (seen.has(key(v))) {
      skipped++
      continue
    }
    seen.add(key(v))
    let name = v.name
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${v.name} (${i})`
    taken.add(name.toLowerCase())
    added.push({ ...v, name })
  }
  return { views: [...added, ...current], added, skipped }
}
