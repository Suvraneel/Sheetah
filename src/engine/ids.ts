/*
 * India's tax and bank identifiers, checked where a column is named for one: a GSTIN's last character is a
 * check digit (a mistyped character shows), a PAN and an IFSC code have a fixed shape. A wrong one means a
 * return that won't file or a payment that bounces, so it's said as the table opens (loaded with the scans).
 */
import type { Check } from './checks'
import type { ColumnInfo } from './result'
import { nameKey, quoteIdent } from './sql'

export type IdKind = 'gstin' | 'pan' | 'ifsc'

// The name ends with what it holds ("Supplier GSTIN", "GSTIN of Supplier", "PAN No."): not "GSTIN Status",
// "GST Registration Type" or "Is GSTIN Valid", which are about one.
const NAMES: [IdKind, RegExp][] = [
  ['gstin', /(^|_)(gstin|gstn|gst_?(no|number|id|reg(istration)?_?(no|number)))(_uin)?(_of_[a-z_]+)?$/],
  ['pan', /(^|_)pan(_?(no|number|card(_no)?))?(_of_[a-z_]+)?$/],
  ['ifsc', /(^|_)ifsc(_?code)?$/],
]
const LABEL: Record<IdKind, string> = { gstin: 'GSTIN', pan: 'PAN', ifsc: 'IFSC code' }
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The text columns named for an identifier (GSTIN, PAN No, IFSC Code), and which. */
export function idColumns(columns: ColumnInfo[]): { column: ColumnInfo; kind: IdKind }[] {
  return columns.flatMap((column) => {
    if (column.numeric || !/CHAR|TEXT|STRING/i.test(column.type)) return []
    const kind = NAMES.find(([, re]) => re.test(nameKey(column.name)))?.[0]
    return kind ? [{ column, kind }] : []
  })
}

/**
 * SQL true when a value (upper case, trimmed) is well formed. A GSTIN: a state code, 13 more, the last a
 * check character from the first 14 (each worth its place in 0–9A–Z, every second one doubled, digits of base 36
 * summed). A PAN: five letters (the fourth says who: P a person, C a company…), four digits, a letter.
 */
export function idOk(kind: IdKind, v: string): string {
  if (kind === 'pan') return `regexp_full_match(${v}, '[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]')`
  if (kind === 'ifsc') return `regexp_full_match(${v}, '[A-Z]{4}0[A-Z0-9]{6}')`
  const at = (i: number) => `(instr('${ALNUM}', substr(${v}, ${i + 1}, 1)) - 1)`
  const sum = Array.from({ length: 14 }, (_, i) => (i % 2 ? `(${at(i)} * 2 // 36 + ${at(i)} * 2 % 36)` : at(i))).join(' + ')
  // Any registration (a business's on its PAN, a TDS deductor's on its TAN, a UIN): its check character.
  return `(regexp_full_match(${v}, '[0-9]{2}[0-9A-Z]{13}') AND substr('${ALNUM}', (36 - (${sum}) % 36) % 36 + 1, 1) = substr(${v}, 15, 1))`
}

/**
 * How many values a column has, how many aren't well formed, and the first few that aren't. Values with no
 * digit aren't identifiers at all (NA, URP, Unregistered, PANNOTAVBL): not counted.
 */
export function idCheckSql(table: string, column: ColumnInfo, kind: IdKind): string {
  // As result.ts's colRef (not imported: that would load the engine with these checks' tests).
  const v = `upper(trim(${quoteIdent(column.ident ?? column.name)}::VARCHAR))`
  return `SELECT count(*)::DOUBLE AS n, count(*) FILTER (WHERE NOT ok)::DOUBLE AS bad, (list(v ORDER BY r) FILTER (WHERE NOT ok))[1:3] AS examples
FROM (SELECT rowid AS r, v, ${idOk(kind, 'v')} AS ok FROM (SELECT rowid, nullif(${v}, '') AS v FROM ${table}) WHERE regexp_matches(v, '[0-9]'))`
}

export interface IdFinding {
  column: string
  kind: IdKind
  n: number
  bad: number
  examples: string[]
}

/** What the identifiers' checks found, as one check: the columns with a wrong one, else that all are well formed. */
export function idCheckText(found: IdFinding[]): Check | null {
  const seen = found.filter((f) => f.n > 0)
  if (!seen.length) return null
  const off = seen.filter((f) => f.bad > 0)
  if (off.length) {
    const say = (f: IdFinding) => {
      // "1 GSTIN doesn't…" for a column that's only named for it; "in Supplier GSTIN" otherwise.
      const plain = /^(gstin|gstn|gst(no|number)?|pan(no|number|card)?|ifsc(code)?)$/.test(f.column.toLowerCase().replace(/[^a-z]/g, ''))
      const what = `${f.bad === 1 ? LABEL[f.kind] : `${LABEL[f.kind]}s`}${plain ? '' : ` in ${f.column}`}`
      const why = f.kind === 'gstin' ? ' (a character mistyped, or the wrong length)' : ''
      return `${f.bad} ${what} ${f.bad === 1 ? 'doesn’t' : 'don’t'} look right${why}: ${f.examples.join(', ')}${f.bad > f.examples.length ? '…' : ''}`
    }
    return { kind: 'ids', ok: false, text: off.map(say).join('; ') }
  }
  const kinds = [...new Set(seen.map((f) => LABEL[f.kind]))]
  return { kind: 'ids', ok: true, text: `Every ${kinds.join(' and ')} is well formed: ${seen.map((f) => `${f.column} ${f.n}`).join(' · ')}` }
}

/** Reads a check's row (from idCheckSql). */
export function readIdRow(column: string, kind: IdKind, row: Record<string, unknown>): IdFinding {
  const examples = Array.isArray(row.examples) ? row.examples : row.examples && typeof row.examples === 'object' && 'toArray' in row.examples ? (row.examples as { toArray: () => unknown[] }).toArray() : []
  return { column, kind, n: Number(row.n ?? 0), bad: Number(row.bad ?? 0), examples: examples.map(String) }
}
