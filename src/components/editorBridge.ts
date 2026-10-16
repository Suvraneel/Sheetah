import type { EditorView } from '@codemirror/view'

/*
 * The (single) SQL editor registers its view here, so the rest of the app can talk to it without
 * importing CodeMirror itself. Type-only import: CodeMirror stays in the lazily loaded editor chunk.
 */
let current: EditorView | null = null

export function registerEditor(view: EditorView | null) {
  current = view
}

/** Inserts text at the cursor of the editor. */
export function insertIntoEditor(text: string) {
  const v = current
  if (!v) return
  const { from, to } = v.state.selection.main
  v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
  v.focus()
}

/** Moves keyboard focus into the editor. */
export function focusEditor() {
  current?.focus()
}
