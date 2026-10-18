import { getEngine, quoteIdent, quoteLiteral } from './db'
import { RULES, nameSuggests, type PiiKind } from './pii-rules'
import { colRef, type ColumnInfo, type ResultSet } from './result'

export interface Detection {
  column: string
  kind: PiiKind
  /** Share of non-empty sampled values that look like this kind (null when detected by name only). */
  ratio: number | null
  /** Share passing the checksum (Aadhaar, cards), when the kind has one. */
  verified?: number
}

/** Words that make a name a company's: Inc, LLC, Ltd, Pvt, Corp, Enterprises, Industries, Traders… */
/** Places, not people: a NAME column of counties and districts ("Autauga County, Alabama", "Hartlepool UA"). */
const PLACE = '(^|[^a-z])(county|district|borough|parish|city|town|village|region|province|state|municipality|council|ward|census tract|tract|ua|lad|kreis|landkreis|gemeinde|stadt)([^a-z]|$)'
const COMPANY = '(^|[^a-z])(inc|llc|llp|ltd|limited|pvt|plc|corp|corporation|co|company|gmbh|enterprises?|industries|traders|trading|associates|solutions|services|systems|technologies|group|holdings|bank|store|shop|foods|bakery|motors|labs?|studio|agency|partners)([^a-z]|$)'

export const SAMPLE_ROWS = 5000

const TEXTY = /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|BIGINT|HUGEINT|UBIGINT|INTEGER|UINTEGER)/i
const TEMPORAL = /^(DATE|TIMESTAMP)/i

/**
 * Looks for personal data in a result: each column's name, and how many of up to 5,000 sampled values
 * match each kind's pattern (all in SQL, in this tab), plus checksums for Aadhaar and card numbers.
 */
export async function detectPii(result: ResultSet): Promise<Detection[]> {
  if (!result.table || !result.rowCount) return []
  const { conn } = await getEngine()
  const cols = result.columns.filter((c) => TEXTY.test(c.type) || TEMPORAL.test(c.type))
  if (!cols.length) return []

  const patterned = RULES.filter((r) => r.pattern)
  const texty = [...cols.entries()].filter(([, c]) => TEXTY.test(c.type))
  // Twenty columns a query: a wide table's patterns all at once would run the engine out of memory.
  const counts: Record<string, number> = {}
  for (let k = 0; k < texty.length; k += 20) {
    const parts: string[] = []
    for (const [i, c] of texty.slice(k, k + 20)) {
      const v = `trim(${colRef(c)}::VARCHAR)`
      parts.push(`count(nullif(${v}, ''))::DOUBLE AS "n${i}"`)
      patterned.forEach((r, j) => parts.push(`count(*) FILTER (WHERE regexp_full_match(${v}, ${quoteLiteral(r.pattern!)}))::DOUBLE AS "m${i}_${j}"`))
      // Companies, not people ("Wayne Enterprises", "Acme Pvt Ltd"): a Customer column of them isn't personal.
      parts.push(`count(*) FILTER (WHERE regexp_matches(lower(${v}), ${quoteLiteral(COMPANY)}))::DOUBLE AS "co${i}"`)
      parts.push(`count(*) FILTER (WHERE regexp_matches(lower(${v}), ${quoteLiteral(PLACE)}))::DOUBLE AS "pl${i}"`)
    }
    const row = (await conn.query(`WITH s AS (SELECT * FROM ${result.table} USING SAMPLE ${SAMPLE_ROWS} ROWS) SELECT ${parts.join(', ')} FROM s`)).toArray()[0]?.toJSON()
    Object.assign(counts, row ?? {})
  }

  const out: Detection[] = []
  for (const [i, c] of cols.entries()) {
    const nonEmpty = Number(counts[`n${i}`] ?? 0)
    let best: Detection | null = null
    for (const [j, r] of patterned.entries()) {
      if (!TEXTY.test(c.type)) break
      const ratio = nonEmpty ? Number(counts[`m${i}_${j}`] ?? 0) / nonEmpty : 0
      const byValues = nonEmpty >= 3 && ratio >= 0.6
      const byName = nameSuggests(r, c.name) && ratio >= 0.3
      if ((byValues || byName) && (!best || ratio > (best.ratio ?? 0))) best = { column: c.name, kind: r.kind, ratio }
    }
    // Checksums separate real Aadhaar/card numbers from other long numbers.
    const rule = best && RULES.find((r) => r.kind === best!.kind)
    if (best && rule?.verify) {
      const sample = await sampleValues(result.table, c, rule.pattern!)
      const pass = sample.filter(rule.verify).length
      best.verified = sample.length ? pass / sample.length : 0
      if (best.verified < 0.9 && !nameSuggests(rule, c.name)) best = null
    }
    if (!best) {
      // Kinds recognised by name: names, birth dates, addresses (and the others when the column name says so).
      const named = RULES.find((r) => nameSuggests(r, c.name) && (r.kind === 'birthdate' ? true : TEXTY.test(c.type) && !TEMPORAL.test(c.type)))
      // A phone or postal code column by its name alone (written any country's way); names unless nearly all are
      // companies (a few people among them are still people), or most are places (counties, districts).
      const companies = nonEmpty > 0 && (Number(counts[`co${i}`] ?? 0) / nonEmpty >= 0.9 || Number(counts[`pl${i}`] ?? 0) / nonEmpty >= 0.6)
      if (named && !(named.kind === 'name' && companies) && (named.kind === 'birthdate' || named.kind === 'phone' || named.kind === 'postcode' || !named.pattern || nonEmpty === 0))
        best = { column: c.name, kind: named.kind, ratio: null }
    }
    if (best) out.push(best)
  }
  return out
}

async function sampleValues(table: string, c: ColumnInfo, pattern: string): Promise<string[]> {
  const { conn } = await getEngine()
  const v = `trim(${colRef(c)}::VARCHAR)`
  const res = await conn.query(`SELECT ${v} AS v FROM ${table} WHERE regexp_full_match(${v}, ${quoteLiteral(pattern)}) LIMIT 300`)
  return res.toArray().map((r) => String(r.toJSON().v))
}

/** Up to `n` before → after examples for an expression, computed on the result's own rows. */
export async function previewValues(result: ResultSet, column: ColumnInfo, expr: string | null, n = 3): Promise<{ before: string; after: string | null }[]> {
  if (!result.table) return []
  const { conn } = await getEngine()
  // The expression is written against the column's own name; the result table may store it renamed.
  const ref = colRef(column)
  const named = ref === quoteIdent(column.name) ? '' : `, ${ref} AS ${quoteIdent(column.name)}`
  const res = await conn.query(
    `SELECT ${ref}::VARCHAR AS b, ${expr ? `(${expr})::VARCHAR` : 'NULL'} AS a FROM (SELECT *${named} FROM ${result.table} WHERE ${ref} IS NOT NULL LIMIT 200) USING SAMPLE ${n} ROWS`,
  )
  return res.toArray().map((r) => {
    const o = r.toJSON() as { b: string; a: string | null }
    return { before: o.b, after: o.a }
  })
}
