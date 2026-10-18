import type { ColumnInfo } from '../engine/result'
import { isIdLike, LOCALE } from '../engine/sql'

/*
 * Display formatting for the grid, decided per column from the first rows that arrive. It only
 * changes what's drawn: copy, export, the status bar and SQL always see the exact values.
 *   - whole numbers get thousands separators (in the reader's locale: 12,34,567 in en-IN), except
 *     columns that look like identifiers or years (order_id, zip, year)
 *   - DECIMAL(p,s) keeps its s decimals; DOUBLE shows two decimals if any value has them (up to
 *     four when a value needs more), none for whole numbers; small fractions (0.0012) stay readable
 *   - timestamps that are all midnight show as dates
 *   - a column converted from "18%" text (ColumnInfo.percent) shows 18%, not 0.18
 */
export type Formatter = (raw: string) => string

/** A type the way a spreadsheet user would say it (the exact database type is in the column menu). */
export function friendlyType(type: string): string {
  const t = type.trim().toUpperCase()
  if (/\[\d*\]$/.test(t)) return 'list'
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR)/.test(t)) return 'text'
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/.test(t)) return 'number'
  if (t === 'DATE') return 'date'
  if (/^TIMESTAMP/.test(t)) return 'date & time'
  if (/^TIME/.test(t)) return 'time'
  if (t === 'BOOLEAN') return 'yes / no'
  if (/^ENUM/.test(t)) return 'category'
  if (/^(STRUCT|MAP|UNION)/.test(t)) return 'record'
  return t.toLowerCase()
}

const INT = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/i
const FLOAT = /^(FLOAT|REAL|DOUBLE)$/i
const DECIMAL = /^(DECIMAL|NUMERIC)\s*\(\s*\d+\s*,\s*(\d+)\s*\)$/i

const locale = LOCALE
const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
const plainFloat = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 })
// At least as many decimals as the data usually shows, but never fewer than a value has (up to 4):
// a column of whole numbers that later holds 2.5 must not show "3".
const fixed = Array.from({ length: 3 }, (_, d) => new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: 4 }))
const decimalSep = (1.5).toLocaleString(locale).replace(/\d/g, '') || '.'
const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 })

const identity: Formatter = (v) => v

/** Groups an integer given as text, exactly (no float rounding for 64-bit values). */
function groupInt(v: string): string {
  if (!/^-?\d+$/.test(v)) return v
  try {
    return grouped.format(BigInt(v))
  } catch {
    return v
  }
}

export function makeFormatter(col: ColumnInfo, sample: (string | null | undefined)[]): Formatter {
  const type = col.type.trim()
  const values = sample.filter((v): v is string => typeof v === 'string' && v !== '')

  const idLike = isIdLike(col.name) // "Order ID", "orderId", "pin_code"
  if (INT.test(type)) return idLike ? identity : groupInt

  const dec = DECIMAL.exec(type)
  if (dec) {
    if (idLike && dec[2] === '0') return identity
    return (v) => {
      const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v)
      if (!m) return v
      return `${m[1]}${groupInt(m[2])}${m[3] ? decimalSep + m[3] : ''}`
    }
  }

  if (FLOAT.test(type)) {
    // Converted from "18%" text: shown the way it was written (the value itself stays 0.18).
    if (col.percent) {
      return (v) => {
        const n = Number(v)
        return v === '' || !Number.isFinite(n) ? v : percent.format(n)
      }
    }
    // Whole numbers stay whole (8820.0 → 8,820); if any value has decimals, the column shows two, like
    // money in a spreadsheet: 1,200.00 and 12,450.50 line up, never 1,200.0 next to 216.00.
    const decimals = values.slice(0, 200).some((v) => /\.\d*[1-9]\d*$/.test(v)) ? 2 : 0
    const f = fixed[decimals]
    return (v) => {
      const n = Number(v)
      if (!Number.isFinite(n) || /e/i.test(v) && Math.abs(n) >= 1e15) return v
      if (n !== 0 && Math.abs(n) < 0.01) return plainFloat.format(n) // keep 0.0012 from becoming 0.00
      return f.format(n)
    }
  }

  if (/^TIMESTAMP$/i.test(type) && values.length && values.every((v) => / 00:00:00(\.0+)?$/.test(v))) {
    return (v) => v.replace(/ 00:00:00(\.0+)?$/, '')
  }

  return identity
}
