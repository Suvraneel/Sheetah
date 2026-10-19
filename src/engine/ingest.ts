import { DuckDBDataProtocol } from '@duckdb/duckdb-wasm'
import { CancelledError, ensureExtension, getEngine, isCancel, quoteIdent, quoteLiteral, sandboxPath, sendAll, withRunLock } from './db'
import { FileKindError } from './load-errors'
import { LOCALE, nameKey, tableNameFor } from './sql'
import { dateOrders, datesGuessed } from './tables'
import type { XlsxReply, XlsxSheet } from './xlsx.worker'

export { FileKindError } from './load-errors'
export { ACCEPTED, dateOrders, listTables, type TableMeta } from './tables'
export { tableNameFor } from './sql'

/** Names already in use, straight from the engine (DuckDB names are case-insensitive). */
async function takenNames(extra: Set<string>): Promise<Set<string>> {
  const { conn } = await getEngine()
  const res = await conn.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`)
  return new Set([...extra, ...res.toArray().map((r) => String(r.toJSON().table_name))])
}

function readerFor(fileName: string): { fn: string; materialize: boolean } {
  const n = fileName.toLowerCase().replace(/\.(gz|gzip|zst)$/, '')
  if (n.endsWith('.parquet')) return { fn: 'read_parquet', materialize: false }
  if (/\.(json|jsonl|ndjson)$/.test(n)) return { fn: 'read_json_auto', materialize: true }
  return { fn: 'read_csv_auto', materialize: true } // csv, tsv, txt: delimiter is sniffed
}


const columnTypes = async (table: string) =>
  (await sendAll(`DESCRIBE ${quoteIdent(table)}`)).toArray().map((r) => {
    const c = r.toJSON() as { column_name: string; column_type: string }
    return { name: String(c.column_name), type: String(c.column_type) }
  })

/**
 * A two-digit-year-first format (%y/%m/%d) turned day-first or month-first, separators kept:
 * "%y/%m/%d %H:%M" → "%d/%m/%y %H:%M". Anything else stays as it is (null).
 */
function yearLast(format: string, order: 'dmy' | 'mdy'): string | null {
  const m = /^%y(\W)%m(\W)%d/.exec(format)
  if (!m) return null
  return (order === 'dmy' ? `%d${m[1]}%m${m[2]}%y` : `%m${m[1]}%d${m[2]}%y`) + format.slice(m[0].length)
}

/**
 * Which way round the reader took dates like 01/02/2024 (it can't know, up to the 12th): kept for the
 * date hint. Its pick for 01/04/24 is two-digit year first, 24 April 2001 (and 01/04/24 10:30, with no
 * seconds, isn't seen as a time at all: the year 1). Statements write the day first. When day-first or
 * month-first (the reader's own habit tried first) reads the same columns as dates, keeps their years as
 * close together, and puts them nearer today, the file is read again that way. A file that really is
 * year first (24/01/31, 24/02/29…) stays as it was read: read the other way, its dates are years away.
 */
async function readDates(name: string, path: string, read: (opts: string) => string): Promise<void> {
  const dated = (await columnTypes(name)).filter((c) => c.type === 'DATE' || c.type.startsWith('TIMESTAMP'))
  if (!dated.length) return
  const f = await sendAll(`SELECT DateFormat AS d, TimestampFormat AS t FROM sniff_csv(${quoteLiteral(path)})`)
    .then((t) => t.toArray()[0]?.toJSON() as { d?: string; t?: string } | undefined)
    .catch((e) => (isCancel(e) ? Promise.reject(e) : undefined))
  let date = String(f?.d ?? '')
  let time = String(f?.t ?? '')
  const one = (sql: string) => sendAll(sql).then((t) => (t.toArray()[0]?.toJSON() ?? {}) as Record<string, unknown>)
  // No format from the sniffer (a file whose rows have more or fewer fields than its header, read again with
  // its separator): how the dates are written, from the text itself, as the reader would have said it.
  const plain = dated.filter((c) => c.type === 'DATE')
  if (!date && plain.length) {
    const c = quoteIdent(plain[0].name)
    const raw = String((await one(`SELECT ${c} AS v FROM ${read('all_varchar = true')} WHERE ${c} IS NOT NULL AND trim(${c}) <> '' LIMIT 1`).catch(() => ({}) as Record<string, unknown>)).v ?? '')
    const m = /^\d{1,2}([/.-])\d{1,2}\1\d{2}$/.exec(raw.trim())
    const full = /^\d{1,2}([/.-])\d{1,2}\1\d{4}$/.exec(raw.trim())
    if (m) date = `%y${m[1]}%m${m[1]}%d`
    else if (full) {
      // 10/02/2026: which way round the reader took it, from the dates it made of values whose day and
      // month differ (each read both ways: the way it read them is the one in the table).
      const [dmy, mdy] = [`%d${full[1]}%m${full[1]}%Y`, `%m${full[1]}%d${full[1]}%Y`]
      const r = await one(
        `WITH raw AS (SELECT DISTINCT trim(${c}) AS v FROM ${read('all_varchar = true')} WHERE regexp_full_match(trim(${c}), '[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{4}') AND regexp_extract(trim(${c}), '^[0-9]+') <> regexp_extract(trim(${c}), '^[0-9]+[/.-]([0-9]+)', 1) LIMIT 200),
        typed AS (SELECT DISTINCT ${c} AS d FROM ${quoteIdent(name)})
        SELECT count(*) FILTER (WHERE try_strptime(v, ${quoteLiteral(dmy)})::DATE IN (SELECT d FROM typed))::DOUBLE AS dmy,
          count(*) FILTER (WHERE try_strptime(v, ${quoteLiteral(mdy)})::DATE IN (SELECT d FROM typed))::DOUBLE AS mdy FROM raw`,
      ).catch(() => ({}) as Record<string, unknown>)
      const [d, mo] = [Number(r.dmy ?? 0), Number(r.mdy ?? 0)]
      if (d !== mo) date = d > mo ? dmy : mdy
    }
  }
  let order: 'dmy' | 'mdy' | undefined = /^%d\W%m/.test(date) ? 'dmy' : /^%m\W%d/.test(date) ? 'mdy' : undefined
  // Times read as the year 1 (no seconds, so no format found): how they're written, from the text itself.
  const times = dated.filter((c) => c.type.startsWith('TIMESTAMP'))
  if (times.length && !yearLast(time, 'dmy')) {
    const low = await one(`SELECT least(${times.map((c) => `min(year(${quoteIdent(c.name)}))`).join(', ')})::DOUBLE AS y FROM ${quoteIdent(name)}`)
    if (Number(low.y ?? 1e9) < 100) {
      const c = quoteIdent(times[0].name)
      const raw = String((await one(`SELECT ${c} AS v FROM ${read('all_varchar = true')} WHERE ${c} IS NOT NULL LIMIT 1`)).v ?? '')
      const m = /^\d{1,2}([/.-])\d{1,2}\1\d{2}\s+\d{1,2}:\d{2}(:\d{2})?$/.exec(raw.trim())
      if (m) time = `%y${m[1]}%m${m[1]}%d %H:%M${m[2] ? ':%S' : ''}` // as the reader would have said it; turned below
    }
  }
  if (yearLast(date, 'dmy') || yearLast(time, 'dmy')) {
    // How the dates sit: how many different years, and how far from today on average.
    const today = new Date().toISOString().slice(0, 10)
    const shape = async (table: string) => {
      const r = await one(
        `SELECT ${dated.map((c, i) => `count(DISTINCT year(${quoteIdent(c.name)}))::DOUBLE AS y${i}, sum(abs(date_diff('day', ${quoteIdent(c.name)}::DATE, DATE '${today}')))::DOUBLE AS d${i}, count(${quoteIdent(c.name)})::DOUBLE AS n${i}`).join(', ')} FROM ${quoteIdent(table)}`,
      )
      const sum = (k: string) => dated.reduce((s, _, i) => s + Number(r[`${k}${i}`] ?? 0), 0)
      return { years: sum('y'), away: sum('d') / Math.max(1, sum('n')) }
    }
    const now = await shape(name)
    const tmp = `__dates_${name}`
    for (const o of /^en-US$/i.test(LOCALE) ? (['mdy', 'dmy'] as const) : (['dmy', 'mdy'] as const)) {
      const d = yearLast(date, o)
      const t = yearLast(time, o)
      const opts = [d && `dateformat = ${quoteLiteral(d)}`, t && `timestampformat = ${quoteLiteral(t)}`].filter(Boolean).join(', ')
      try {
        await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(tmp)} AS SELECT * FROM ${read(opts)}`)
        const types = new Map((await columnTypes(tmp)).map((c) => [c.name, c.type]))
        const then = dated.every((c) => types.get(c.name) === c.type) ? await shape(tmp) : null
        if (then && then.years <= now.years && then.away < now.away) {
          // Swapped in one transaction (no second copy of the rows): a cancel part-way leaves the first reading.
          await sendAll('BEGIN TRANSACTION')
          try {
            await sendAll(`DROP TABLE ${quoteIdent(name)}`)
            await sendAll(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(name)}`)
            await sendAll('COMMIT')
          } catch (e) {
            await sendAll('ROLLBACK').catch(() => {})
            throw e
          }
          order = o
          break
        }
      } catch (e) {
        if (isCancel(e)) throw e
      } finally {
        await sendAll(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`).catch(() => {})
      }
    }
  }
  // Dates that read both ways (no day past the 12th: 01/02/2024): the reader's own way, not the file
  // reader's guess. Read the other way, every value must still be a date, or the guess stands.
  const habit: 'dmy' | 'mdy' = /^en-US$/i.test(LOCALE) ? 'mdy' : 'dmy'
  if (order && order !== habit && /^%[dm]\W%[dm]\W%Y/.test(date) && !yearLast(date, 'dmy')) {
    const turn = (f: string) => f.replace(/^%(d|m)(\W)%(d|m)/, (_, a: string, s: string, b: string) => `%${b}${s}%${a}`)
    const tmp = `__order_${name}`
    const opts = [`dateformat = ${quoteLiteral(turn(date))}`, ...(/^%[dm]\W%[dm]/.test(time) ? [`timestampformat = ${quoteLiteral(turn(time))}`] : [])].join(', ')
    try {
      await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(tmp)} AS SELECT * FROM ${read(opts)}`)
      const types = new Map((await columnTypes(tmp)).map((c) => [c.name, c.type]))
      if (dated.every((c) => types.get(c.name) === c.type)) {
        await sendAll('BEGIN TRANSACTION')
        try {
          await sendAll(`DROP TABLE ${quoteIdent(name)}`)
          await sendAll(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(name)}`)
          await sendAll('COMMIT')
          order = habit
          datesGuessed.add(name.toLowerCase())
        } catch (e) {
          await sendAll('ROLLBACK').catch(() => {})
          throw e
        }
      }
    } catch (e) {
      if (isCancel(e)) throw e
    } finally {
      await sendAll(`DROP TABLE IF EXISTS ${quoteIdent(tmp)}`).catch(() => {})
    }
  }
  if (order) dateOrders.set(name.toLowerCase(), order)
}

/** What the engine says when it runs out of room. */
const OUT_OF_MEMORY = /out of memory|Allocation failure|failed to allocate/i
const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2).toLocaleString(LOCALE)} MB`

/** Room left in the engine's memory (its limit less what it holds now), or null if it can't say. */
async function memoryLeft(): Promise<number | null> {
  try {
    const r = (await sendAll(`SELECT current_setting('memory_limit') AS l, (SELECT sum(memory_usage_bytes) FROM duckdb_memory())::DOUBLE AS u`)).toArray()[0]?.toJSON() as { l: string; u: number }
    const m = /([\d.]+)\s*([KMGT])(i?)B/i.exec(String(r.l))
    if (!m) return null
    const limit = Number(m[1]) * (m[3] ? 1024 : 1000) ** ('KMGT'.indexOf(m[2].toUpperCase()) + 1)
    return limit - Number(r.u ?? 0)
  } catch {
    return null
  }
}

/** Codes by their names: ZIP and FIPS codes, area codes, IDs (Zipcode and Pincode written as one word too). */
const CODE_COLUMN = /(^|_)(fips|geoid|geo_id|zcta|ags|ars|nuts\d?|lsoa\w*|msoa\w*|lad\w*|area_code|ons_code|code|zip|zipcode|pin|pincode|postcode|postalcode|postal)(_|$)/

/**
 * The file reader types a column from its first 20,000 or so rows: codes that start with 0 only further
 * down (a ZIP code file sorted the other way, FIPS 01001 after 56001) were read as numbers, their zeros
 * gone. A column named for a code that holds one is read again as text, said so: added to `textColumns`,
 * which every reader of the file reads as text from then on.
 */
async function keepZeros(name: string, read: (opts: string) => string, textColumns: string[], fileName: string, onNote?: Noted): Promise<void> {
  const named = (await columnTypes(name)).filter((c) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)$/.test(c.type) && CODE_COLUMN.test(nameKey(c.name)))
  if (!named.length) return
  // A file the reader looked over whole (its sample is 20,480 rows) has its codes typed right already; and
  // codes that lost a zero are shorter than the rest (1001 among 56001): only then is the file read again.
  const r0 = (await sendAll(`SELECT count(*)::DOUBLE AS n, ${named.map((c, i) => `(min(length(${quoteIdent(c.name)}::VARCHAR)) <> max(length(${quoteIdent(c.name)}::VARCHAR)))::INTEGER AS v${i}`).join(', ')} FROM ${quoteIdent(name)}`)).toArray()[0]?.toJSON() as Record<string, number>
  if (Number(r0?.n ?? 0) <= 20_000) return
  const ints = named.filter((_, i) => Number(r0[`v${i}`]) === 1)
  if (!ints.length) return
  const r = (await sendAll(`SELECT ${ints.map((c, i) => `bool_or(regexp_matches(${quoteIdent(c.name)}, '^\\s*0[0-9]'))::INTEGER AS z${i}`).join(', ')} FROM ${read('all_varchar = true')}`)).toArray()[0]?.toJSON() as
    | Record<string, number | null>
    | undefined
  const lead = ints.filter((_, i) => Number(r?.[`z${i}`]) === 1)
  if (!lead.length) return
  textColumns.push(...lead.map((c) => c.name))
  await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`)
  const list = lead.map((c) => c.name).join(', ')
  onNote?.(`${list} in ${fileName} ${lead.length === 1 ? 'is a code' : 'are codes'} with zeros in front further down the file (01001): read as text, so they stay.`)
}

/**
 * Numbers the file reader typed that the file doesn't mean as numbers: a code longer than a number keeps
 * (an ICCID's 20 digits read as 8.99e19), and, in a file that writes decimals with a comma (its prices are
 * 2,50), whole numbers grouped with points (1.500 is fifteen hundred there, not one and a half). Read as text
 * and said: the code stays as written; the amount converts the comma way, from the suggestion or its menu.
 * Cheap unless the signs are there: the typed table is looked at first (a number of 16 digits and more that
 * a double can't hold; thousandths only), the prices' commas on a sample, and the file is read again only
 * then.
 */
async function keepAsWritten(name: string, read: (opts: string) => string, textColumns: string[], fileName: string, onNote?: Noted): Promise<void> {
  const types = await columnTypes(name)
  // Only doubles lose digits: BIGINT and HUGEINT keep every one (and show it).
  const doubles = types.filter((c) => /^(DOUBLE|FLOAT|REAL)$/.test(c.type))
  if (!doubles.length) return
  const q = (c: { name: string }) => quoteIdent(c.name)
  const one = async (sql: string) => ((await sendAll(sql)).toArray()[0]?.toJSON() ?? {}) as Record<string, unknown>
  const t = await one(
    `SELECT ${doubles
      .map((c, i) => `max(abs(${q(c)}))::DOUBLE AS m${i}, (bool_and(${q(c)} IS NULL OR abs(${q(c)} * 1000 - round(${q(c)} * 1000)) < 1e-6) AND bool_or(${q(c)} <> round(${q(c)})))::INTEGER AS k${i}`)
      .join(', ')} FROM ${quoteIdent(name)}`,
  )
  const longs = doubles.filter((_, i) => Number(t[`m${i}`]) >= 2 ** 53)
  let thousandths = doubles.filter((_, i) => Number(t[`k${i}`]) === 1)
  if (thousandths.length) {
    // Evidence from the file itself, never the browser's language: a column of prices written 2,50 (maybe
    // with ₹ or €, and thousands points), looked at on a sample.
    const texts = types.filter((c) => c.type === 'VARCHAR').slice(0, 40)
    const COMMA = `'[(+-]?[^0-9,.]{0,4}[0-9]{1,3}(\\.?[0-9]{3})*,[0-9]{1,2}[^0-9,.]{0,4}\\)?'`
    const c = texts.length
      ? await one(
          `SELECT ${texts.map((x, i) => `count(*) FILTER (WHERE regexp_full_match(trim(${q(x)}), ${COMMA}))::DOUBLE AS c${i}, count(nullif(trim(${q(x)}), ''))::DOUBLE AS v${i}`).join(', ')} FROM (SELECT * FROM ${quoteIdent(name)} USING SAMPLE 5000 ROWS)`,
        )
      : {}
    const commaFile = texts.some((_, i) => Number(c[`c${i}`]) > 0 && Number(c[`c${i}`]) >= 0.9 * Number(c[`v${i}`]))
    if (!commaFile) thousandths = []
  }
  if (!longs.length && !thousandths.length) return
  // How they're written in the file itself.
  const cand = [...new Set([...longs, ...thousandths])]
  const raw = await one(
    `SELECT ${cand
      .map((c, i) => {
        const v = `trim(${q(c)})`
        return [
          // Codes: every value whole digits, one of them longer than a double keeps.
          `bool_and(${v} = '' OR regexp_full_match(${v}, '[0-9]+'))::INTEGER AS w${i}`,
          `count(*) FILTER (WHERE regexp_full_match(${v}, '[0-9]{16,}'))::DOUBLE AS l${i}`,
          // Thousands: grouped by points (1.500), and no other decimals (1.5, 0.75).
          `count(*) FILTER (WHERE regexp_full_match(${v}, '[+-]?[0-9]{1,3}(\\.[0-9]{3})+'))::DOUBLE AS g${i}`,
          `count(*) FILTER (WHERE regexp_full_match(${v}, '[+-]?[0-9]*\\.[0-9]+') AND NOT regexp_full_match(${v}, '[+-]?[0-9]{1,3}(\\.[0-9]{3})+'))::DOUBLE AS d${i}`,
        ].join(', ')
      })
      .join(', ')} FROM ${read('all_varchar = true')}`,
  )
  const codes = cand.filter((c, i) => longs.includes(c) && Number(raw[`w${i}`]) === 1 && Number(raw[`l${i}`]) > 0)
  const grouped = cand.filter((c, i) => thousandths.includes(c) && !codes.includes(c) && Number(raw[`g${i}`]) > 0 && Number(raw[`d${i}`]) === 0)
  if (!codes.length && !grouped.length) return
  textColumns.push(...[...codes, ...grouped].map((c) => c.name))
  await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`)
  const list = (cs: { name: string }[]) => cs.map((c) => c.name).join(', ')
  if (codes.length)
    onNote?.(`${list(codes)} in ${fileName} ${codes.length === 1 ? 'holds codes' : 'hold codes'} longer than a number keeps (16 digits and more): read as text, every digit as written.`)
  if (grouped.length)
    onNote?.(
      `${list(grouped)} in ${fileName} ${grouped.length === 1 ? 'writes' : 'write'} thousands with a point (1.500 is fifteen hundred), as the file writes decimals with a comma: read as text, to convert the comma way.`,
    )
}

/**
 * Two-digit years read as spreadsheets read them (and Sheetah's own date_from_text): 30–99 are 1930–1999,
 * 00–29 are 2000–2029. The file reader puts 55 in 2055: a date of birth in the future. Only dates written
 * with two digits for the year are moved (a loan's maturity written 2035 stays; one four-digit year found
 * ends the look).
 */
async function twoDigitYears(name: string, read: (opts: string) => string, fileName: string, onNote?: Noted): Promise<void> {
  const dated = (await columnTypes(name)).filter((c) => c.type === 'DATE' || c.type === 'TIMESTAMP')
  if (!dated.length) return
  const q = (c: { name: string }) => quoteIdent(c.name)
  const one = async (sql: string) => ((await sendAll(sql)).toArray()[0]?.toJSON() ?? {}) as Record<string, unknown>
  const late = await one(`SELECT ${dated.map((c, i) => `count(*) FILTER (WHERE year(${q(c)}) BETWEEN 2030 AND 2068)::DOUBLE AS f${i}`).join(', ')} FROM ${quoteIdent(name)}`)
  const ahead = dated.filter((_, i) => Number(late[`f${i}`]) > 0)
  const short: typeof ahead = []
  for (const c of ahead) {
    // A value with a four-digit year anywhere: not this. (Stops at the first one.)
    const four = await sendAll(`SELECT 1 FROM ${read('all_varchar = true')} WHERE regexp_matches(trim(${q(c)}), '(^|[^0-9])[0-9]{4}([^0-9]|$)') LIMIT 1`)
    if (!four.numRows) short.push(c)
  }
  if (!short.length) return
  for (const c of short) await sendAll(`UPDATE ${quoteIdent(name)} SET ${q(c)} = ${q(c)} - INTERVAL 100 YEAR WHERE year(${q(c)}) BETWEEN 2030 AND 2068`)
  onNote?.(`Two-digit years in ${short.map((c) => c.name).join(', ')} (${fileName}) are read as spreadsheets read them: 55 is 1955, 24 is 2024.`)
}

/**
 * Registers the File with DuckDB (it reads straight from disk, nothing is uploaded) and
 * creates a table. CSV/JSON are materialised so scrolling and sorting stay fast;
 * Parquet stays a view because it's already columnar and compressed.
 * Loads run one at a time on the cancellable connection, so the Cancel button stops them.
 */
export async function ingestFile(file: File, taken: Set<string> = new Set(), onNote?: Noted): Promise<string[]> {
  if (!file.size) throw new FileKindError(`${file.name} is empty.`)
  const { sniff, notATable, zipInside, isUtf8 } = await import('./sniff')
  const kind = sniff(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))
  // A zip: what it holds, by the names in it (its first entry, and its directory at the end).
  const inside = kind === 'zip' ? zipInside(new Uint8Array(await new Blob([file.slice(0, 4096), file.slice(Math.max(4096, file.size - 65536))]).arrayBuffer())) : null
  const wrong = notATable(kind, file.name, inside)
  if (wrong) throw new FileKindError(wrong)
  // A workbook named .csv or .xls (some portals' downloads): opened as the workbook it is.
  if (inside === 'xlsx' && !/\.xls[xm]$/i.test(file.name)) {
    onNote?.(`${file.name} is an Excel workbook, whatever its name says: opened as one.`)
    return ingestExcel(file, taken, onNote)
  }
  // Tally's own XML (its vouchers, or a report, in an ENVELOPE), in UTF-8: its <BODY> isn't a web page's.
  if ((kind === 'html' || kind === 'text') && /^\s*</.test((await file.slice(0, 1024).text()).replace(/^\uFEFF/, '')) && TALLY.test(await file.slice(0, 8192).text()))
    return ingestTally(file, await textOf(file), taken, onNote)
  if (kind === 'html' || kind === 'xml-sheet') return ingestMarkup(file, kind, taken, onNote)
  if (kind === 'text' && /\.html?$/i.test(file.name)) return ingestMarkup(file, 'html', taken, onNote)
  if (kind === 'text' && /\.xml$/i.test(file.name)) {
    throw new FileKindError(`${file.name} is XML, but not a spreadsheet. Sheetah opens XML saved by Excel (XML Spreadsheet 2003) or Tally; for other XML, export a CSV.`)
  }
  if (/\.xls$/i.test(file.name)) {
    // Some systems save tab-separated text as .xls (Excel opens it): read it as the text it is.
    const head = await file.slice(0, 4096).text()
    if (!/[\t,;|].*\n/.test(head)) throw new FileKindError(`Old .xls files aren’t supported. Re-save ${file.name} as .xlsx or CSV and try again.`)
    return ingestRead(file, taken, onNote)
  }
  if (/\.xls[xm]$/i.test(file.name)) return ingestExcel(file, taken, onNote)
  // Excel's "Unicode Text" (UTF-16, tab-separated): DuckDB reads UTF-8, so it's turned into that first.
  if (kind === 'utf16le' || kind === 'utf16be') {
    if (file.size > 512 * 1024 ** 2) throw new FileKindError(`${file.name} is UTF-16 text over 512 MB. Save it as CSV UTF-8 and open that.`)
    const text = new TextDecoder(kind === 'utf16le' ? 'utf-16le' : 'utf-16be').decode(await file.arrayBuffer())
    // Tally writes its XML in UTF-16 by default; Excel's XML Spreadsheet can be too.
    if (/^\s*</.test(text) && /\.xml$/i.test(file.name)) {
      if (TALLY.test(text.slice(0, 8192))) return ingestTally(file, text, taken, onNote)
      if (/<Workbook\b/.test(text.slice(0, 8192))) return ingestMarkup(file, 'xml-sheet', taken, onNote, text)
    }
    return ingestRead(new File([text], file.name, { type: 'text/plain' }), taken, onNote)
  }
  // Excel's "CSV (Comma delimited)" on Windows, and most older systems, write Windows-1252, not UTF-8: £, é
  // and ü are single bytes DuckDB refuses. Read as that (said so), from the start or when the reader trips.
  const text = kind === 'text' && readerFor(file.name).fn === 'read_csv_auto' && !/\.(gz|gzip|zst)$/i.test(file.name)
  if (text && !isUtf8(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()))) return ingestRead(await western(file, onNote), taken, onNote)
  try {
    return await ingestRead(file, taken, onNote)
  } catch (e) {
    if (!text || isCancel(e) || !/utf-?8|unicode/i.test(e instanceof Error ? e.message : String(e))) throw e
    return ingestRead(await western(file, onNote), taken, onNote)
  }
}

/** A file in Windows-1252 (Western European) as UTF-8, saying so. */
async function western(file: File, onNote?: Noted): Promise<File> {
  if (file.size > 512 * 1024 ** 2) throw new FileKindError(`${file.name} isn’t UTF-8 and is over 512 MB. Save it as “CSV UTF-8” and open that.`)
  const text = new TextDecoder('windows-1252').decode(await file.arrayBuffer())
  onNote?.(`${file.name} isn’t UTF-8: read as Windows-1252 (Western European: £, é, ü). If letters look wrong, save it as “CSV UTF-8” and open that.`)
  return new File([text], file.name, { type: 'text/plain' })
}


function ingestRead(file: File, taken: Set<string>, onNote?: Noted): Promise<string[]> {
  return withRunLock(async () => {
    const { db } = await getEngine()
    const name = tableNameFor(file.name, await takenNames(taken))
    dateOrders.delete(name.toLowerCase()) // a name used before (that table since dropped): read afresh
    datesGuessed.delete(name.toLowerCase())
    const { fn, materialize } = readerFor(file.name)
    if (fn === 'read_parquet') await ensureExtension('parquet')
    if (fn === 'read_json_auto') await ensureExtension('json')
    const virtualPath = sandboxPath(`${name}__${file.name}`)
    await db.registerFileHandle(virtualPath, file, DuckDBDataProtocol.BROWSER_FILEREADER, true)
    const source = `${fn}(${quoteLiteral(virtualPath)})`
    // A report's title lines above its table, with no separators (QuickBooks' "Sales by Customer Detail"),
    // its group names too: the file reader gives up, or reads it all as one column. Read from the names on.
    let titled: { sep: string; skip: number; fields: number } | null | undefined
    let ragged: { sep: string; skip: number; fields: number } | null = null
    const titles = async () => (titled === undefined ? (titled = (await import('./sniff')).titleLines(await file.slice(0, 64 * 1024).text())) : titled)
    // Columns typed from the first rows the reader looked at that hold something else further down (a
    // statistics office's "x" for a suppressed figure on line 350,003; a code with zeros in front): read
    // as text, nothing lost. Every way of reading the file reads them so.
    const asText: { column: string; line: string; value: string }[] = []
    const textColumns: string[] = []
    // First, the whole file looked at to type its columns (not just its first rows); only if that still
    // trips, the columns named one by one.
    let wholeFile: { line: string; value: string } | null = null
    const typesOpt = () => [wholeFile ? 'sample_size = -1' : '', textColumns.length ? `types = {${textColumns.map((c) => `${quoteLiteral(c)}: 'VARCHAR'`).join(', ')}}` : ''].filter(Boolean).join(', ')
    const withTypes = (opts: string) => [typesOpt(), opts].filter(Boolean).join(', ')
    const fromNames = (t: { sep: string; skip: number }, opts = '') =>
      `read_csv(${quoteLiteral(virtualPath)}, delim = ${quoteLiteral(t.sep)}, header = true, skip = ${t.skip}, null_padding = true, strict_mode = false${withTypes(opts) ? `, ${withTypes(opts)}` : ''})`
    // A big file into a tab whose engine is nearly full would come out empty (or not at all): said first.
    if (materialize && !/\.(gz|gzip|zst)$/i.test(file.name)) {
      const left = await memoryLeft()
      if (left !== null && file.size > 100 * 1024 ** 2 && file.size * 1.3 > left) {
        await db.dropFile(virtualPath).catch(() => {})
        throw new FileKindError(
          `${file.name} is ${mb(file.size)}, and this tab has room for about ${mb(Math.max(0, left))} more. Remove tables you don’t need (the × beside each), or reload the page, then open it again.`,
        )
      }
    }
    try {
      for (;;) {
        const from = fn === 'read_csv_auto' && typesOpt() ? `read_csv_auto(${quoteLiteral(virtualPath)}, ${typesOpt()})` : source
        try {
          await sendAll(materialize ? `CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM ${from}` : `CREATE VIEW ${quoteIdent(name)} AS SELECT * FROM ${from}`)
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const late = fn === 'read_csv_auto' && !isCancel(e) ? /Error when converting column "([^"]+)"\. Could not convert string "([^"]*)"/.exec(msg) : null
          if (!late || asText.length >= 8 || asText.some((c) => c.column === late[1])) throw e
          const where = { value: late[2], line: /CSV Error on Line: (\d+)/.exec(msg)?.[1] ?? '' }
          if (!wholeFile) {
            wholeFile = where
            continue
          }
          asText.push({ column: late[1], ...where })
          textColumns.push(late[1])
        }
      }
      const w = wholeFile as { line: string; value: string } | null
      if (w && !asText.length)
        onNote?.(
          `${file.name} has something other than numbers far down (“${w.value}”${w.line ? ` on line ${Number(w.line).toLocaleString(LOCALE)}` : ''}): read again looking at every line, so nothing is lost. Convert to numbers from a column’s menu.`,
        )
      if (asText.length)
        onNote?.(
          `${asText.map((c) => c.column).join(', ')} in ${file.name} ${asText.length === 1 ? 'has' : 'have'} something other than numbers further down (“${asText[0].value}”${asText[0].line ? ` on line ${Number(asText[0].line).toLocaleString(LOCALE)}` : ''}): read as text, so nothing is lost. Convert to numbers from the column’s menu.`,
        )
    } catch (e) {
      const sniffed = !isCancel(e) && fn === 'read_csv_auto' ? await import('./sniff').catch(() => null) : null
      const head = sniffed ? await file.slice(0, 64 * 1024).text() : ''
      // Title lines above the names; or none, the names first, and lines of other lengths among the rows.
      const t = sniffed ? ((await titles().catch(() => null)) ?? sniffed.titleLines(head, true)) : null
      if (t && t.skip === 0) ragged = t
      const read = t && (await sendAll(`CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM ${fromNames(t)}`).then(() => null, (again: unknown) => again))
      if (!t || read) {
        await db.dropFile(virtualPath).catch(() => {})
        const why = read ?? e
        throw isCancel(why) ? new CancelledError() : why
      }
    }
    // Nothing read from a file with something in it (the engine out of room says so this way at times):
    // a failure, not an empty table.
    if (materialize && file.size > 4096) {
      const shape = (await sendAll(`SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(name)}`)).toArray()[0]?.toJSON() as { n: number } | undefined
      const cols = await columnTypes(name)
      if (Number(shape?.n ?? 0) === 0 && cols.length === 1 && /^column0?$/i.test(cols[0].name)) {
        await sendAll(`DROP TABLE IF EXISTS ${quoteIdent(name)}`).catch(() => {})
        await db.dropFile(virtualPath).catch(() => {})
        throw new Error(`Out of Memory Error: nothing could be read from ${file.name}`)
      }
    }
    // Rows with more or fewer fields than the header make the sniffer give up and read each line as
    // one text column ("name,city,amount"). Read it again with that separator, padding short rows.
    if (fn === 'read_csv_auto') {
      try {
        const cols = (await columnTypes(name)).map((c) => c.name)
        const sep = cols.length === 1 ? [',', ';', '\t', '|'].find((d) => cols[0].includes(d)) : undefined
        let read = (opts: string) => `read_csv_auto(${quoteLiteral(virtualPath)}${withTypes(opts) ? `, ${withTypes(opts)}` : ''})`
        if (ragged) {
          const r = ragged
          read = (opts) => fromNames(r, opts)
          onNote?.(`Some rows of ${file.name} have more or fewer fields than its header: missing ones are left empty.`)
        } else if (sep) {
          read = (opts) =>
            `read_csv(${quoteLiteral(virtualPath)}, delim = ${quoteLiteral(sep)}, header = true, null_padding = true, strict_mode = false${withTypes(opts) ? `, ${withTypes(opts)}` : ''})`
          await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`)
          onNote?.(`Some rows of ${file.name} have more or fewer fields than its header: missing ones are left empty.`)
        } else if (titled || (cols.length === 1 && (await titles()))) {
          const found = (await titles())!
          read = (opts) => fromNames(found, opts)
          if (!titled || cols.length === 1) await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`)
          onNote?.(`Left out ${found.skip === 1 ? 'a title line' : `${found.skip} title lines`} above the column names in ${file.name}.`)
        } else {
          // A note below the table written with another separator ("Source: ONS | Licence: OGL v3", a legend with
          // semicolons) can make the file reader take that for the columns: no rows, or every line as one
          // column. Fewer columns than most of the lines have: read again by the lines' own separator.
          const t = (await import('./sniff')).titleLines(await file.slice(0, 64 * 1024).text(), true)
          const rows = t ? Number((await sendAll(`SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(name)}`)).toArray()[0]?.toJSON().n ?? 0) : 0
          // Title lines saved from Excel, padded to the table's width ("HDFC BANK Ltd.,,,,,,"): the file reader
          // took the first for the names (one name, the rest made up). Read from the real names instead.
          const madeUp = cols.filter((c) => /^column\d+$/i.test(c)).length >= Math.max(1, (cols.length - 1) / 2)
          // (The reader names the first column after the title: "HDFC BANK Ltd.", never a made-up name there.)
          const padded = !!t && t.skip > 0 && madeUp && !/^column\d+$/i.test(cols[0] ?? '')
          if (t && t.fields >= 2 && (rows === 0 || cols.length < t.fields || padded)) {
            const again = (opts: string) => fromNames(t, opts)
            const fits = await sendAll(`CREATE OR REPLACE TABLE ${quoteIdent(`__fit_${name}`)} AS SELECT * FROM ${again('')}`).then(
              () => true,
              (e: unknown) => (isCancel(e) || OUT_OF_MEMORY.test(String(e)) ? Promise.reject(e) : false),
            )
            const better = fits && (await columnTypes(`__fit_${name}`)).length === t.fields
            if (better) {
              await sendAll(`DROP TABLE ${quoteIdent(name)}`)
              await sendAll(`ALTER TABLE ${quoteIdent(`__fit_${name}`)} RENAME TO ${quoteIdent(name)}`)
              read = again
              onNote?.(
                padded
                  ? `Left out ${t.skip === 1 ? 'a title line' : `${t.skip} title lines`} above the column names in ${file.name}.`
                  : `Some lines of ${file.name} don’t fit its columns (a note below the table, say): read by its columns, they’re rows you can leave out.`,
              )
            } else await sendAll(`DROP TABLE IF EXISTS ${quoteIdent(`__fit_${name}`)}`).catch(() => {})
          }
        }
        await keepZeros(name, read, textColumns, file.name, onNote)
        await keepAsWritten(name, read, textColumns, file.name, onNote)
        await readDates(name, virtualPath, read)
        await twoDigitYears(name, read, file.name, onNote)
      } catch (e) {
        if (isCancel(e)) {
          // Stopped part-way through putting it right (codes read again as text, dates turned round): the
          // table as first read would be wrong without a word, so it goes, as the message says.
          await sendAll(`DROP TABLE IF EXISTS ${quoteIdent(name)}`).catch(() => {})
          await db.dropFile(virtualPath).catch(() => {})
          throw new CancelledError()
        }
        /* keep the table as first read */
      }
    }
    // A materialised table no longer needs the file; a Parquet view keeps reading it.
    if (materialize) await db.dropFile(virtualPath).catch(() => {})
    return [name]
  })
}

let excelWorker: { stop: () => void } | null = null

/** Stops an Excel file that is still being read (the Cancel button calls this as well as cancelRunning). */
export function cancelExcel() {
  excelWorker?.stop()
}

function parseExcel(file: File): Promise<XlsxReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), { type: 'module' })
    const finish = (reply: XlsxReply) => {
      window.clearTimeout(timer)
      excelWorker = null
      resolve(reply)
      worker.terminate()
    }
    excelWorker = {
      stop: () => {
        window.clearTimeout(timer)
        excelWorker = null
        worker.terminate()
        reject(new CancelledError())
      },
    }
    // Large workbooks take seconds; anything past two minutes is treated as stuck.
    const timer = window.setTimeout(() => finish({ ok: false, error: 'Reading that workbook took too long. Try saving it as CSV.', plain: true }), 120_000)
    worker.onmessage = (e: MessageEvent<XlsxReply>) => finish(e.data)
    worker.onerror = (e) => finish({ ok: false, error: e.message || 'The spreadsheet couldn’t be read.' })
    worker.postMessage(file)
  })
}

/** Every non-empty sheet becomes its own table: budget.xlsx → budget_q1, budget_q2, … */
async function ingestExcel(file: File, taken: Set<string>, onNote?: Noted): Promise<string[]> {
  const reply = await parseExcel(file)
  if (!reply.ok) throw reply.plain ? new FileKindError(reply.error) : new Error(reply.error)
  const names = await ingestSheets(file, reply.sheets, taken, onNote)
  // Cells the reader can only leave empty: said, so a sum isn't taken for the workbook's.
  const { errors, uncached } = reply.blanks
  const n = (x: number) => x.toLocaleString(LOCALE)
  if (errors)
    onNote?.(`${n(errors)} ${errors === 1 ? 'cell' : 'cells'} in ${file.name} ${errors === 1 ? 'holds' : 'hold'} an Excel error (#DIV/0!, #N/A, #REF!…): empty here, so sums leave ${errors === 1 ? 'it' : 'them'} out where Excel shows the error.`)
  if (uncached)
    onNote?.(`${n(uncached)} formula ${uncached === 1 ? 'cell' : 'cells'} in ${file.name} ${uncached === 1 ? 'has' : 'have'} no saved result (the program that wrote it didn’t calculate it): empty here. Open the file in Excel and save it, then open it again.`)
  return names
}

/** An ".xls" that is a web page's table or Excel 2003 XML: read here (the browser parses markup). */
async function ingestMarkup(file: File, kind: 'html' | 'xml-sheet', taken: Set<string>, onNote?: Noted, decoded?: string): Promise<string[]> {
  // The browser builds the whole page in memory (several times the file), and that can't be stopped.
  if (file.size > 50 * 1024 ** 2) throw new FileKindError(`${file.name} is a web page or XML spreadsheet over 50 MB. Save it as CSV or .xlsx and open that.`)
  const { markupToCsv } = await import('./markup-sheets')
  const sheets = markupToCsv(decoded ?? (await textOf(file)), kind)
  if (!sheets.length && kind === 'html') throw new FileKindError(`${file.name} is a web page with no table in it.`)
  return ingestSheets(file, sheets, taken, onNote)
}

/** A note about a file as it opened (title lines left out…), or a check on it (a trial balance's tie-out). */
export type Noted = (note: string, check?: { ok: boolean }) => void

/** Tally's XML: its envelope, or the messages inside one. */
const TALLY = /<ENVELOPE\b|<TALLYMESSAGE\b/i

/** Tally's XML, read as a table: one row per voucher line, or per row of a report. */
async function ingestTally(file: File, source: string, taken: Set<string>, onNote?: Noted): Promise<string[]> {
  if (file.size > 100 * 1024 ** 2) throw new FileKindError(`${file.name} is Tally XML over 100 MB. From Tally, export the report to Excel or CSV instead, and open that.`)
  const { tallyToCsv } = await import('./tally')
  const { sheets, notes } = tallyToCsv(source, file.name)
  if (!sheets.length) throw new FileKindError(`${file.name} is Tally’s own XML, with no vouchers or report rows in it. From Tally, export the report to Excel or CSV instead, and open that.`)
  const names = await ingestSheets(file, sheets, taken, onNote)
  for (const n of notes) onNote?.(n.text, { ok: n.ok })
  return names
}

/** A web page's or XML file's text in the encoding it declares (Excel's web pages are often windows-1252). */
async function textOf(file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048))
  const label = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding\s*=\s*["']([\w:.-]+)["']/i.exec(head)?.[1]
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes) // a label the browser doesn't know
  }
}

async function ingestSheets(file: File, sheets: XlsxSheet[], taken: Set<string>, onNote?: Noted): Promise<string[]> {
  if (!sheets.length) throw new FileKindError('That workbook has no data in any sheet.')
  const reply = { sheets }
  return withRunLock(async () => {
    const { db } = await getEngine()
    const used = await takenNames(taken)
    const stem = file.name.replace(/\.(xls[xm]?|xml|html?|csv|tsv|txt)$/i, '')
    const names: string[] = []
    for (const sheet of reply.sheets) {
      const name = tableNameFor(reply.sheets.length === 1 ? `${stem}.x` : `${stem} ${sheet.name}.x`, used)
      used.add(name)
      dateOrders.delete(name.toLowerCase())
      datesGuessed.delete(name.toLowerCase())
      const path = sandboxPath(`${name}__sheet.csv`)
      await db.registerFileText(path, sheet.csv)
      // Codes Excel holds as text (00123, 1E5, an ICCID's 20 digits) stay text: read as numbers, they'd change.
      // (Names once each, ignoring case: the reader would refuse two. If it still refuses, read as before.)
      const named = [...new Map((sheet.text ?? []).map((c) => [c.toLowerCase(), c])).values()]
      let types = named.length ? `types = {${named.map((c) => `${quoteLiteral(c)}: 'VARCHAR'`).join(', ')}}` : ''
      const read = (opts: string) => `read_csv_auto(${quoteLiteral(path)}, header = true${[types, opts].filter(Boolean).map((o) => `, ${o}`).join('')})`
      try {
        await sendAll(`CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`).catch((e: unknown) => {
          if (isCancel(e) || !types) throw e
          types = ''
          return sendAll(`CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM ${read('')}`)
        })
        await readDates(name, path, read).catch((e) => (isCancel(e) ? Promise.reject(e) : undefined))
      } finally {
        await db.dropFile(path).catch(() => {})
      }
      names.push(name)
      if (sheet.skipped)
        onNote?.(`Left out ${sheet.skipped === 1 ? 'a title line' : `${sheet.skipped} title lines`} above the column names in ${reply.sheets.length === 1 ? file.name : sheet.name}.`)
    }
    return names
  })
}

/**
 * A realistic 1,000,000-row orders table generated inside DuckDB: no download needed. It's called
 * "orders" unless that name is taken (by the user's own file, or an earlier sample), so it never
 * replaces anyone's data.
 */
export function createDemo(rows = 1_000_000): Promise<string> {
  return withRunLock(async () => {
    const name = tableNameFor('orders.x', await takenNames(new Set()))
    await sendAll(`
      CREATE TABLE ${quoteIdent(name)} AS
      WITH base AS (
        SELECT range AS i, hash(range) AS h, hash(range * 7919) AS g FROM range(${rows})
      )
      SELECT
        100000 + i AS order_id,
        TIMESTAMP '2023-01-01' + to_seconds((h % 56160000)::BIGINT) AS ordered_at,
        ['Aarav','Diya','Kabir','Meera','Rohan','Ananya','Vihaan','Isha','Arjun','Sara','Leo','Mia','Noah','Zoe','Kenji','Amara'][1 + (g % 16)::INT]
          || ' ' || ['Sharma','Iyer','Khan','Das','Patel','Mehta','Reddy','Bose','Smith','Garcia','Tanaka','Okafor'][1 + (h % 12)::INT] AS customer,
        ['Bengaluru','Mumbai','Delhi','Kolkata','Chennai','Pune','Hyderabad','Jaipur','London','Berlin','Singapore','Dubai','Toronto','Sydney'][1 + ((h >> 8) % 14)::INT] AS city,
        ['Electronics','Home','Fashion','Books','Beauty','Sports','Grocery','Toys'][1 + ((g >> 4) % 8)::INT] AS category,
        ['Wireless earbuds','Desk lamp','Linen shirt','Paperback novel','Face serum','Yoga mat','Cold brew pack','Puzzle set',
         'Mechanical keyboard','Ceramic mug','Running shoes','Cookbook','Sunscreen','Football','Green tea','Board game'][1 + ((h >> 16) % 16)::INT] AS product,
        1 + ((g >> 12) % 5)::INT AS quantity,
        round(99 + ((h >> 20) % 490000) / 100.0, 2) AS unit_price,
        [0, 0, 0, 5, 10, 15, 20][1 + ((g >> 20) % 7)::INT] AS discount_pct,
        round((1 + ((g >> 12) % 5)) * (99 + ((h >> 20) % 490000) / 100.0) * (1 - [0, 0, 0, 5, 10, 15, 20][1 + ((g >> 20) % 7)::INT] / 100.0), 2) AS total,
        ['delivered','delivered','delivered','delivered','shipped','processing','returned','cancelled'][1 + ((h >> 28) % 8)::INT] AS status
      FROM base
    `)
    return name
  })
}
