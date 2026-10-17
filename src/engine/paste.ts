/*
 * Cells copied from a spreadsheet (Excel, Google Sheets, Numbers, or Sheetah's own grid) arrive as
 * tab-separated text; CSV copied from a text editor as commas. Either is made into a table when it's
 * pasted outside the editor and inputs, read like a dropped file.
 */

/** A file for the pasted text, when it looks like rows and columns (at least two lines, cells in a row). */
export function pastedFile(text: string): File | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return null
  const tabs = lines[0].includes('\t')
  if (!tabs) {
    // CSV: the first lines agree on how many fields they have (a sentence with a comma doesn't).
    const fields = (l: string) => l.split(',').length
    const n = fields(lines[0])
    if (n < 2 || !lines.slice(1, 6).every((l) => fields(l) === n)) return null
  }
  return new File([text], tabs ? 'pasted.tsv' : 'pasted.csv', { type: 'text/plain' })
}
