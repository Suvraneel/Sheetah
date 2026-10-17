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

/** Files that aren't tables at all, in plain words; null for the ones worth reading. */
export function notATable(kind: FileKind, name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? ''
  switch (kind) {
    case 'pdf':
      return `${name} is a PDF. Sheetah opens tables saved as CSV, Excel, JSON or Parquet: export the table in one of those from wherever the PDF came from.`
    case 'image':
      return `${name} is an image. Sheetah opens tables (CSV, Excel, JSON, Parquet), not pictures of them.`
    case 'zip':
      if (ext === 'xlsx' || ext === 'xlsm') return null
      if (ext === 'docx') return `${name} is a Word document. Copy its table into a spreadsheet and save that as .xlsx or CSV.`
      if (ext === 'pptx') return `${name} is a PowerPoint file. Copy its table into a spreadsheet and save that as .xlsx or CSV.`
      if (ext === 'ods') return `${name} is an OpenDocument spreadsheet. Save it as .xlsx or CSV and open that.`
      if (ext === 'numbers') return `${name} is a Numbers spreadsheet. Export it as CSV or Excel and open that.`
      if (ext === 'xlsb') return `${name} is an Excel binary workbook (.xlsb). Save it as .xlsx or CSV in Excel and open that.`
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
