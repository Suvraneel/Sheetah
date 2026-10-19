import { LOCALE, isIdLike } from './sql'

/*
 * A small, dependency-free .xlsx writer: one sheet, typed cells, a bold frozen header with filters.
 * Rows are streamed (fetched in windows, compressed as they're written), so a million-row result
 * doesn't need a million-row string in memory.
 *
 * Types: numbers stay numbers (except integers longer than 15 digits, which Excel would round, kept
 * as text), DATE/TIMESTAMP become real Excel dates, everything else is text. Text cells are strings
 * (shared: each distinct one written once, as Excel does), never formulas, so "=HYPERLINK(…)" in the data
 * can't run when the file is opened.
 */

export interface XlsxColumn {
  name: string
  type: string
  /** Fractions that were percentages ("18%"): written as 0.18 with a percent format, so Excel shows 18.00%. */
  percent?: boolean
}

/** Excel's own limit, including the header row. */
export const XLSX_MAX_ROWS = 1_048_575
/** Beyond this many cells the file gets slow to make and to open: CSV or Parquet is the better choice. */
export const XLSX_MAX_CELLS = 25_000_000

type Kind = 'number' | 'bigint' | 'date' | 'datetime' | 'bool' | 'text' | 'month'

const kindOf = (type: string): Kind => {
  const t = type.trim().toUpperCase()
  if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|FLOAT|REAL|DOUBLE)$/.test(t)) return 'number'
  if (/^(BIGINT|HUGEINT|UBIGINT|UHUGEINT)$/.test(t) || /^(DECIMAL|NUMERIC)/.test(t)) return 'bigint'
  if (t === 'DATE') return 'date'
  if (/^TIMESTAMP(_S|_MS|_NS)?$/.test(t)) return 'datetime'
  if (t === 'BOOLEAN') return 'bool'
  return 'text'
}

const esc = (s: string) =>
  s
    // Characters XML 1.0 can't carry at all (control codes other than tab and newlines).
    // eslint-disable-next-line no-control-regex -- matching them is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Excel reads _x0041_ in text as an escaped character ("A"): escape the underscore so it stays literal.
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')

/** "A", "B", … "Z", "AA" … */
export function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

const DAY_MS = 86_400_000
const EPOCH = Date.UTC(1899, 11, 30)

/** "2024-08-15" or "2024-08-15 10:30:00.5" → Excel serial date (days since 1899-12-30), or null. */
export function excelDate(v: string): number | null {
  const m = /^(-?\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?)?$/.exec(v)
  if (!m) return null
  const d = new Date(0)
  // setUTCFullYear, not Date.UTC: Date.UTC reads the years 0–99 as 1900–1999.
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setUTCHours(Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), Math.round(Number(m[7] ?? 0) * 1000))
  const serial = (d.getTime() - EPOCH) / DAY_MS
  // Excel can't show dates before 1900; and it counts a 29 February 1900 that never was, so the days
  // before 1 March 1900 are one lower than plain counting gives.
  if (serial < 2) return null
  return serial < 61 ? serial - 1 : serial
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** A month written as text: a pivot's "2024-04", a report's "Apr 2024". */
const MONTH_LABEL = /^(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})|(\d{4})-(0[1-9]|1[0-2]))$/
/** That month's first day, as an Excel date (null for anything else). */
export function monthSerial(v: string): number | null {
  const m = MONTH_LABEL.exec(v)
  if (!m) return null
  return m[1] ? excelDate(`${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-01`) : excelDate(`${m[3]}-${m[4]}-01`)
}

/** Number styles (cellXfs below): 0 as typed (IDs, years), 4 grouped whole numbers, 5 grouped with two decimals, 6 percent. */
type NumStyle = 0 | 4 | 5 | 6

/**
 * The workbook's shared strings: each distinct text once, cells pointing to it by number (a region named on
 * every row is written once). Past a million distinct ones, the rest are written in their cells.
 */
class Strings {
  private map = new Map<string, number>()
  readonly list: string[] = []
  count = 0
  index(s: string): number {
    let i = this.map.get(s)
    if (i === undefined) {
      if (this.list.length >= 1_000_000) return -1
      i = this.list.length
      this.map.set(s, i)
      this.list.push(s)
    }
    this.count++
    return i
  }
}

function cell(ref: string, kind: Kind, v: string | null | undefined, num: NumStyle = 0, strings?: Strings): string {
  if (v === null || v === undefined) return ''
  const s = num ? ` s="${num}"` : ''
  switch (kind) {
    case 'number':
      // To the 15 significant digits Excel keeps: a sum's 98.44999999999999 is 98.45.
      if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v)) return `<c r="${ref}"${s}><v>${v.replace(/\D/g, '').length > 15 ? String(Number(Number(v).toPrecision(15))) : v}</v></c>`
      break // inf / nan: keep as text
    case 'bigint': {
      // Excel keeps 15 significant digits: longer numbers would silently change, so they stay text.
      const digits = v.replace(/^-/, '').replace('.', '').replace(/^0+/, '')
      if (/^-?\d+(\.\d+)?$/.test(v) && digits.length <= 15) return `<c r="${ref}"${s}><v>${v}</v></c>`
      break
    }
    case 'date':
    case 'datetime': {
      const serial = excelDate(v)
      if (serial !== null) return `<c r="${ref}" s="${kind === 'date' ? 1 : 2}"><v>${serial}</v></c>`
      break
    }
    case 'bool':
      if (v === 'true' || v === 'false') return `<c r="${ref}" t="b"><v>${v === 'true' ? 1 : 0}</v></c>`
      break
    case 'month': {
      const serial = monthSerial(v)
      if (serial !== null) return `<c r="${ref}" s="7"><v>${serial}</v></c>`
      break // "Total", or anything else: text
    }
  }
  const text = v.length > 32_767 ? v.slice(0, 32_767) : v // Excel's per-cell limit
  const shared = strings ? strings.index(text) : -1
  if (shared >= 0) return `<c r="${ref}" t="s"><v>${shared}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
}

/** Sheet names: 31 characters, none of []:*?/\ . */
export const sheetName = (s: string) => (s.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet1').slice(0, 31)

/* ------------------------------------ Zip ------------------------------------ */

interface ZipEntry {
  name: Uint8Array
  crc: number
  size: number
  compressed: Blob
  offset: number
}

const enc = new TextEncoder()

/**
 * Compresses a stream of text chunks (deflate), with the CRC and size of the original bytes. Gzip is
 * deflate with the CRC in its trailer: the browser computes it natively, and the deflate data between its
 * header and trailer is what a zip entry holds.
 */
async function deflate(chunks: AsyncIterable<string>): Promise<{ blob: Blob; crc: number; size: number }> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  const parts: BlobPart[] = []
  const reading = (async () => {
    const reader = cs.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
  })()
  let size = 0
  for await (const text of chunks) {
    const bytes = enc.encode(text)
    size += bytes.length
    await writer.write(bytes)
  }
  await writer.close()
  await reading
  const gz = new Blob(parts)
  // The header: 10 bytes, and the optional fields its flags say follow.
  const head = new Uint8Array(await gz.slice(0, 1024).arrayBuffer())
  let at = 10
  const flags = head[3]
  if (flags & 4) at += 2 + (head[10] | (head[11] << 8))
  if (flags & 8) while (head[at++] !== 0);
  if (flags & 16) while (head[at++] !== 0);
  if (flags & 2) at += 2
  const tail = new DataView(await gz.slice(gz.size - 8).arrayBuffer())
  return { blob: gz.slice(at, gz.size - 8), crc: tail.getUint32(0, true), size }
}

async function* once(text: string) {
  yield text
}

function u16(n: number) {
  return [n & 0xff, (n >>> 8) & 0xff]
}
function u32(n: number) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

function zip(entries: Omit<ZipEntry, 'offset'>[]): Blob {
  const parts: BlobPart[] = []
  const central: number[] = []
  let offset = 0
  // A fixed timestamp (2026-01-01): the bytes depend only on the data.
  const time = 0
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1
  for (const e of entries) {
    const header = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(time), ...u16(date),
      ...u32(e.crc), ...u32(e.compressed.size), ...u32(e.size), ...u16(e.name.length), ...u16(0),
    ])
    parts.push(header, e.name as BlobPart, e.compressed)
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(time), ...u16(date),
      ...u32(e.crc), ...u32(e.compressed.size), ...u32(e.size), ...u16(e.name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...e.name,
    )
    offset += header.length + e.name.length + e.compressed.size
  }
  const dir = new Uint8Array(central)
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(dir.length), ...u32(offset), ...u16(0),
  ])
  if (offset > 0xffffffff || entries.some((e) => e.size > 0xffffffff)) {
    throw new Error('That result is too large for an Excel file. Export it as CSV or Parquet instead.')
  }
  return new Blob([...parts, dir, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

/* ---------------------------------- Workbook ---------------------------------- */

const CONTENT_TYPES = (sheets: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${Array.from({ length: sheets }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
// Sheets are rId1…rIdN; the styles and the shared strings come after them.
const WORKBOOK_RELS = (sheets: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: sheets }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
// Styles: 0 plain, 1 date, 2 date and time, 3 bold header, 4–6 numbers (see NumStyle), 7 a month (Apr 2024).
// A date is Excel's own short date (format 14), shown the way the reader's computer writes dates: 15-04-2024
// in India, 4/15/2024 in the US. A month and a timestamp are written out (no regional format has them).
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="166" formatCode="mmm yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

const workbook = (names: string[]) => {
  // Sheet names must differ (ignoring case) and be at most 31 characters.
  const seen = new Set<string>()
  const unique = names.map((n) => {
    let name = sheetName(n)
    for (let k = 2; seen.has(name.toLowerCase()); k++) name = `${sheetName(n).slice(0, 27)} (${k})`
    seen.add(name.toLowerCase())
    return name
  })
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${unique.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
}

export interface XlsxSource {
  columns: XlsxColumn[]
  rowCount: number
  /** Rows [start, end) as text values (null for empty), in column order. */
  fetch(start: number, end: number): Promise<(string | null | undefined)[][]>
  /** Called as rows are written (for a progress message). */
  onProgress?: (done: number) => void
  /** Checked between windows: return true to stop. */
  cancelled?: () => boolean
}

/** Builds the .xlsx file for a result. */
export function writeXlsx(name: string, src: XlsxSource): Promise<Blob> {
  return writeWorkbook([{ name, src }])
}

/** A workbook of several sheets (a pivot, and the rows behind it), each like writeXlsx's one. */
export async function writeWorkbook(sheets: { name: string; src: XlsxSource }[]): Promise<Blob> {
  const cells = sheets.reduce((n, s) => n + Math.min(s.src.rowCount, XLSX_MAX_ROWS) * Math.max(1, s.src.columns.length), 0)
  if (cells > XLSX_MAX_CELLS) {
    throw new Error(`That's ${cells.toLocaleString(LOCALE)} cells, too many for a workable Excel file. Export it as CSV or Parquet instead, or filter it first.`)
  }
  const strings = new Strings()
  const files: [string, AsyncIterable<string>][] = [
    ['[Content_Types].xml', once(CONTENT_TYPES(sheets.length))],
    ['_rels/.rels', once(ROOT_RELS)],
    ['xl/workbook.xml', once(workbook(sheets.map((s) => s.name)))],
    ['xl/_rels/workbook.xml.rels', once(WORKBOOK_RELS(sheets.length))],
    ['xl/styles.xml', once(STYLES)],
    ...sheets.map((s, i): [string, AsyncIterable<string>] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.src, strings)]),
    // After the sheets: by then every text they hold is in the list.
    ['xl/sharedStrings.xml', sharedXml(strings)],
  ]
  const entries: Omit<ZipEntry, 'offset'>[] = []
  for (const [path, chunks] of files) {
    const { blob, crc, size } = await deflate(chunks)
    entries.push({ name: enc.encode(path), crc, size, compressed: blob })
  }
  return zip(entries)
}

/** The shared strings' XML, written once the sheets have all been. */
async function* sharedXml(strings: Strings): AsyncIterable<string> {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.count}" uniqueCount="${strings.list.length}">`
  for (let i = 0; i < strings.list.length; i += 10_000) {
    let out = ''
    for (const s of strings.list.slice(i, i + 10_000)) out += `<si><t xml:space="preserve">${esc(s)}</t></si>`
    yield out
  }
  yield '</sst>'
}

/** Lets the page draw between parts of a long export (a message, not a timer: a background tab doesn't slow it). */
const pause = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      resolve()
    }
    ch.port2.postMessage(0)
  })

/** One worksheet's XML, streamed a window of rows at a time. */
function sheetXml(src: XlsxSource, strings?: Strings): AsyncIterable<string> {
  const rows = Math.min(src.rowCount, XLSX_MAX_ROWS)
  const kinds = src.columns.map((c) => kindOf(c.type))
  // Amounts show grouped like the grid (1,234,567 and 1,234.50); identifiers and years stay as typed.
  const numStyles: NumStyle[] = src.columns.map((c, i) => {
    if (kinds[i] === 'number' && c.percent) return 6
    if ((kinds[i] !== 'number' && kinds[i] !== 'bigint') || isIdLike(c.name)) return 0
    const t = c.type.trim().toUpperCase()
    return /^(FLOAT|REAL|DOUBLE)$/.test(t) || /^(DECIMAL|NUMERIC)\s*\(\s*\d+\s*,\s*[1-9]/.test(t) ? 5 : 4
  })
  const refs = src.columns.map((_, i) => colName(i))
  const last = refs[refs.length - 1] ?? 'A'

  async function* sheet() {
    // Widths from the header and the first rows, in characters.
    const first = rows ? await src.fetch(0, Math.min(rows, 200)) : []
    // Text that is months ("2024-04" a pivot's rows, a Total line among them; "Apr 2024"): real dates, shown as months.
    for (let i = 0; i < kinds.length; i++) {
      const vals = first.map((r) => r[i]).filter((v): v is string => typeof v === 'string')
      if (kinds[i] === 'text' && vals.some((v) => MONTH_LABEL.test(v)) && vals.every((v) => MONTH_LABEL.test(v) || v === 'Total')) kinds[i] = 'month'
    }
    // A number as Excel will show it (141544.3 as 141,544.30, or 1,41,544.30 on an Indian computer): a
    // column measured by the raw value shows ### instead.
    const shown = (v: string, style: NumStyle) => {
      const n = Number(v)
      if (!style || !Number.isFinite(n)) return v.length
      const digits = Math.trunc(Math.abs(n)).toString().length
      const commas = Math.max(Math.floor((digits - 1) / 3), digits > 3 ? 1 + Math.floor((digits - 4) / 2) : 0)
      return digits + commas + (style === 5 ? 3 : style === 6 ? 4 : 0) + (n < 0 ? 1 : 0)
    }
    const widths = src.columns.map((c, i) => {
      const longest = Math.max(c.name.length + 2, ...first.map((r) => shown(r[i] ?? '', numStyles[i]) + 1))
      return Math.min(60, Math.max(8, kinds[i] === 'datetime' ? 19 : kinds[i] === 'date' ? 11 : longest + 1))
    })
    yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    yield `<dimension ref="A1:${last}${rows + 1}"/>`
    yield `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    if (widths.length) yield `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    yield `<sheetData><row r="1">${src.columns.map((c, i) => `<c r="${refs[i]}1" t="inlineStr" s="3"><is><t xml:space="preserve">${esc(c.name)}</t></is></c>`).join('')}</row>`
    const WINDOW = 5000
    for (let start = 0; start < rows; start += WINDOW) {
      if (src.cancelled?.()) throw new DOMException('Export cancelled', 'AbortError')
      const batch = start === 0 && first.length >= Math.min(rows, WINDOW) ? first : await src.fetch(start, Math.min(rows, start + WINDOW))
      // A thousand rows at a time, the page drawing in between (no long freeze on a million rows).
      for (let from = 0; from < batch.length; from += 1000) {
        let out = ''
        for (let j = from; j < Math.min(batch.length, from + 1000); j++) {
          const r = start + j + 2
          let cells = ''
          const row = batch[j]
          for (let i = 0; i < kinds.length; i++) cells += cell(`${refs[i]}${r}`, kinds[i], row[i], numStyles[i], strings)
          out += `<row r="${r}">${cells}</row>`
        }
        yield out
        await pause()
      }
      src.onProgress?.(Math.min(rows, start + WINDOW))
    }
    yield `</sheetData>`
    if (src.columns.length) yield `<autoFilter ref="A1:${last}${rows + 1}"/>`
    yield `</worksheet>`
  }
  return sheet()
}
