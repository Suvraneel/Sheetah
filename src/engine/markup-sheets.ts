/*
 * ".xls" files that are really markup, which banks, ERPs and reporting tools write a lot: a web page
 * holding a <table> (Excel opens those), or Excel 2003's XML Spreadsheet. Each table or worksheet comes
 * back as rows of text, for the same header detection as a real workbook's sheets.
 */

import { FileKindError } from './load-errors'
import { sheetToCsv } from './sheet-csv'

export interface MarkupSheet {
  name: string
  rows: string[][]
}

const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

function htmlTables(doc: Document): MarkupSheet[] {
  // Only tables with no table inside: a layout table's cells can hold the real one.
  const tables = [...doc.querySelectorAll('table')].filter((t) => !t.querySelector('table'))
  const out: MarkupSheet[] = []
  for (const [i, table] of tables.entries()) {
    const rows: string[][] = []
    // A cell spanning rows below (rowspan) or columns (colspan) leaves the cells it covers empty, as Excel does.
    const below: number[] = [] // per column: rows still covered from above
    for (const tr of (table as HTMLTableElement).rows) {
      const row: string[] = []
      let c = 0
      const fill = () => {
        while (below[c] > 0) {
          row[c] = ''
          below[c]--
          c++
        }
      }
      for (const cell of tr.cells) {
        fill()
        row[c] = text(cell)
        const span = Math.max(1, Math.min(100, cell.colSpan || 1))
        const down = Math.max(1, Math.min(1000, cell.rowSpan || 1))
        for (let k = 0; k < span; k++) {
          if (k) row[c + k] = ''
          if (down > 1) below[c + k] = down - 1
        }
        c += span
      }
      // Covered cells after this row's last one count down too.
      for (let j = c; j < below.length; j++)
        if (below[j] > 0) {
          row[j] = ''
          below[j]--
        }
      if (row.some((v) => v)) rows.push(row)
    }
    if (rows.length) out.push({ name: table.getAttribute('summary') || table.querySelector('caption')?.textContent?.trim() || `table ${i + 1}`, rows })
  }
  return out
}

function xmlSheets(doc: Document): MarkupSheet[] {
  const local = (el: Element, name: string) => [...el.children].filter((c) => c.localName === name)
  const attr = (el: Element, name: string) => el.getAttribute(`ss:${name}`) ?? el.getAttributeNS('urn:schemas-microsoft-com:office:spreadsheet', name)
  const out: MarkupSheet[] = []
  for (const ws of doc.getElementsByTagNameNS('*', 'Worksheet')) {
    const table = local(ws, 'Table')[0]
    if (!table) continue
    const rows: string[][] = []
    for (const r of local(table, 'Row')) {
      // ss:Index skips to a later row (empty ones aren't written).
      const at = Number(attr(r, 'Index')) - 1
      while (Number.isFinite(at) && at > rows.length && rows.length < 1_000_000) rows.push([])
      const row: string[] = []
      for (const cell of local(r, 'Cell')) {
        const ci = Number(attr(cell, 'Index')) - 1
        while (Number.isFinite(ci) && ci > row.length && row.length < 16_384) row.push('')
        const data = local(cell, 'Data')[0]
        // Dates come as 2024-04-01T00:00:00.000: the date alone when there's no time.
        row.push(data ? text(data).replace(/^(\d{4}-\d{2}-\d{2})T00:00:00(\.0+)?$/, '$1').replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.0+)?$/, '$1 $2') : '')
        const across = Math.min(100, Number(attr(cell, 'MergeAcross')) || 0)
        for (let k = 0; k < across; k++) row.push('')
      }
      rows.push(row)
    }
    while (rows.length && !rows[rows.length - 1].some((v) => v)) rows.pop()
    if (rows.length) out.push({ name: attr(ws, 'Name') || `sheet ${out.length + 1}`, rows })
  }
  return out
}

export function markupSheets(source: string, kind: 'html' | 'xml-sheet'): MarkupSheet[] {
  const doc = new DOMParser().parseFromString(source, kind === 'html' ? 'text/html' : 'application/xml')
  if (kind === 'xml-sheet' && doc.getElementsByTagName('parsererror').length) throw new FileKindError('That spreadsheet’s XML is damaged and couldn’t be read.')
  return kind === 'html' ? htmlTables(doc) : xmlSheets(doc)
}

/** Each table or worksheet as CSV, with title lines above the column names left out (as for a workbook). */
export function markupToCsv(source: string, kind: 'html' | 'xml-sheet'): { name: string; csv: string; rows: number; skipped: number; text: string[] }[] {
  return markupSheets(source, kind).flatMap((s) => {
    const { csv, rows, skipped, text } = sheetToCsv(s.rows)
    return csv ? [{ name: s.name, csv, rows, skipped, text }] : []
  })
}
