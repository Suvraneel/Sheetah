export const EDITOR_MIN = 98 // three lines
/** Tallest pinned editor: 60% of the window, but always leaving room for the results below. */
export const editorMax = () => Math.max(EDITOR_MIN, Math.min(Math.round(window.innerHeight * 0.6), window.innerHeight - 420))
export const clampEditor = (h: number) => Math.min(editorMax(), Math.max(EDITOR_MIN, Math.round(h)))
/** Unpinned, the editor fits its query up to this (8 lines); keep in step with `.editor .cm-scroller` in index.css. */
export const EDITOR_FIT_MAX = 214
