import { Fragment } from 'react'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const MOD = isMac ? '⌘' : 'Ctrl'
const ALT = isMac ? '⌥' : 'Alt'

/** Each entry: key combos (alternatives separated by "or"), then what they do. */
const GROUPS: { title: string; rows: [string[][], string][] }[] = [
  {
    title: 'Steps and queries',
    rows: [
      [[[MOD, 'Enter']], 'Run the query (Shift+Enter too)'],
      [[[MOD, 'Z']], `Undo a step: a sort, filter, clean-up… (redo: ${MOD}+Shift+Z)`],
      [[[MOD, 'F']], 'Find text in every column'],
      [[[MOD, 'V']], 'Paste cells from a spreadsheet as a new table'],
      [[['Tab']], 'Leave the editor (it never traps Tab)'],
      [[['?']], 'Show this list'],
    ],
  },
  {
    title: 'Editor size',
    rows: [[[['↑'], ['↓']], 'On the resize handle: shorter or taller (Enter fits the query)']],
  },
  {
    title: 'Moving in the grid',
    rows: [
      [[['↑ ↓ ← →']], 'Move the active cell'],
      [[['PgUp'], ['PgDn']], 'A screen at a time'],
      [[['Home'], ['End']], 'First or last column'],
      [[[MOD, '↑ ↓ ← →']], 'Jump to the edge'],
      [[[ALT, '↓']], 'Open the column menu (Shift+F10 too)'],
    ],
  },
  {
    title: 'Selecting',
    rows: [
      [[['Shift', '↑ ↓ ← →']], 'Extend the selection (Shift+click too)'],
      [[['Shift', 'Space']], 'Select the row'],
      [[['Ctrl', 'Space']], 'Select the column: its sum shows below'],
      [[[MOD, 'A']], 'Select everything'],
      [[[MOD, 'C']], 'Copy as tab-separated text'],
      [[['Esc']], 'Clear the selection'],
    ],
  },
]

function Keys({ combo }: { combo: string[] }) {
  return (
    <span className="combo">
      {combo.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span className="plus">+</span>}
          <kbd>{k}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useDialog<HTMLDivElement>(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="keys-title" className="modal-wrap modal-wrap-wide">
        <div className="shell modal modal-wide">
          <div className="core">
            <span className="eyebrow">Keyboard</span>
            <h2 id="keys-title" tabIndex={-1} data-autofocus>
              Shortcuts
            </h2>
            <div className="keys">
              {GROUPS.map((g) => (
                <section key={g.title} className="keys-group" aria-labelledby={`keys-${g.title}`}>
                  <h3 id={`keys-${g.title}`} className="label">
                    {g.title}
                  </h3>
                  <dl>
                    {g.rows.map(([combos, what]) => (
                      <div key={what} className="keys-row">
                        <dt>
                          {combos.map((c, i) => (
                            <Fragment key={c.join('+')}>
                              {i > 0 && <span className="or">or</span>}
                              <Keys combo={c} />
                            </Fragment>
                          ))}
                        </dt>
                        <dd>{what}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onClose}>
                Done
                <BtnIcon name="close" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
