/*
 * A query that ran and found no rows, read for the slips that find none: = NULL, a LIKE written with *,
 * a date compared with a date-and-time, text that differs only in capitals or spaces. Each said in plain
 * words, with the query as it was probably meant. Pure text work, apart from the look-ups `probes` asks for.
 */

import { quoteLiteral, sqlName } from './sql'

export interface NoRowsReason {
  text: string
  /** The query as it was probably meant, and the button's words for running it. */
  fixed?: string
  label?: string
}

interface Column {
  name: string
  type: string
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Text with its 'strings', "names" and comments blanked out (same length), so SQL words are found only where they're SQL. */
function blank(sql: string, names = true): string {
  const re = names ? /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g : /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g
  return sql.replace(re, (m) => ' '.repeat(m.length))
}

/** Replaces each match of `re` in `sql` found where `mask` says it's SQL (not inside text or a comment). */
function replaceAt(sql: string, mask: string, re: RegExp, to: (m: RegExpExecArray) => string): string {
  let out = ''
  let last = 0
  for (const m of mask.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
    const real = new RegExp(`^(?:${re.source})$`, re.flags.replace('g', '')).exec(sql.slice(m.index, m.index + m[0].length))
    if (!real) continue
    out += sql.slice(last, m.index) + to(real)
    last = m.index + m[0].length
  }
  return out + sql.slice(last)
}

/** Where the next thing after `at` starts (past spaces): the mask has text blanked into spaces too. */
const after = (sql: string, at: number) => at + (/^\s*/.exec(sql.slice(at))?.[0].length ?? 0)

/**
 * A column's name as it may be written in the query: bare (any case) or in double quotes, after a table's
 * alias or name or not (o.city, "sales apr"."City").
 */
const nameIn = (c: string) =>
  `(?<![\\w"$.])(?:(?:[A-Za-z_]\\w*|"(?:[^"]|"")+")\\.)?(?:"${esc(c.replace(/"/g, '""'))}"|${/^[A-Za-z_]\w*$/.test(c) ? esc(c) : '(?!)'}(?![\\w"$]))`

/** The reasons that need no look-up, from the query alone. */
export function noRowsReasons(sql: string, columns: Column[]): NoRowsReason[] {
  const out: NoRowsReason[] = []
  const mask = blank(sql, false)

  // x = NULL: nothing equals NULL, not even an empty cell. (Not '= NULL' inside text.)
  // (= and ==, <> and !=; not >= or <=, which aren't a test for empty.)
  const EQ_NULL = /(?<![<>=!])(<>|!=|==?)\s*NULL\b/i
  if (EQ_NULL.test(blank(sql))) {
    const fixed = replaceAt(sql, blank(sql), EQ_NULL, (m) => (m[1].startsWith('=') ? 'IS NULL' : 'IS NOT NULL'))
    const ops = [...blank(sql).matchAll(new RegExp(EQ_NULL.source, 'gi'))].map((m) => (m[1].startsWith('=') ? 'IS NULL' : 'IS NOT NULL'))
    const label = [...new Set(ops)].join(' and ')
    out.push({ text: 'Nothing equals NULL, not even an empty cell: = NULL is never true. Empty cells are found with IS NULL (and the rest with IS NOT NULL).', fixed, label: `Use ${label}` })
  }

  // Party = '': an empty cell here is NULL (nothing in it), not text with no letters.
  for (const c of columns.filter((x) => /^(VARCHAR|TEXT|STRING)/i.test(x.type))) {
    const re = new RegExp(`(${nameIn(c.name)})\\s*=\\s*''(?!')`, 'gi')
    const hits = [...sql.matchAll(re)].filter((x) => mask.slice(x.index, x.index + x[1].length).trim())
    if (!hits.length) continue
    let fixed = sql
    for (const h of [...hits].reverse()) fixed = `${fixed.slice(0, h.index)}(${h[1]} IS NULL OR ${h[1]} = '')${fixed.slice(h.index + h[0].length)}`
    out.push({ text: `An empty cell is NULL here (nothing in it), so = '' finds none. Empty ${c.name} is ${sqlName(c.name)} IS NULL.`, fixed, label: 'Find empty cells' })
    break
  }

  // LIKE 'Pu*': in LIKE, % stands for any text and _ for one letter; * and ? are only themselves.
  // (Found where LIKE is SQL; the pattern after it is text, blanked in the mask, so read from the query.)
  const likes = [...mask.matchAll(/\b(I?LIKE)\b/gi)]
    .map((m) => ({ at: after(sql, m.index + m[0].length), word: m[1] }))
    .filter((l) => sql[l.at] === "'")
    .map((l) => ({ ...l, text: /^'((?:[^']|'')*)'/.exec(sql.slice(l.at))?.[1] ?? '' }))
    .filter((l) => /[*?]/.test(l.text) && !/[%_]/.test(l.text))
  if (likes.length) {
    let fixed = sql
    for (const l of [...likes].reverse()) fixed = `${fixed.slice(0, l.at)}'${l.text.replace(/\*/g, '%').replace(/\?/g, '_')}'${fixed.slice(l.at + l.text.length + 2)}`
    const [l] = likes
    out.push({
      text: `In LIKE, % stands for any text and _ for one letter: '${l.text}' looks for a real ${/\*/.test(l.text) ? '*' : '?'}. Written for any text: '${l.text.replace(/\*/g, '%').replace(/\?/g, '_')}'.`,
      fixed,
      label: 'Use %',
    })
  }

  // ordered_at = '2024-04-01' on a date-and-time column: only midnight that day.
  for (const c of columns.filter((x) => /^TIMESTAMP/i.test(x.type))) {
    const re = new RegExp(`(${nameIn(c.name)})\\s*=\\s*'(\\d{4}-\\d{2}-\\d{2})'`, 'gi')
    // Where the name is SQL, not inside text or a comment.
    const hits = [...sql.matchAll(re)].filter((x) => mask.slice(x.index, x.index + x[1].length).trim())
    if (!hits.length) continue
    let fixed = sql
    for (const h of [...hits].reverse()) fixed = `${fixed.slice(0, h.index)}${h[1]}::DATE = '${h[2]}'${fixed.slice(h.index + h[0].length)}`
    out.push({
      text: `${c.name} holds a time of day too, so = '${hits[0][2]}' matches only midnight. The whole day is ${sqlName(c.name)}::DATE = '${hits[0][2]}'.`,
      fixed,
      label: 'Compare the day',
    })
    break
  }
  return out
}

/** A text column compared with a value (city = 'pune', city LIKE 'pune%'), to look for in the table itself. */
export interface Probe {
  column: string
  value: string
  like: boolean
  /** Where the value is in the query, to put the table's own spelling there. */
  at: number
}

/** The comparisons worth looking up: a text column of the table read, against a value with letters in it. */
export function probes(sql: string, columns: Column[]): Probe[] {
  const mask = blank(sql, false)
  const out: Probe[] = []
  for (const c of columns.filter((x) => /^(VARCHAR|TEXT|STRING)/i.test(x.type))) {
    const re = new RegExp(`(${nameIn(c.name)})\\s*(=|LIKE\\b)`, 'gi')
    for (const m of mask.matchAll(re)) {
      const at = after(sql, m.index + m[0].length)
      if (sql[at] !== "'") continue
      const value = /^'((?:[^']|'')*)'/.exec(sql.slice(at))?.[1]
      if (value !== undefined && /[A-Za-z]/.test(value)) out.push({ column: c.name, value: value.replace(/''/g, "'"), like: /like/i.test(m[2]), at })
    }
  }
  return out.slice(0, 3)
}

/**
 * SQL that finds how the table writes a probe's value: the same but for capitals and spaces, with whether
 * each is the value exactly (then it's there, and something else in the query found no rows).
 */
export function probeSql(table: string, p: Probe): string {
  const c = `${sqlName(p.column)}::VARCHAR`
  const v = quoteLiteral(p.value)
  const test = p.like ? `${c} ILIKE ${v}` : `lower(trim(${c})) = lower(trim(${v}))`
  const exact = p.like ? `${c} LIKE ${v}` : `${c} = ${v}`
  return `SELECT DISTINCT ${c} AS v, ${exact} AS exact FROM ${sqlName(table)} WHERE ${test} ORDER BY exact DESC LIMIT 3`
}

/** What a look-up found, said: the value as the table writes it (and the query with it), or ILIKE. */
export function probeReason(sql: string, p: Probe, rows: { v: string; exact: boolean }[]): NoRowsReason | null {
  // The value is there as typed: capitals aren't why nothing was found.
  if (!rows.length || rows.some((r) => r.exact)) return null
  const found = rows.map((r) => r.v)
  const quoted = quoteLiteral(p.value)
  if (p.like) {
    const fixed = `${sql.slice(0, p.at).replace(/\bLIKE\s*$/i, 'ILIKE ')}${sql.slice(p.at)}`
    return { text: `LIKE tells capitals apart: ${quoted} misses ${quoteLiteral(found[0])}. ILIKE doesn’t.`, fixed, label: 'Use ILIKE' }
  }
  const spelling = found[0]
  // What differs, between the value typed and the table's: spaces (around either), capitals, or both.
  const spaces = spelling.trim() !== spelling || p.value.trim() !== p.value
  const capitals = spelling.trim() !== p.value.trim()
  const how = spaces && capitals ? 'with other capitals and spaces' : spaces ? `with ${spelling.trim() !== spelling ? 'spaces around it' : 'no spaces around it'}` : 'with other capitals'
  if (found.length > 1)
    return { text: `No row has ${p.column} exactly ${quoted}: the table writes it ${found.map(quoteLiteral).join(' or ')}. ${sqlName(p.column)} ILIKE ${quoted} finds them all.` }
  const fixed = `${sql.slice(0, p.at)}${quoteLiteral(spelling)}${sql.slice(p.at + quoteLiteral(p.value).length)}`
  return { text: `No row has ${p.column} exactly ${quoted}: the table writes it ${quoteLiteral(spelling)}, ${how}.`, fixed, label: `Use ${quoteLiteral(spelling)}` }
}
