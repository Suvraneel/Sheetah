import { EditorView } from '@codemirror/view'

/** Inserts text at the cursor of the (single) editor on the page. */
export function insertIntoEditor(text: string) {
  const el = document.querySelector('.editor .cm-editor')
  const v = el ? EditorView.findFromDOM(el as HTMLElement) : null
  if (!v) return
  const { from, to } = v.state.selection.main
  v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
  v.focus()
}

/** Moves keyboard focus into the editor. */
export function focusEditor() {
  const el = document.querySelector('.editor .cm-editor')
  const v = el ? EditorView.findFromDOM(el as HTMLElement) : null
  v?.focus()
}
