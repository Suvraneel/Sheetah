import { Fragment } from 'react'
import { BtnIcon } from './Icon'
import { useDialog } from './useDialog'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const MOD = isMac ? '⌘' : 'Ctrl'
const ALT = isMac ? '⌥' : 'Alt'

/** Each entry: key combos (alternatives separated by "or"), then what they do. */
const GROUPS: { title: string; rows: [string[][], string][] }[] = [
  {
    title: 'Query',
    rows: [
      [[[MOD, 'Enter'], ['Shift', 'Enter']], 'Run the query'],
      [[['Tab']], 'Leave the editor (it never traps Tab)'],
    ],
  },
  {
    title: 'Grid',
    rows: [
      [[['↑ ↓ ← →']], 'Move the active cell'],
      [[['Page Up'], ['Page Down']], 'Move a screen at a time'],
      [[['Home'], ['End']], 'First or last column'],
      [[[MOD, '↑ ↓ ← →']], 'Jump to the edge'],
      [[['Shift', '↑ ↓ ← →'], ['Shift', 'click']], 'Extend the selection'],
      [[['Shift', 'Space']], 'Select the row (its number does it too)'],
      [[['Ctrl', 'Space']], 'Select the column: its count, sum and average in the status bar'],
      [[[MOD, 'A']], 'Select everything'],
      [[[MOD, 'C']], 'Copy the selection as tab-separated text'],
      [[[MOD, 'V']], 'Paste cells copied from a spreadsheet as a new table'],
      [[[MOD, 'F']], 'Find text in every column'],
      [[[MOD, 'Z'], [MOD, 'Shift', 'Z']], 'Undo or redo a sort, filter, clean-up or look-up'],
      [[[ALT, '↓'], ['Shift', 'F10']], 'Open the column menu: sort, filter, profile'],
      [[['Esc']], 'Clear the selection'],
    ],
  },
  {
    title: 'Layout',
    rows: [
      [[['↑'], ['↓']], 'On the editor’s resize handle: shorter or taller (Shift for bigger steps)'],
      [[['Enter']], 'On the resize handle: fit the editor to the query again'],
      [[['?']], 'Show this list'],
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
