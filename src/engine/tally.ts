/*
 * Tally's own XML, as exported from Tally (Day Book, vouchers) or one of its reports (Trial Balance, a
 * ledger's display): read as a table, so the books open like any other file (loaded only for such a file).
 *
 *   - Vouchers become one row per ledger line: date, voucher type and number, party, narration, ledger,
 *     and the amount as Debit or Credit (Tally writes debits as minus). An item invoice's sales ledger sits
 *     inside its stock lines (accounting allocations): read from there. A voucher whose debits and credits
 *     don't agree is said.
 *   - A report is a run of repeating groups (a name, then its amounts): one row per group, debits as
 *     amounts (Tally's minus dropped), with whether the debits and credits agree.
 */
import { FileKindError } from './load-errors'
import type { MarkupSheet } from './markup-sheets'
import { sheetToCsv } from './sheet-csv'
import { LOCALE } from './sql'

const text = (el: Element | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const child = (el: Element, name: string) => [...el.children].find((c) => c.tagName.toUpperCase() === name)

/** 20240401 → 2024-04-01 (anything else as written). */
const tallyDate = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s)

/**
 * An amount as written ("-25000.00", "25,000.00 Dr"), as a number, or null. A foreign-currency amount
 * ("-USD 100.00 @ ₹ 83.00/USD = -₹ 8,300.00") is read as what it comes to in rupees.
 */
function amountOf(s: string): number | null {
  const t = s.slice(s.lastIndexOf('=') + 1).replace(/[,\s₹]/g, '')
  const m = /^(-?)(\d+(?:\.\d+)?)(Dr|Cr)?$/i.exec(t)
  if (!m) return null
  const n = Number(m[2])
  return (m[1] === '-' || /^dr$/i.test(m[3] ?? '')) && n ? -n : n
}

/** What reading the file found, said as a check (passed or not). */
export interface Note {
  ok: boolean
  text: string
}

const ENTRY_LISTS = new Set(['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST'])
const STOCK_LISTS = new Set(['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST'])
const money = (n: number) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2)
const tag = (el: Element) => el.tagName.toUpperCase()
const fmt = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A voucher's ledger lines: its own, and those inside its stock lines (an item invoice's sales ledger). */
const ledgerLines = (v: Element) =>
  [...v.children].flatMap((c) => (ENTRY_LISTS.has(tag(c)) ? [c] : STOCK_LISTS.has(tag(c)) ? [...c.children].filter((a) => tag(a) === 'ACCOUNTINGALLOCATIONS.LIST') : []))

/** One row per ledger line of each voucher; and the vouchers whose debits and credits don't agree. */
function voucherRows(vouchers: Element[]): { rows: string[][]; unbalanced: string[] } {
  const rows: string[][] = [['Date', 'Voucher Type', 'Voucher No', 'Party', 'Narration', 'Ledger', 'Debit', 'Credit']]
  const unbalanced: string[] = []
  for (const v of vouchers) {
    const head = [
      tallyDate(text(child(v, 'DATE'))),
      text(child(v, 'VOUCHERTYPENAME')) || v.getAttribute('VCHTYPE') || '',
      text(child(v, 'VOUCHERNUMBER')),
      text(child(v, 'PARTYLEDGERNAME')),
      text(child(v, 'NARRATION')),
    ]
    const entries = ledgerLines(v)
    if (!entries.length) rows.push([...head, '', '', ''])
    let net = 0
    // An amount that couldn't be read (left empty in its row) leaves the voucher's balance unknown, not off.
    let unread = false
    for (const e of entries) {
      const written = text(child(e, 'AMOUNT'))
      const amount = amountOf(written)
      net += amount ?? 0
      if (amount === null && written) unread = true
      rows.push([...head, text(child(e, 'LEDGERNAME')), amount !== null && amount < 0 ? money(amount) : '', amount !== null && amount > 0 ? money(amount) : ''])
    }
    if (entries.length && !unread && Math.abs(net) >= 0.005) unbalanced.push(`${head[2] || head[0]} (${fmt.format(Math.abs(net))} ${net < 0 ? 'more in debits' : 'more in credits'})`)
  }
  return { rows, unbalanced }
}

/** Report fields, named as people read them (the rest: the tag without Tally's DSP). */
const FIELDS: Record<string, string> = {
  DSPDISPNAME: 'Particulars', // Tally's own word for an account's name in a report
  DSPOPDRAMTA: 'Opening Dr',
  DSPOPCRAMTA: 'Opening Cr',
  DSPDRAMTA: 'Debit',
  DSPCRAMTA: 'Credit',
  DSPCLDRAMTA: 'Closing Dr',
  DSPCLCRAMTA: 'Closing Cr',
  DSPVCHDATE: 'Date',
  DSPVCHTYPE: 'Voucher Type',
  DSPVCHNUMBER: 'Voucher No',
  DSPVCHLEDACCOUNT: 'Account',
  DSPVCHDRAMT: 'Debit',
  DSPVCHCRAMT: 'Credit',
  DSPVCHNARR: 'Narration',
}
const fieldName = (tag: string) => FIELDS[tag] ?? tag.replace(/^DSP/, '').toLowerCase()

/** A report's rows: the root's children in groups, a group starting at each repeat of the first tag. */
function reportRows(root: Element): string[][] {
  // Debit fields hold minus amounts (Tally's sign for a debit): in a Debit column, the amount is what's read.
  const debit = (name: string) => /DRAMTA?$|DRAMT$/.test(name)
  const kids = [...root.children]
  const first = kids[0]?.tagName
  if (!first) return []
  const groups: Element[][] = []
  for (const k of kids) {
    if (k.tagName === first || !groups.length) groups.push([])
    groups[groups.length - 1].push(k)
  }
  const leaves = (el: Element): Element[] => (el.children.length ? [...el.children].flatMap(leaves) : [el])
  const columns: string[] = []
  const records = groups.map((g) => {
    const rec = new Map<string, string>()
    for (const leaf of g.flatMap(leaves)) {
      const name = fieldName(leaf.tagName.toUpperCase())
      if (!columns.includes(name)) columns.push(name)
      const value = text(leaf)
      const n = amountOf(value)
      rec.set(name, /DATE/i.test(leaf.tagName) ? tallyDate(value) : debit(leaf.tagName.toUpperCase()) && n !== null ? money(n) : value)
    }
    return rec
  })
  if (records.length < 2 || !columns.length) return []
  return [columns, ...records.map((r) => columns.map((c) => r.get(c) ?? ''))]
}

/**
 * Whether a report of accounts' balances agrees, debits against credits, in words. A trial balance's must;
 * a group summary's or a ledger's needn't, so they're said only when they do (and a trial balance, known by
 * its file name, is said either way). Null for a report of vouchers (dated lines), or without such a pair.
 */
function tieOut(rows: string[][], trial: boolean): Note | null {
  const [head, ...body] = rows
  if (!head.includes('Particulars') || head.includes('Date')) return null
  for (const [dr, cr] of [['Closing Dr', 'Closing Cr'], ['Debit', 'Credit'], ['Opening Dr', 'Opening Cr']]) {
    const [i, j] = [head.indexOf(dr), head.indexOf(cr)]
    if (i < 0 || j < 0) continue
    const sum = (k: number) => body.reduce((s, r) => s + (amountOf(r[k] ?? '') ?? 0), 0)
    const [d, c] = [sum(i), sum(j)]
    if (Math.abs(d - c) < 0.005) return d ? { ok: true, text: `Debits and credits agree: ${fmt.format(d)} each` } : null
    return trial ? { ok: false, text: `Debits come to ${fmt.format(d)} and credits to ${fmt.format(c)}: ${fmt.format(Math.abs(d - c))} apart` } : null
  }
  return null
}

/** Tally's XML as sheets of rows (its vouchers, or its report), and what reading it found. `name` is the file's. */
export function tallySheets(source: string, name = ''): { sheets: MarkupSheet[]; notes: Note[] } {
  // Tally writes some control characters as references (&#4;), which XML doesn't allow: they're dropped.
  const clean = source.replace(/&#(?:x0*(?:[0-8bcef]|1[0-9a-f])|0*(?:[0-8]|1[124-9]|2[0-9]|3[01]));/gi, '')
  const doc = new DOMParser().parseFromString(clean, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new FileKindError('That Tally XML is damaged and couldn’t be read. From Tally, export the report to Excel or CSV instead.')
  const vouchers = [...doc.getElementsByTagName('VOUCHER')]
  if (vouchers.length) {
    const { rows, unbalanced } = voucherRows(vouchers)
    const notes: Note[] = unbalanced.length
      ? [{ ok: false, text: `${unbalanced.length === 1 ? '1 voucher doesn’t' : `${unbalanced.length} vouchers don’t`} balance: ${unbalanced.slice(0, 3).join(', ')}${unbalanced.length > 3 ? '…' : ''}` }]
      : [{ ok: true, text: `Every voucher balances: debits equal credits (${vouchers.length} vouchers)` }]
    return { sheets: [{ name: 'vouchers', rows }], notes }
  }
  const report = reportRows(doc.documentElement)
  // Tally names a trial balance's export TrialBal.xml; people call theirs "TB", "trial balance"…
  const said = report.length ? tieOut(report, /trial|(^|[^a-z])tb([^a-z]|$)/i.test(name)) : null
  return { sheets: report.length ? [{ name: 'report', rows: report }] : [], notes: said ? [said] : [] }
}

/** The same, as CSV for the file reader (as a workbook's sheets are). */
export function tallyToCsv(source: string, name = ''): { sheets: { name: string; csv: string; rows: number; skipped: number }[]; notes: Note[] } {
  const { sheets, notes } = tallySheets(source, name)
  return {
    sheets: sheets.flatMap((s) => {
      const { csv, rows, skipped } = sheetToCsv(s.rows)
      return csv ? [{ name: s.name, csv, rows, skipped }] : []
    }),
    notes,
  }
}
