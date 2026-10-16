import { useEffect, useRef } from 'react'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language'
import { autocompletion, closeBrackets, closeCompletion, completionKeymap } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import type { TableMeta } from '../engine/ingest'
import { EDITOR_FIT_MAX, EDITOR_MIN } from './editorSize'

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: 'var(--syn-fn)' },
  { tag: [t.typeName], color: 'var(--syn-type)' },
  { tag: [t.special(t.name), t.quote], color: 'var(--syn-ident)' },
])

const theme = EditorView.theme({
  '&': { fontSize: '13.5px', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace', lineHeight: '1.7' },
  '.cm-content': { padding: '14px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 18px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-line)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--editor-selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-tooltip': {
    border: 'none',
    borderRadius: '14px',
    background: 'var(--surface)',
    boxShadow: '0 0 0 1px var(--hair), 0 24px 48px -24px var(--shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important', fontFamily: '"JetBrains Mono Variable", monospace' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
})

/**
 * The editor fits its query only while it's being edited. Unfocused, it keeps its current height,
 * so SQL written by header clicks, saved views or history never shifts the grid under the pointer
 * (the query scrolls instead); focusing the editor fits it to the whole query again.
 */
function setFrozen(view: EditorView, frozen: boolean) {
  const host = view.dom.parentElement
  if (!host) return
  // Freeze at the query's fitted height (not the rendered one, which may be a pin that is later reset).
  const fit = Math.min(EDITOR_FIT_MAX, Math.max(EDITOR_MIN, view.contentDOM.getBoundingClientRect().height))
  if (frozen) host.style.setProperty('--editor-freeze', `${Math.round(fit)}px`)
  host.classList.toggle('is-frozen', frozen)
}

interface Props {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  tables: TableMeta[]
  id?: string
}

export function SqlEditor({ value, onChange, onRun, tables, id }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const schemaComp = useRef(new Compartment())
  const cb = useRef({ onChange, onRun })
  cb.current = { onChange, onRun }

  const schemaFor = (ts: TableMeta[]) =>
    sql({
      dialect: PostgreSQL,
      upperCaseKeywords: true,
      schema: Object.fromEntries(ts.map((tb) => [tb.name, tb.columns.map((c) => c.name)])),
    })

  useEffect(() => {
    const run = () => {
      cb.current.onRun()
      return true
    }
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ icons: false }),
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run }, { key: 'Shift-Enter', run }])),
          // No Tab-to-indent: Tab must move focus out of the editor (WCAG 2.1.2, no keyboard trap).
          // Tab closes any open suggestions and still leaves the editor (returning false keeps the default).
          keymap.of([{ key: 'Tab', run: (v) => (closeCompletion(v), false) }, ...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          schemaComp.current.of(schemaFor(tables)),
          syntaxHighlighting(highlight),
          theme,
          cmPlaceholder('SELECT * FROM orders WHERE total > 5000 ORDER BY ordered_at DESC'),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'SQL editor. Press Cmd or Ctrl+Enter to run.' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString())
            if (u.focusChanged) setFrozen(u.view, !u.view.hasFocus)
          }),
        ],
      }),
    })
    setFrozen(view.current, true)
    return () => view.current?.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External value changes (e.g. header actions composing SQL)
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: schemaComp.current.reconfigure(schemaFor(tables)) })
  }, [tables])

  return <div className="editor" id={id} ref={host} />
}
