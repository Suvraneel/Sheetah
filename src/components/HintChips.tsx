import type { Clean, DropRows } from '../engine/clean'
import { thenKeepFocus } from './focus'
import { Icon } from './Icon'

interface Props {
  /** The row the column names are on, when the file reader missed them (0-based). */
  namesRow?: number | null
  onNames?: (row: number) => void
  /** Total lines and empty rows to leave out. */
  junk: DropRows[] | null
  /** Total lines still being looked for (a big file): their chip's place, held. */
  checkingTotals?: boolean
  /** A bank statement's money in and out: to add the signed amount. */
  amount?: { credit: string; debit: string } | null
  onAmount?: () => void
  /** Dates the reader read one way (day first, 'dmy') that could be the other: to read the other way. */
  dates?: { columns: string[]; read: 'dmy' | 'mdy' } | null
  onSwapDates?: (columns: string[]) => void
  /** Text typed with stray spaces, to trim. */
  spaces?: string[] | null
  onTrim?: (columns: string[]) => void
  /** Columns with nothing in them, to hide. */
  empty?: string[] | null
  onHideEmpty?: (columns: string[]) => void
  /** Group names written once per group, to fill down. */
  fill?: string[] | null
  onFill?: (columns: string[]) => void
  /** Month (quarter, year) columns to turn into rows. */
  series: { kind: string; columns: string[] } | null
  /** Numbers or dates stored as text, to convert. */
  text: Clean[] | null
  /** Columns that look personal, to anonymize. */
  personal: string[] | null
  compact: boolean
  onDrop: (rows: DropRows[]) => void
  onUnpivot: () => void
  onConvert: (cleans: Clean[]) => void
  onAnonymize: () => void
}

/** "a, b and c" */
const listed = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/**
 * Suggestions from looking the table over, outlined so they never read as applied steps (filled chips),
 * in the order they're best taken: rows that aren't data first, then the layout, then the types.
 */
export function HintChips({ namesRow, onNames, junk, checkingTotals, empty, onHideEmpty, amount, onAmount, dates, onSwapDates, spaces, onTrim, fill, onFill, series, text, personal, compact, onDrop, onUnpivot, onConvert, onAnonymize }: Props) {
  const names = typeof namesRow === 'number'
  if (!names && !junk && !checkingTotals && !empty && !fill && !series && !text && !amount && !dates && !spaces && !personal) return null
  const into = (t: Clean[]) => (t.every((c) => c.kind === 'date') ? 'dates' : t.some((c) => c.kind === 'date') ? 'numbers and dates' : 'numbers')
  return (
    <span className="hint-chips">
      {names && (
        <button className="pii-chip" onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onNames?.(namesRow))} title="Titles above the column names were read as data: the names are on this row.">
          <Icon name="column" size={13} /> Use row {namesRow + 1} as column names
        </button>
      )}
      {!junk && checkingTotals && (
        // Shown only if the look takes a while (a big file), so quick ones don't flash. Not announced: the chip it holds a place for is what matters.
        <span className="pii-chip is-pending" aria-hidden>
          <Icon name="filter" size={13} /> Checking for total lines…
        </span>
      )}
      {junk && (
        <button
          className="pii-chip"
          onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onDrop(junk))}
          title={`Rows that aren’t data: a report’s total lines, a statement’s opening and closing balance, rows with nothing in them. Leaving them out keeps sums and counts right.${junk.some((d) => d.checked && !d.checked.off.length) ? ' Checked: the total lines match the other rows exactly.' : ''}`}
        >
          <Icon name="filter" size={13} /> Leave out {listed(junk.map((d) => d.label))}
        </button>
      )}
      {empty && (
        <button className="pii-chip" onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onHideEmpty?.(empty))} title={`Nothing in any row: ${empty.join(', ')}`}>
          <Icon name="column" size={13} /> Hide {empty.length === 1 ? '1 empty column' : `${empty.length} empty columns`}
        </button>
      )}
      {fill && (
        <button
          className="pii-chip"
          onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onFill?.(fill))}
          title={`${fill.join(', ')}: written once at the top of each group. Filling down puts it on every row, so filters, pivots and charts by it count them all.`}
        >
          <Icon name="fillDown" size={13} /> Fill down {fill.length === 1 ? fill[0] : `${fill.length} columns`}
        </button>
      )}
      {series && (
        <button className="pii-chip" onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onUnpivot())} title={`${series.columns.join(', ')}: one row per ${series.kind} filters, charts and pivots more easily.`}>
          <Icon name="layers" size={13} /> Turn {series.columns.length} {series.kind} columns into rows
        </button>
      )}
      {text && (
        <button
          className="pii-chip"
          onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onConvert(text))}
          title={`Stored as text: ${text.map((c) => c.column).join(', ')}. Converting lets them sum, sort and chart as ${into(text)}.`}
        >
          <Icon name="spark" size={13} /> Convert {compact ? '' : `${text.length} text ${text.length === 1 ? 'column' : 'columns'} `}to {into(text)}
        </button>
      )}
      {amount && (
        <button
          className="pii-chip"
          onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onAmount?.())}
          title={`Money in less money out (${amount.credit} − ${amount.debit}), one number that sums, charts and pivots. A running balance is checked too.`}
        >
          <Icon name="plus" size={13} /> Add signed amount ({amount.credit} − {amount.debit})
        </button>
      )}
      {dates && (
        <button
          className="pii-chip"
          onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onSwapDates?.(dates.columns))}
          title={`${dates.columns.join(', ')}: read ${dates.read === 'dmy' ? 'day first (01/02/2024 is 1 February)' : 'month first (01/02/2024 is January 2nd)'}. No day is past the 12th, so the file can't say which it meant.`}
        >
          <Icon name="calendar" size={13} /> Read {dates.columns.length === 1 ? dates.columns[0] : `${dates.columns.length} date columns`} {dates.read === 'dmy' ? 'month' : 'day'} first
        </button>
      )}
      {spaces && (
        <button
          className="pii-chip"
          onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onTrim?.(spaces))}
          title={`Extra spaces in ${spaces.join(', ')} (“ asha rao ”, “Kabir  Khan”): values that look the same group, filter and look up apart until they're tidied.`}
        >
          <Icon name="spark" size={13} /> Tidy spaces in {spaces.length === 1 ? spaces[0] : `${spaces.length} columns`}
        </button>
      )}
      {personal && (
        <button className="pii-chip" onClick={(e) => thenKeepFocus(e, '.hint-chips', () => onAnonymize())} title={`Looks personal: ${personal.join(', ')}`}>
          <Icon name="shield" size={13} /> Personal data{compact ? '' : ` in ${personal.length} ${personal.length === 1 ? 'column' : 'columns'}`}
        </button>
      )}
    </span>
  )
}
