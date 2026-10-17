/*
 * A sheet's cells (as read-excel-file gives them) → CSV text for DuckDB to read with type sniffing,
 * exactly like a dropped CSV. Pure, so it is unit-tested; the Excel worker runs it.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

export function cellToText(v: unknown): string {
  if (isEmpty(v)) return ''
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

export function sheetToCsv(data: unknown[][]): { csv: string; rows: number; skipped: number } {
  // Drop trailing empty rows and find the real width.
  let end = data.length
  while (end > 0 && data[end - 1].every(isEmpty)) end--
  if (!end) return { csv: '', rows: 0, skipped: 0 }
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
  const header = Array.from({ length: width }, (_, c) => {
    const h = data[top][c]
    return isEmpty(h) ? `column_${c + 1}` : h instanceof Date ? cellToText(h) : String(h)
  })
  const lines = [header.map(cellToText).join(',')]
  for (let r = top + 1; r < end; r++) {
    const row = data[r]
    const cells = new Array<string>(width)
    for (let c = 0; c < width; c++) cells[c] = cellToText(row[c])
    lines.push(cells.join(','))
  }
  // Title lines, not the blank rows between them.
  const skipped = data.slice(0, top).filter((r) => !r.every(isEmpty)).length
  return { csv: lines.join('\n'), rows: end - 1 - top, skipped }
}
