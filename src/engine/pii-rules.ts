import { commentText, nameKey, quoteLiteral, sqlName } from './sql'

/*
 * Personal-data rules for "Anonymize": what each kind looks like, how to verify it, and the SQL each
 * action compiles to. Pure functions (no engine), so they're unit-tested in Node.
 */
export type PiiKind = 'email' | 'phone' | 'aadhaar' | 'pan' | 'card' | 'ip' | 'name' | 'birthdate' | 'address' | 'postcode'

export type PiiAction = 'keep' | 'mask' | 'pseudonym' | 'label' | 'generalize' | 'remove'

export interface PiiRule {
  kind: PiiKind
  label: string
  /** Column names that suggest this kind. */
  hint: RegExp
  /** A value of this kind, tested in SQL on trim(value::VARCHAR) (RE2 syntax). Absent: name hint only. */
  pattern?: string
  /** Extra check on the sampled values (checksums), as a share of values passing. */
  verify?: (v: string) => boolean
  defaultAction: PiiAction
  actions: PiiAction[]
}

const digits = (v: string) => v.replace(/\D/g, '')

/** Luhn checksum, used by payment card numbers. */
export function luhn(v: string): boolean {
  const d = digits(v)
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2 === 1) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}

// Verhoeff tables (Aadhaar numbers end in a Verhoeff check digit).
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

export function verhoeff(v: string): boolean {
  const d = digits(v)
  if (!d.length) return false
  let c = 0
  for (let i = 0; i < d.length; i++) c = VD[c][VP[i % 8][Number(d[d.length - 1 - i])]]
  return c === 0
}

export const RULES: PiiRule[] = [
  {
    kind: 'email',
    label: 'Email address',
    hint: /e_?mail/i,
    pattern: '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$',
    defaultAction: 'pseudonym',
    actions: ['pseudonym', 'mask', 'label', 'remove', 'keep'],
  },
  {
    kind: 'aadhaar',
    label: 'Aadhaar number',
    hint: /aadh?aar|^uid$|uidai/i,
    pattern: '^[2-9][0-9]{3} ?[0-9]{4} ?[0-9]{4}$',
    verify: verhoeff,
    defaultAction: 'mask',
    actions: ['mask', 'pseudonym', 'remove', 'keep'],
  },
  {
    kind: 'card',
    label: 'Card number',
    hint: /card|^cc_?(num|no)|credit/i,
    pattern: '^[0-9][0-9 -]{11,22}[0-9]$',
    verify: luhn,
    defaultAction: 'mask',
    actions: ['mask', 'pseudonym', 'remove', 'keep'],
  },
  {
    kind: 'pan',
    label: 'PAN (Indian tax ID)',
    hint: /(^|_)pan(_|$)|pan_?(no|number|card)/i,
    // The 4th letter encodes the holder type (P person, C company, H HUF, F firm, A AOP, T trust…).
    pattern: '^[A-Za-z]{3}[PCHFATBLJGpchfatbljg][A-Za-z][0-9]{4}[A-Za-z]$',
    defaultAction: 'mask',
    actions: ['mask', 'pseudonym', 'remove', 'keep'],
  },
  {
    kind: 'phone',
    label: 'Phone number',
    hint: /phone|mobile|(^|_)tel(_|$)|contact_?(no|number)|whatsapp/i,
    // Indian mobiles (+91, 0 prefixes), US and Canadian numbers ((212) 555-0101), and international E.164-ish ones.
    pattern: '^(\\+?91[ -]?|0)?[6-9][0-9]{4}[ -]?[0-9]{5}$|^\\+[1-9][0-9 ()-]{7,16}[0-9]$|^(\\+?1[ .-]?)?\\(?[2-9][0-9]{2}\\)?[ .-]?[0-9]{3}[ .-][0-9]{4}$',
    defaultAction: 'mask',
    actions: ['mask', 'pseudonym', 'remove', 'keep'],
  },
  {
    kind: 'ip',
    label: 'IP address',
    hint: /(^|_)ip(_|$)|ip_?addr/i,
    pattern: '^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$',
    defaultAction: 'generalize',
    actions: ['generalize', 'pseudonym', 'remove', 'keep'],
  },
  {
    kind: 'name',
    label: 'Person’s name',
    // Only names that say whose name it is: product_name, city_name or file_name are not personal.
    // A plain "name" counts too: in a list of people it is the person's name, and a wrong guess only means
    // a column offered for anonymizing that the user keeps.
    hint: /^name$|^(full|first|last|middle|sur|given|fore|family|maiden|nick)_?name$|(^|_)(customer|patient|employee|emp|contact|person|member|student|client|applicant|candidate|guardian|father|mother|spouse|nominee|beneficiary|tenant|guest|passenger|driver|recipient|sender|buyer|holder|owner|user)_?(full_?|first_?|last_?)?name$|^(customer|patient|employee|client|person)$/i,
    defaultAction: 'label',
    actions: ['label', 'pseudonym', 'mask', 'remove', 'keep'],
  },
  {
    kind: 'birthdate',
    label: 'Date of birth',
    hint: /dob|birth/i,
    defaultAction: 'generalize',
    actions: ['generalize', 'remove', 'keep'],
  },
  {
    kind: 'address',
    label: 'Address',
    hint: /address|street|addr(ess)?_?line|^addr$/i,
    defaultAction: 'remove',
    actions: ['remove', 'mask', 'keep'],
  },
  {
    kind: 'postcode',
    label: 'PIN / postal code',
    hint: /pin_?code|^pin$|zip|post_?code|postal/i,
    pattern: '^[1-9][0-9]{5}$',
    defaultAction: 'generalize',
    actions: ['generalize', 'remove', 'keep'],
  },
]

export const ruleFor = (kind: PiiKind) => RULES.find((r) => r.kind === kind)!

/** Whether a column's name suggests this kind, for spreadsheet-style headers too ("Customer Name", "eMail"). */
export const nameSuggests = (rule: PiiRule, column: string) => rule.hint.test(nameKey(column))

export const ACTION_LABEL: Record<PiiAction, string> = {
  keep: 'Keep as is',
  mask: 'Mask',
  pseudonym: 'Pseudonym',
  label: 'Replace with label',
  generalize: 'Generalize',
  remove: 'Remove column',
}

/** What an action does to this kind, in a few words (shown under the choice). */
export function actionHelp(kind: PiiKind | null, action: PiiAction): string {
  switch (action) {
    case 'keep':
      return 'Unchanged.'
    case 'remove':
      return 'The column is left out.'
    case 'pseudonym':
      return 'The same value always becomes the same code, so you can still count and join. The secret key never leaves this tab.'
    case 'label':
      return 'Each different value becomes “Person 1”, “Person 2”…'
    case 'mask':
      return kind === 'email' ? 'Keeps the first letter and the domain.' : kind === 'name' || kind === 'address' ? 'Keeps the first and last letter.' : 'Keeps the last 4 digits.'
    case 'generalize':
      return kind === 'ip' ? 'Keeps the network (/24), drops the device.' : kind === 'birthdate' ? 'Keeps the year only.' : kind === 'postcode' ? 'Keeps the first 3 digits (the area).' : 'Coarser value.'
  }
}

/**
 * The SQL expression replacing column `name` for an action, or null for keep/remove.
 * `pseudonym(v)` is a macro the engine defines with a per-session secret key (see db.ts).
 */
export function actionSql(name: string, kind: PiiKind | null, action: PiiAction, temporal = false): string | null {
  const c = sqlName(name)
  const text = `${c}::VARCHAR`
  const lastDigits = (n: number) => `right(regexp_replace(${text}, '[^0-9]', '', 'g'), ${n})`
  switch (action) {
    case 'keep':
    case 'remove':
      return null
    case 'pseudonym':
      return `pseudonym(${c})`
    case 'label': {
      const word = kind === 'name' ? 'Person' : 'Value'
      return `CASE WHEN ${c} IS NULL THEN NULL ELSE ${quoteLiteral(`${word} `)} || dense_rank() OVER (ORDER BY pseudonym(${c})) END`
    }
    case 'mask':
      switch (kind) {
        case 'email':
          return `regexp_replace(${text}, '^(.)[^@]*(@.*)$', '\\1•••\\2')`
        case 'aadhaar':
          return `'XXXX XXXX ' || ${lastDigits(4)}`
        case 'card':
          return `'XXXX XXXX XXXX ' || ${lastDigits(4)}`
        case 'pan':
          return `'XXXXXX' || right(upper(${text}), 4)`
        case 'phone':
          return `'••••••' || ${lastDigits(4)}`
        default:
          return `CASE WHEN length(${text}) <= 2 THEN repeat('•', length(${text})) ELSE left(${text}, 1) || repeat('•', length(${text}) - 2) || right(${text}, 1) END`
      }
    case 'generalize':
      switch (kind) {
        case 'ip':
          return `regexp_replace(${text}, '\\.[0-9]+$', '.0') || '/24'`
        case 'birthdate':
          // Text dates come in any order (15/08/1990, 1990-08-15): take the four-digit year wherever it is.
          return temporal ? `year(${c})` : `nullif(regexp_extract(${text}, '(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)', 1), '')`
        case 'postcode':
          return `left(${text}, 3) || 'XXX'`
        default:
          return `left(${text}, 3) || '…'`
      }
  }
}

export interface Choice {
  column: string
  kind: PiiKind | null
  action: PiiAction
  temporal?: boolean
}

const PLAIN_TABLE = /^SELECT\s+\*\s+FROM\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)$/i

/** The whole anonymizing query: SELECT * EXCLUDE (…) REPLACE (…) FROM source. */
export function anonymizeSql(source: string, choices: Choice[], label: string): string {
  const removed = choices.filter((c) => c.action === 'remove')
  const replaced = choices
    .map((c) => ({ c, expr: actionSql(c.column, c.kind, c.action, c.temporal) }))
    .filter((x): x is { c: Choice; expr: string } => !!x.expr)
  const counts = (['mask', 'pseudonym', 'label', 'generalize', 'remove'] as PiiAction[])
    .map((a) => [a, choices.filter((c) => c.action === a).length] as const)
    .filter(([, n]) => n)
    .map(([a, n]) => `${n} ${a === 'pseudonym' ? 'pseudonymized' : a === 'label' ? 'labelled' : a === 'remove' ? 'removed' : a === 'mask' ? 'masked' : 'generalized'}`)
  const plain = PLAIN_TABLE.exec(source.trim())
  const inner = plain ? plain[1] : `(\n${source}\n)`
  // "Person 1, 2…" labels are numbered with a window function, which would reorder rows: number the
  // rows first and put them back in their original order.
  const keepOrder = choices.some((c) => c.action === 'label')
  const excluded = [...removed.map((c) => sqlName(c.column)), ...(keepOrder ? ['__row'] : [])]
  return [
    commentText(`-- Anonymized copy of ${label}: ${counts.join(', ') || 'no changes'}`),
    `SELECT *${excluded.length ? ` EXCLUDE (${excluded.join(', ')})` : ''}${
      replaced.length ? `\n  REPLACE (\n    ${replaced.map(({ c, expr }) => `${expr} AS ${sqlName(c.column)}`).join(',\n    ')}\n  )` : ''
    }`,
    keepOrder ? `FROM (SELECT *, row_number() OVER () AS __row FROM ${inner})\nORDER BY __row` : `FROM ${inner}`,
  ].join('\n')
}
