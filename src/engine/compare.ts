import { getEngine, quoteIdent } from './db'
import { find, schemaDiff, type CompareSpec, type TableColumns } from './compare-sql'

export * from './compare-sql'

const KEY_HINT = /(^|_)(id|key|code|uuid|guid|email|sku|no|num|number|ref)$/i

/** Shared columns that identify a row in both tables (unique and never empty), best names first. */
export async function suggestKeys(before: TableColumns, after: TableColumns, diff = schemaDiff(before, after)): Promise<string[]> {
  const { conn } = await getEngine()
  const changedType = new Set(diff.typeChanged.map((c) => c.name))
  const candidates = diff.shared
    .filter((n) => !/^(DOUBLE|FLOAT|REAL|BOOLEAN)/i.test(find(before, n)!.type))
    // Names that sound like keys first; columns whose type changed between the files last.
    .sort((a, b) => Number(changedType.has(a)) - Number(changedType.has(b)) || Number(KEY_HINT.test(b)) - Number(KEY_HINT.test(a)))
    .slice(0, 8)
  const out: string[] = []
  for (const name of candidates) {
    const ok = await Promise.all(
      [before.name, after.name].map(async (t) => {
        const c = quoteIdent(name)
        const r = (await conn.query(`SELECT count(*) = count(DISTINCT ${c}) AND count(${c}) = count(*) AS ok FROM ${quoteIdent(t)}`)).toArray()[0]
        return !!r?.toJSON().ok
      }),
    )
    if (ok.every(Boolean)) out.push(name)
  }
  return out
}

export interface KeyHealth {
  table: string
  /** Rows sharing a key with another row. */
  duplicates: number
  /** Rows with an empty key column. */
  empty: number
}

/** How well the chosen key identifies rows in each table. */
export async function keyHealth(spec: Pick<CompareSpec, 'before' | 'after' | 'keys'>): Promise<KeyHealth[]> {
  if (!spec.keys.length) return []
  const { conn } = await getEngine()
  const keys = spec.keys.map(quoteIdent).join(', ')
  const anyNull = spec.keys.map((k) => `${quoteIdent(k)} IS NULL`).join(' OR ')
  return Promise.all(
    [spec.before, spec.after].map(async (table) => {
      const r = (
        // Repeats are counted among rows that have a key; rows without one are reported separately.
        await conn.query(`SELECT
            (count(*) FILTER (WHERE NOT (${anyNull})) - count(DISTINCT (${keys})) FILTER (WHERE NOT (${anyNull})))::DOUBLE AS dup,
            count(*) FILTER (WHERE ${anyNull})::DOUBLE AS empty
          FROM ${quoteIdent(table)}`)
      ).toArray()[0]?.toJSON() as { dup: number; empty: number } | undefined
      return { table, duplicates: Number(r?.dup ?? 0), empty: Number(r?.empty ?? 0) }
    }),
  )
}

/** The default comparison for two tables: a key if one exists, every shared column compared. */
export async function defaultCompare(before: TableColumns, after: TableColumns): Promise<CompareSpec> {
  const diff = schemaDiff(before, after)
  const keys = (await suggestKeys(before, after, diff)).slice(0, 1)
  return {
    before: before.name,
    after: after.name,
    mode: keys.length ? 'key' : 'row',
    keys,
    columns: diff.shared.filter((c) => !keys.includes(c)),
    // Spaces around a value are noise; a change of case or a small number change may be the point.
    trimSpaces: true,
    ignoreCase: false,
    tolerance: null,
    includeSame: false,
  }
}

/** Rows per kind of change in a compare result (for the summary chips). */
export async function changeCounts(table: string, column = 'change'): Promise<Record<string, number>> {
  const { conn } = await getEngine()
  const rows = (await conn.query(`SELECT ${quoteIdent(column)}::VARCHAR AS k, count(*)::DOUBLE AS n FROM ${table} GROUP BY 1`)).toArray()
  return Object.fromEntries(rows.map((r) => [String(r.toJSON().k), Number(r.toJSON().n)]))
}

