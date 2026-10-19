/// <reference lib="webworker" />
// Parses .xlsx off the main thread and hands each sheet back as CSV text, which DuckDB then
// reads with type sniffing (numbers, dates, booleans), exactly like a dropped CSV.
import readXlsxFile from 'read-excel-file/web-worker'
import { Unzip, UnzipInflate } from 'fflate'
import { sheetToCsv } from './sheet-csv'
import { sheetSizes } from './xlsx-zip'

export interface XlsxSheet {
  name: string
  csv: string
  rows: number
  /** Title lines above the column names that were left out. */
  skipped: number
  /** Columns Excel holds as text with codes a number would change (00123, 1E5, 20 digits): read as text. */
  text?: string[]
}
/** Cells the reader leaves empty: Excel's errors (#DIV/0!, #N/A), and formulas saved without their result. */
export interface XlsxBlanks {
  errors: number
  uncached: number
}
/** plain: the error is already in plain words (not the reader's own message). */
export type XlsxReply = { ok: true; sheets: XlsxSheet[]; blanks: XlsxBlanks } | { ok: false; error: string; plain?: boolean }

/**
 * Counts, in the worksheets' XML as it streams out of the zip (never all in memory), the cells the reader
 * empties without a word: errors (t="e") and formulas with no saved value (<f>…</f></c>, a workbook a
 * program wrote without calculating it).
 */
async function blanksIn(file: File): Promise<XlsxBlanks> {
  const found = { errors: 0, uncached: 0 }
  const decoder = new TextDecoder()
  let tail = ''
  const count = (text: string) => {
    found.errors += (text.match(/<c\b[^>]*\bt="e"/g) ?? []).length
    // (Some writers leave an empty value after it: <v></v> or <v/>.)
    found.uncached += (text.match(/<f\b[^>]*(\/>|>[^<]*<\/f>)\s*(<v\s*\/>|<v>\s*<\/v>)?\s*<\/c>/g) ?? []).length
  }
  const unzip = new Unzip((entry) => {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(entry.name)) return
    entry.ondata = (err, chunk, final) => {
      if (err) return
      // A cell can straddle two chunks: the last part of one is read with the next.
      const text = tail + decoder.decode(chunk, { stream: !final })
      const cut = final ? text.length : Math.max(0, text.lastIndexOf('<c'))
      count(text.slice(0, cut))
      tail = text.slice(cut)
      if (final) tail = ''
    }
    entry.start()
  })
  unzip.register(UnzipInflate)
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    unzip.push(value)
  }
  unzip.push(new Uint8Array(0), true)
  return found
}

/** The largest sheet the reader can take in (its text, unpacked), with room to spare under the browser's limit. */
const SHEET_LIMIT = 400 * 1024 ** 2

self.onmessage = async (e: MessageEvent<File>) => {
  try {
    const big = (await sheetSizes(e.data).catch(() => [])).filter((s) => s.size > SHEET_LIMIT)
    if (big.length) {
      const mb = (n: number) => (Number.isFinite(n) ? `${Math.round(n / 1024 ** 2).toLocaleString()} MB` : 'over 4 GB')
      self.postMessage({
        ok: false,
        plain: true,
        error: `${e.data.name} has a sheet with ${mb(big[0].size)} of data inside the workbook, more than this browser can read as one piece. In Excel, save that sheet as CSV (CSV UTF-8) and open the CSV: it reads at any size.`,
      } satisfies XlsxReply)
      return
    }
    const sheets = await readXlsxFile(e.data)
    const out: XlsxSheet[] = []
    for (const s of sheets) {
      const { csv, rows, skipped, text } = sheetToCsv(s.data as unknown[][])
      if (csv) out.push({ name: s.sheet, csv, rows, skipped, text })
    }
    const blanks = await blanksIn(e.data).catch(() => ({ errors: 0, uncached: 0 }))
    self.postMessage({ ok: true, sheets: out, blanks } satisfies XlsxReply)
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies XlsxReply)
  }
}
