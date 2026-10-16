/// <reference lib="webworker" />
// Parses .xlsx off the main thread and hands each sheet back as CSV text, which DuckDB then
// reads with type sniffing (numbers, dates, booleans), exactly like a dropped CSV.
import readXlsxFile from 'read-excel-file/web-worker'

export interface XlsxSheet {
  name: string
  csv: string
  rows: number
}
export type XlsxReply = { ok: true; sheets: XlsxSheet[] } | { ok: false; error: string }

const pad = (n: number) => String(n).padStart(2, '0')

function cellToText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
    const h = v.getUTCHours()
    const m = v.getUTCMinutes()
    const s = v.getUTCSeconds()
    return h || m || s ? `${date} ${pad(h)}:${pad(m)}:${pad(s)}` : date
  }
  const text = String(v)
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

function sheetToCsv(data: unknown[][]): { csv: string; rows: number } {
  // Drop trailing empty rows and find the real width.
  let end = data.length
  while (end > 0 && data[end - 1].every((c) => c === null || c === '')) end--
  if (!end) return { csv: '', rows: 0 }
  let width = 0
  for (let r = 0; r < end; r++) {
    for (let c = data[r].length - 1; c >= width; c--) {
      if (data[r][c] !== null && data[r][c] !== '') {
        width = c + 1
        break
      }
    }
  }
  const header = Array.from({ length: width }, (_, c) => {
    const h = data[0][c]
    return h === null || h === '' ? `column_${c + 1}` : h instanceof Date ? cellToText(h) : String(h)
  })
  const lines = [header.map(cellToText).join(',')]
  for (let r = 1; r < end; r++) {
    const row = data[r]
    const cells = new Array<string>(width)
    for (let c = 0; c < width; c++) cells[c] = cellToText(row[c])
    lines.push(cells.join(','))
  }
  return { csv: lines.join('\n'), rows: end - 1 }
}

self.onmessage = async (e: MessageEvent<File>) => {
  try {
    const sheets = await readXlsxFile(e.data)
    const out: XlsxSheet[] = []
    for (const s of sheets) {
      const { csv, rows } = sheetToCsv(s.data as unknown[][])
      if (csv) out.push({ name: s.sheet, csv, rows })
    }
    self.postMessage({ ok: true, sheets: out } satisfies XlsxReply)
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies XlsxReply)
  }
}
