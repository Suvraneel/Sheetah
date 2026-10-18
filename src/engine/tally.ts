/*
 * Tally's own XML, as exported from Tally (Day Book, vouchers) or one of its reports (Trial Balance, a
 * ledger's display): read as a table, so the books open like any other file (loaded only for such a file).
 *
 *   - Vouchers become one row per ledger line: date, voucher type and number, party, narration, ledger,
 *     and the amount as Debit or Credit (Tally writes debits as minus).
 *   - A report is a run of repeating groups (a name, then its amounts): one row per group.
 */
import { FileKindError } from './load-errors'
import type { MarkupSheet } from './markup-sheets'
import { sheetToCsv } from './sheet-csv'

const text = (el: Element | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const child = (el: Element, name: string) => [...el.children].find((c) => c.tagName.toUpperCase() === name)

/** 20240401 → 2024-04-01 (anything else as written). */
const tallyDate = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s)

/** An amount as written ("-25000.00", "25,000.00 Dr"), as a number, or null. */
function amountOf(s: string): number | null {
  const t = s.replace(/[,\s₹]/g, '')
  const m = /^(-?)(\d+(?:\.\d+)?)(Dr|Cr)?$/i.exec(t)
  if (!m) return null
  const n = Number(m[2])
  return (m[1] === '-' || /^dr$/i.test(m[3] ?? '')) && n ? -n : n
}

const ENTRY_LISTS = new Set(['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST'])
const money = (n: number) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2)

/** One row per ledger line of each voucher. */
function voucherRows(vouchers: Element[]): string[][] {
  const rows: string[][] = [['Date', 'Voucher Type', 'Voucher No', 'Party', 'Narration', 'Ledger', 'Debit', 'Credit']]
  for (const v of vouchers) {
    const head = [
      tallyDate(text(child(v, 'DATE'))),
      text(child(v, 'VOUCHERTYPENAME')) || v.getAttribute('VCHTYPE') || '',
      text(child(v, 'VOUCHERNUMBER')),
      text(child(v, 'PARTYLEDGERNAME')),
      text(child(v, 'NARRATION')),
    ]
    const entries = [...v.children].filter((c) => ENTRY_LISTS.has(c.tagName.toUpperCase()))
    if (!entries.length) rows.push([...head, '', '', ''])
    for (const e of entries) {
      const amount = amountOf(text(child(e, 'AMOUNT')))
      rows.push([...head, text(child(e, 'LEDGERNAME')), amount !== null && amount < 0 ? money(amount) : '', amount !== null && amount > 0 ? money(amount) : ''])
    }
  }
  return rows
}

/** Report fields, named as people read them (the rest: the tag without Tally's DSP). */
const FIELDS: Record<string, string> = {
  DSPDISPNAME: 'Name',
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
      rec.set(name, /DATE/i.test(leaf.tagName) ? tallyDate(value) : value)
    }
    return rec
  })
  if (records.length < 2 || !columns.length) return []
  return [columns, ...records.map((r) => columns.map((c) => r.get(c) ?? ''))]
}

/** Tally's XML as sheets of rows: its vouchers, or its report. */
export function tallySheets(source: string): MarkupSheet[] {
  // Tally writes some control characters as references (&#4;), which XML doesn't allow: they're dropped.
  const clean = source.replace(/&#(?:x0*(?:[0-8bcef]|1[0-9a-f])|0*(?:[0-8]|1[124-9]|2[0-9]|3[01]));/gi, '')
  const doc = new DOMParser().parseFromString(clean, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new FileKindError('That Tally XML is damaged and couldn’t be read. From Tally, export the report to Excel or CSV instead.')
  const vouchers = [...doc.getElementsByTagName('VOUCHER')]
  if (vouchers.length) return [{ name: 'vouchers', rows: voucherRows(vouchers) }]
  const report = reportRows(doc.documentElement)
  return report.length ? [{ name: 'report', rows: report }] : []
}

/** The same, as CSV for the file reader (as a workbook's sheets are). */
export function tallyToCsv(source: string): { name: string; csv: string; rows: number; skipped: number }[] {
  return tallySheets(source).flatMap((s) => {
    const { csv, rows, skipped } = sheetToCsv(s.rows)
    return csv ? [{ name: s.name, csv, rows, skipped }] : []
  })
}
