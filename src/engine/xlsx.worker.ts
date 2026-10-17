/// <reference lib="webworker" />
// Parses .xlsx off the main thread and hands each sheet back as CSV text, which DuckDB then
// reads with type sniffing (numbers, dates, booleans), exactly like a dropped CSV.
import readXlsxFile from 'read-excel-file/web-worker'
import { sheetToCsv } from './sheet-csv'

export interface XlsxSheet {
  name: string
  csv: string
  rows: number
  /** Title lines above the column names that were left out. */
  skipped: number
}
/** plain: the error is already in plain words (not the reader's own message). */
export type XlsxReply = { ok: true; sheets: XlsxSheet[] } | { ok: false; error: string; plain?: boolean }

self.onmessage = async (e: MessageEvent<File>) => {
  try {
    const sheets = await readXlsxFile(e.data)
    const out: XlsxSheet[] = []
    for (const s of sheets) {
      const { csv, rows, skipped } = sheetToCsv(s.data as unknown[][])
      if (csv) out.push({ name: s.sheet, csv, rows, skipped })
    }
    self.postMessage({ ok: true, sheets: out } satisfies XlsxReply)
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies XlsxReply)
  }
}
