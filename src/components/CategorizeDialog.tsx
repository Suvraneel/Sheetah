import { useEffect, useMemo, useRef, useState } from 'react'
import { getEngine } from '../engine/db'
import { categorizeExpr, categoryName, knownCategory, knownWordsSql, suggestRules, usableRules, wordsSql, type Categorize, type CategoryRule } from '../engine/categorize'
import { colRef, type ColumnInfo } from '../engine/result'
import { LOCALE } from '../engine/sql'
import { keepFocusIn, thenKeepFocus } from './focus'
import { BtnIcon, Icon } from './Icon'
import { useDialog } from './useDialog'

interface Props {
  /** The rows the column is added to (a result table), and its columns. */
  table: string
  columns: ColumnInfo[]
  rowCount: number
  /** The text column to start from. */
  column?: string
  /** Rules to edit, and their column's name (added before). */
  initial?: Categorize & { name: string }
  /** Names in use (a new column's name is one that isn't). */
  taken: string[]
  onAdd: (name: string, expr: string, c: Categorize) => void
  onClose: () => void
}

const nf = new Intl.NumberFormat(LOCALE)
const OTHER = 'Other'
const words = (text: string) => text.split(',').map((w) => w.trim()).filter(Boolean)
const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

/**
 * Categories from words in a text column (a statement's narrations: SWIGGY, ZOMATO → Food), as an added
 * column. The column's common words are listed to pick from, and each category says how many rows it gets.
 */
/** Rules as they should be (a views file could say anything): else the column is made afresh. */
const wellFormed = (c: Categorize | undefined): c is Categorize =>
  !!c && typeof c.column === 'string' && Array.isArray(c.rules) && c.rules.every((r) => r && typeof r.category === 'string' && Array.isArray(r.words) && r.words.every((w) => typeof w === 'string'))

export function CategorizeDialog({ table, columns, rowCount, column, initial: given, taken, onAdd, onClose }: Props) {
  const initial = given && wellFormed(given) ? given : undefined
  const dialog = useDialog<HTMLDivElement>(onClose)
  const [name] = useState(() => initial?.name ?? categoryName(taken))
  const text = columns.filter((c) => !c.numeric && /CHAR|TEXT|STRING/i.test(c.type))
  const [col, setCol] = useState(initial?.column ?? column ?? text[0]?.name ?? '')
  // Words as typed (comma-separated): parsed only when used, so typing "swiggy, " doesn't jump.
  const [rules, setRules] = useState<{ category: string; words: string }[]>(() => (initial?.rules ?? []).map((r) => ({ category: r.category, words: r.words.join(', ') })))
  // Editing: "everything else" as it was, left empty too (a new set starts with Other).
  const [otherwise, setOtherwise] = useState(initial ? (typeof initial.otherwise === 'string' ? initial.otherwise : '') : OTHER)
  // The commonest words of the rows no category has taken yet, by the column and rules they were found for.
  const [found, setFound] = useState<{ key: string; words: { word: string; rows: number }[] } | null>(null)
  // The usual categories' words the column has anywhere, for "Start with the usual ones".
  const [known, setKnown] = useState<{ col: string; words: string[] } | null>(null)
  // Rows per category, for the rules they were counted for (older counts aren't shown for newer rules).
  const [counted, setCounted] = useState<{ spec: Categorize; n: Map<string | null, number> } | null>(null)
  const active = useRef<number | null>(null)
  // The place among the words of the chip last used, while focus is there: the words are looked for again
  // after each one is used, and a chip with focus can go (its rows taken by the word just added).
  const wordAt = useRef<number | null>(null)
  const wordsRef = useRef<HTMLDivElement>(null)
  const info = columns.find((c) => c.name === col)

  const spec: Categorize = useMemo(() => ({ column: col, rules: rules.map((r) => ({ category: r.category, words: words(r.words) })), otherwise }), [col, rules, otherwise])

  // Rows still to sort: those none of the rules (as they stand) takes. Their words are the ones worth offering.
  const untaken = info ? `(${categorizeExpr({ ...spec, otherwise: undefined }, () => colRef(info))}) IS NULL` : ''
  const wordsKey = `${col}\u0000${untaken}`
  // The last words found stay while the next are looked for (no flicker as rules are typed).
  const common = found ? found.words : null
  useEffect(() => {
    if (!info) return
    let live = true
    const t = window.setTimeout(() => {
      void getEngine()
        .then(({ conn }) => conn.query(wordsSql(table, colRef(info), 24, untaken === '(NULL) IS NULL' ? undefined : untaken)))
        .then((res) => {
          if (live) setFound({ key: wordsKey, words: res.toArray().map((r) => r.toJSON() as { word: string; rows: number }) })
        })
        .catch(() => live && setFound({ key: wordsKey, words: [] }))
    }, 300)
    return () => {
      live = false
      window.clearTimeout(t)
    }
    // The words' query is what the key says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, wordsKey])
  useEffect(() => {
    if (!info) return
    let live = true
    void getEngine()
      .then(({ conn }) => conn.query(knownWordsSql(table, colRef(info))))
      .then((res) => live && setKnown({ col: info.name, words: res.toArray().map((r) => String(r.toJSON().word)) }))
      .catch(() => live && setKnown({ col: info.name, words: [] }))
    return () => {
      live = false
    }
  }, [table, info])

  // How many rows each category gets, a moment after typing stops.
  useEffect(() => {
    if (!info) return
    let live = true
    const t = window.setTimeout(() => {
      const expr = categorizeExpr(spec, () => colRef(info))
      void getEngine()
        .then(({ conn }) => conn.query(`SELECT (${expr}) AS c, count(*)::DOUBLE AS n FROM ${table} GROUP BY 1`))
        .then((res) => live && setCounted({ spec, n: new Map(res.toArray().map((r) => r.toJSON() as { c: string | null; n: number }).map((r) => [r.c, Number(r.n)])) }))
        .catch(() => live && setCounted(null))
    }, 250)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [spec, info, table])

  // With no chip left to take it, focus goes to the words of the category they went to (not behind the dialog).
  const wordsFallback = () =>
    dialog.current?.querySelector<HTMLElement>(active.current !== null ? `[aria-label="Category ${active.current + 1} words"]` : '.cat-rule:last-of-type input:nth-of-type(2)') ??
    dialog.current?.querySelector<HTMLElement>('input, select') ??
    null
  useEffect(() => {
    if (wordAt.current !== null) keepFocusIn(wordsRef.current, wordAt.current, wordsFallback)
    // Only when the words change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found])

  const counts = counted?.spec === spec ? counted.n : null
  const used = new Set(rules.flatMap((r) => words(r.words).map((w) => w.toLowerCase())))
  const offered = (common ?? []).filter((w) => !used.has(w.word))
  const usable = usableRules(spec.rules)
  const update = (i: number, patch: Partial<{ category: string; words: string }>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addWord = (word: string) => {
    const i = active.current
    if (i !== null && rules[i]) {
      update(i, { words: [...words(rules[i].words), word].join(', ') })
      return
    }
    const known = knownCategory(word)
    const at = known ? rules.findIndex((r) => r.category.trim().toLowerCase() === known.toLowerCase()) : -1
    if (at >= 0) update(at, { words: [...words(rules[at].words), word].join(', ') })
    else setRules((rs) => [...rs, { category: known ?? title(word), words: word }])
  }
  const usual = known?.col === col ? known.words : []
  const start = () => setRules(suggestRules(usual).map((r: CategoryRule) => ({ category: r.category, words: r.words.join(', ') })))
  const starters = !rules.length ? suggestRules(usual) : []
  // Each category once (two rules can share one), and not the one for everything else.
  const names = [...new Set(usable.map((r) => r.category))].filter((c) => c !== otherwise.trim())
  const inRules = counts ? names.reduce((n, c) => n + (counts.get(c) ?? 0), 0) : null
  const rest = counts ? (counts.get(otherwise.trim() || null) ?? 0) : null

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="cat-title" className="modal-wrap modal-wrap-wide">
        <form
          className="shell modal modal-wide"
          onSubmit={(e) => {
            e.preventDefault()
            if (!usable.length || !info) return
            const c: Categorize = { column: col, rules: usable, ...(otherwise.trim() ? { otherwise: otherwise.trim() } : {}) }
            onAdd(name, categorizeExpr(c), c)
          }}
        >
          <div className="core">
            <span className="eyebrow">Categories</span>
            <h2 id="cat-title">Group {col || 'a column'} into categories</h2>
            <p className="muted">
              Each row goes to the first category with one of its words in {col || 'the text'} (upper or lower case alike). It’s an added column, {name}: kept
              with a saved view, so next month’s file is sorted the same way.
            </p>
            {(text.length > 1 || !info) && (
              <label className="cat-col pivot-zone">
                <span className="fine">Words in</span>
                <select value={col} onChange={(e) => setCol(e.target.value)}>
                  {!info && (
                    <option value={col} disabled>
                      {col || 'Pick a column'}
                    </option>
                  )}
                  {text.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <fieldset className="pivot-zone cat-rules">
              <legend>Categories</legend>
              {rules.map((r, i) => (
                <div className="cat-rule" key={i}>
                  <input
                    className="input"
                    aria-label={`Category ${i + 1} name`}
                    placeholder="Category"
                    value={r.category}
                    onFocus={() => (active.current = i)}
                    onChange={(e) => update(i, { category: e.target.value })}
                  />
                  <input
                    className="input"
                    aria-label={`Category ${i + 1} words`}
                    placeholder="Words, separated by commas"
                    value={r.words}
                    onFocus={() => (active.current = i)}
                    onChange={(e) => update(i, { words: e.target.value })}
                  />
                  <span className="cat-count fine">
                    {counts && r.category.trim() ? `${nf.format(counts.get(r.category.trim()) ?? 0)} rows` : ''}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${r.category || `category ${i + 1}`}`}
                    onClick={() => {
                      active.current = null
                      setRules((rs) => rs.filter((_, j) => j !== i))
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
              <div className="cat-actions">
                <button type="button" className="link-btn" onClick={() => setRules((rs) => [...rs, { category: '', words: '' }])}>
                  + Add a category
                </button>
                {starters.length > 0 && (
                  <button type="button" className="link-btn" onClick={start}>
                    Start with the usual ones ({starters.map((s) => s.category).join(', ')})
                  </button>
                )}
              </div>
              <label className="cat-other">
                <span className="fine">Everything else</span>
                <input className="input" aria-label="Category for everything else" value={otherwise} placeholder="(left empty)" onChange={(e) => setOtherwise(e.target.value)} />
              </label>
            </fieldset>

            <div
              ref={wordsRef}
              className="cat-words"
              role="group"
              onBlur={(e) => {
                // Focus taken elsewhere (not lost with a chip that's gone): the words let it be.
                if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) wordAt.current = null
              }}
              aria-label={`Common words in ${col}${usable.length ? ', in rows no category has taken' : ''}`}>
              <span className="fine">{usable.length ? 'Words in the rows left over:' : `Common words in ${col}:`}</span>
              {!info ? null : common === null ? (
                <span className="fine">looking…</span>
              ) : offered.length ? (
                offered.map((w) => (
                  <button
                    type="button"
                    key={w.word}
                    className="pii-chip"
                    aria-label={`Add ${w.word} (${nf.format(w.rows)} ${w.rows === 1 ? 'row' : 'rows'})`}
                    title={knownCategory(w.word) ? `Usually ${knownCategory(w.word)}` : 'Add to the category you were editing, or as a new one'}
                    // The chip goes once its word is used: focus stays among the words.
                    onClick={(e) => (wordAt.current = thenKeepFocus(e, '.cat-words', () => addWord(w.word), wordsFallback))}
                  >
                    {w.word} <span className="cat-n">{nf.format(w.rows)}</span>
                  </button>
                ))
              ) : (
                <span className="fine">{common.length ? 'all in a category' : usable.length ? 'none left' : 'none found'}</span>
              )}
            </div>

            <p className="fine stack-report" role="status">
              {!info
                ? `${col || 'That column'} isn’t among these rows’ columns now: pick the column to look for words in.`
                : !usable.length
                  ? 'Add a category and the words that put a row in it.'
                  : inRules === null || rest === null
                    ? 'Counting…'
                    : `${nf.format(rowCount)} rows: ${nf.format(inRules)} in ${names.length} ${names.length === 1 ? 'category' : 'categories'}, ${nf.format(rest)} ${otherwise.trim() ? `as ${otherwise.trim()}` : 'left empty'}.`}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!usable.length || !info}>
                {initial ? 'Update categories' : `Add the ${name} column`}
                <BtnIcon name="arrowRight" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
