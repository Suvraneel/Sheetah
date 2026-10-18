/*
 * What a file really is, from its first bytes: the name can say .csv for a PDF someone renamed, and
 * plenty of systems write ".xls" files that are web pages (an HTML table) or Excel 2003's XML. Each
 * kind that isn't a table gets a message saying what to do instead of DuckDB's parse error.
 */


export type FileKind = 'pdf' | 'image' | 'zip' | 'ole' | 'html' | 'xml-sheet' | 'utf16le' | 'utf16be' | 'text'

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

export function sniff(head: Uint8Array): FileKind {
  if (starts(head, ascii('%PDF-'))) return 'pdf'
  if (
    starts(head, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    starts(head, [0xff, 0xd8, 0xff]) || // JPEG
    starts(head, ascii('GIF8')) ||
    (starts(head, ascii('RIFF')) && starts(head, ascii('WEBP'), 8)) ||
    (starts(head, ascii('ftyp'), 4) && /^(heic|heix|mif1|avif)/.test(String.fromCharCode(...head.slice(8, 12))))
  )
    return 'image'
  if (starts(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
  if (starts(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'
  if (starts(head, [0xff, 0xfe])) return 'utf16le'
  if (starts(head, [0xfe, 0xff])) return 'utf16be'
  // Text: markup (after a byte-order mark and spaces) that holds a table or an Excel 2003 workbook.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head).replace(/^﻿/, '').trimStart()
  if (text.startsWith('<')) {
    if (/urn:schemas-microsoft-com:office:spreadsheet|<(ss:)?Workbook[\s>]/i.test(text)) return 'xml-sheet'
    if (/<(html|table|!doctype html|meta|head|body|style)[\s>]/i.test(text)) return 'html'
  }
  return 'text'
}

/** What a zip holds, by the names of the files in it (its first entry and its directory at the end). */
export type ZipInside = 'xlsx' | 'xlsb' | 'docx' | 'pptx' | 'ods' | null
export function zipInside(bytes: Uint8Array): ZipInside {
  const s = new TextDecoder('latin1').decode(bytes)
  // An Excel binary workbook (.xlsb) has xl/ too, its parts .bin.
  if (/xl\/workbook\.bin|xl\/worksheets\/[^/]*\.bin/.test(s)) return 'xlsb'
  if (/xl\/workbook\.xml|xl\/worksheets\/[^/]*\.xml/.test(s)) return 'xlsx'
  if (/word\/document\.xml/.test(s)) return 'docx'
  if (/ppt\/presentation\.xml/.test(s)) return 'pptx'
  if (/application\/vnd\.oasis\.opendocument\.spreadsheet/.test(s)) return 'ods'
  return null
}

/** Whether bytes read as UTF-8 (a character cut off at the end of the slice doesn't count against them). */
export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

/** Files that aren't tables at all, in plain words; null for the ones worth reading. */
export function notATable(kind: FileKind, name: string, inside: ZipInside = null): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? ''
  switch (kind) {
    case 'pdf':
      return `${name} is a PDF. Sheetah opens tables saved as CSV, Excel, JSON or Parquet: export the table in one of those from wherever the PDF came from.`
    case 'image':
      return `${name} is an image. Sheetah opens tables (CSV, Excel, JSON, Parquet), not pictures of them.`
    case 'zip':
      // What's inside counts for more than the name: a portal's "report.xls" or "export.csv" that is a
      // workbook, a Word file renamed .xlsx. The name decides only when the inside can't be told.
      if (inside === 'xlsx') return null
      if (inside === 'xlsb' || (!inside && ext === 'xlsb')) return `${name} is an Excel binary workbook (.xlsb). Save it as .xlsx or CSV in Excel and open that.`
      if (!inside && (ext === 'xlsx' || ext === 'xlsm')) return null
      if (inside === 'docx' || (!inside && ext === 'docx')) return `${name} is a Word document. Copy its table into a spreadsheet and save that as .xlsx or CSV.`
      if (inside === 'pptx' || (!inside && ext === 'pptx')) return `${name} is a PowerPoint file. Copy its table into a spreadsheet and save that as .xlsx or CSV.`
      if (inside === 'ods' || (!inside && ext === 'ods')) return `${name} is an OpenDocument spreadsheet. Save it as .xlsx or CSV and open that.`
      if (ext === 'numbers') return `${name} is a Numbers spreadsheet. Export it as CSV or Excel and open that.`
      return `${name} is a zip archive. Unzip it and open the CSV or Excel file inside.`
    case 'ole':
      // A password (or a sensitivity label) wraps an .xlsx in this older container.
      if (ext === 'xlsx' || ext === 'xlsm')
        return `${name} is password-protected or encrypted. Open it in Excel, remove the password (File › Info › Protect Workbook), save it, and open it here again.`
      if (ext === 'doc') return `${name} is a Word document. Copy its table into a spreadsheet and save that as .xlsx or CSV.`
      if (ext === 'ppt') return `${name} is a PowerPoint file. Copy its table into a spreadsheet and save that as .xlsx or CSV.`
      if (ext === 'msg') return `${name} is an Outlook message. Save its attachment and open that.`
      return `Old .xls files aren’t supported. Re-save ${name} as .xlsx or CSV and try again.`
    default:
      return null
  }
}

/** A line's fields by a separator, quotes respected ("Acme, Inc" is one). */
function fields(line: string, sep: string): number {
  let n = 1
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === sep && !quoted) n++
  }
  return n
}

/**
 * A report's title lines above its table, written without separators ("Sales by Customer Detail", "Acme
 * Inc", "January 2024"): the file reader takes the first as the only column. The separator and how many
 * lines come before the column names (the first line with as many fields as most of the lines), or null.
 */
export function titleLines(text: string, headerFirst = false): { sep: string; skip: number; fields: number } | null {
  const lines = text.split(/\r?\n/).slice(0, 60).filter((l, i, all) => l.trim() !== '' || i < all.length - 1)
  for (const sep of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => (l.trim() ? fields(l, sep) : 0))
    const tally = new Map<number, number>()
    for (const c of counts) if (c > 1) tally.set(c, (tally.get(c) ?? 0) + 1)
    const [common, times] = [...tally].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0]
    if (common < 2 || times < 2) continue
    // Title lines have no separator at all; the column names are the first line with them, as many as most.
    const skip = counts.findIndex((c) => c > 1)
    if (skip > 0 && counts[skip] === common && counts.slice(0, skip).every((c) => c <= 1)) return { sep, skip, fields: common }
    // (Or, asked for when the file reader gave up on a file whose names are its first line: group names
    // without separators between its rows, a QuickBooks report exported without its titles.)
    if (headerFirst && skip === 0 && counts[0] === common) return { sep, skip: 0, fields: common }
  }
  return null
}
