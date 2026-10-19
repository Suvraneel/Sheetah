/*
 * A sheet's cells (as read-excel-file gives them) → CSV text for DuckDB to read with type sniffing,
 * exactly like a dropped CSV. Pure, so it is unit-tested; the Excel worker runs it.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

export function cellToText(v: unknown): string {
  if (isEmpty(v)) return ''
  if (v instanceof Date) {
    // To the nearest second: the reader rounds Excel's 45383.041666666664 (1:00) down to 00:59:59.999.
    v = new Date(Math.round(v.getTime() / 1000) * 1000)
  }
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

/**
 * The row the column names are on. Report exports put a company name, a title or a date range above
 * them, one cell each ("ABC Traders", "Sales Register", "1-Apr-2024 to 30-Apr-2024"): those lines are
 * skipped when the row after them looks like column names (text in most columns). Anything else, and
 * the first row is the header, as before.
 */
export function headerRow(data: unknown[][], width: number): number {
  for (let r = 0; r < Math.min(data.length, 15); r++) {
    const cells = data[r].slice(0, width).filter((c) => !isEmpty(c))
    if (!cells.length) continue
    // Column names are text, or what Excel turns month and year headers into: dates, and years as numbers.
    const nameLike = (c: unknown) => typeof c === 'string' || c instanceof Date || (typeof c === 'number' && Number.isInteger(c) && c >= 1900 && c <= 2100)
    const names = cells.every(nameLike) && new Set(cells.map((c) => cellToText(c).trim().toLowerCase())).size === cells.length
    if (r > 0 && names && cells.length >= Math.max(2, Math.ceil(width * 0.5))) return r
    // Only single-cell lines are skipped as titles.
    if (cells.length > 1) return 0
  }
  return 0
}

/**
 * A header in two rows: a group name merged across its columns ("Sales" over Units and Price) and the
 * names under it. Excel keeps a merged cell's value in its first cell, so the group is carried right over
 * the empty ones. Taken as two rows only when the second is all names, most of them with numbers or dates
 * under them, and the first has fewer values, at least one spanning columns (a value, then empty cells over
 * names): the names become "Sales Units", "Sales Price". A first row of data that happens to be text isn't.
 */
export function twoRowHeader(data: unknown[][], top: number, width: number): string[] | null {
  const [first, second, below] = [data[top], data[top + 1], data[top + 2]]
  if (!first || !second || !below) return null
  const cells = (row: unknown[]) => Array.from({ length: width }, (_, c) => row[c])
  const [a, b, d] = [cells(first), cells(second), cells(below)]
  const names = b.filter((v) => !isEmpty(v))
  if (names.length < Math.max(2, Math.ceil(width * 0.5)) || !names.every((v) => typeof v === 'string')) return null
  const valued = (v: unknown) => typeof v === 'number' || v instanceof Date
  if (a.filter((v) => !isEmpty(v)).length >= names.length) return null
  if (!a.some((v, c) => !isEmpty(v) && c + 1 < width && isEmpty(a[c + 1]) && !isEmpty(b[c]) && !isEmpty(b[c + 1]))) return null
  if (b.filter((v, c) => typeof v === 'string' && valued(d[c])).length * 2 < names.length) return null
  // Merged spans start where the first row has a value: carried right while its cells are empty and the
  // second row names the columns under it.
  let group = ''
  const out = a.map((v, c) => {
    if (!isEmpty(v)) group = String(v).trim()
    else if (isEmpty(b[c])) group = ''
    const name = isEmpty(b[c]) ? '' : String(b[c]).trim()
    return group && name ? `${group} ${name}` : group || name
  })
  return new Set(out.map((n) => n.toLowerCase())).size === out.length && out.every(Boolean) ? out : null
}

/**
 * A text cell that read as a number would change: a code longer than a number keeps (an ICCID's 20 digits),
 * one with a zero in front (00123), or a part number shaped like a power of ten (1E5 is not 100,000; a
 * measurement written 1.2E-05 is a number, and stays one).
 */
const CODE_TEXT = /^\s*(\d{16,}|0\d+|\d+E\d+)\s*$/

export function sheetToCsv(data: unknown[][]): { csv: string; rows: number; skipped: number; text: string[] } {
  // Drop trailing empty rows and find the real width.
  let end = data.length
  while (end > 0 && data[end - 1].every(isEmpty)) end--
  if (!end) return { csv: '', rows: 0, skipped: 0, text: [] }
  let width = 0
  for (let r = 0; r < end; r++) {
    for (let c = data[r].length - 1; c >= width; c--) {
      if (!isEmpty(data[r][c])) {
        width = c + 1
        break
      }
    }
  }
  const top = headerRow(data, width)
  const two = twoRowHeader(data, top, width)
  const header =
    two ??
    Array.from({ length: width }, (_, c) => {
      const h = data[top][c]
      return isEmpty(h) ? `column_${c + 1}` : h instanceof Date ? cellToText(h) : String(h)
    })
  const first = top + (two ? 2 : 1)
  const lines = [header.map(cellToText).join(',')]
  for (let r = first; r < end; r++) {
    const row = data[r]
    const cells = new Array<string>(width)
    for (let c = 0; c < width; c++) cells[c] = cellToText(row[c])
    lines.push(cells.join(','))
  }
  // Title lines, not the blank rows between them.
  const skipped = data.slice(0, top).filter((r) => !r.every(isEmpty)).length
  // Columns Excel holds as text, with codes in them a number would change: read as text, as Excel shows them.
  const text = header.filter((_, c) => {
    let code = false
    for (let r = first; r < end; r++) {
      const v = data[r][c]
      if (isEmpty(v)) continue
      if (typeof v !== 'string') return false
      if (!code && CODE_TEXT.test(v)) code = true
    }
    return code
  })
  return { csv: lines.join('\n'), rows: end - first, skipped, text }
}
