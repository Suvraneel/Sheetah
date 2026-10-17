/*
 * Values that are probably one value written two ways: "Hydrabad" and "Hyderabad", "new delhi" and
 * "New Delhi". They split counts, pivots and look-ups. Found among a column's distinct values; each is
 * offered as a Replace (the rarer spelling into the common one), never applied by itself.
 */

export interface Alike {
  /** The rarer spelling, and the one it probably means. */
  from: string
  to: string
  fromRows: number
  toRows: number
}

const norm = (v: string) => v.toLowerCase().replace(/[.'’-]/g, '').replace(/\s+/g, ' ').trim()

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, row[j])
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

/**
 * Pairs to merge, most rows affected first: the same words in another case or spacing, or a typo (one
 * letter off in a short word, two in a long one) of a value at least five times as common. Codes and
 * numbers (anything with a digit) are never paired: INV-0101 and INV-0102 are different invoices.
 */
export function lookAlikes(values: { value: string | null; count: number }[], limit = 4): Alike[] {
  const list = values.filter((v): v is { value: string; count: number } => !!v.value && !!v.value.trim() && !/\d/.test(v.value)).slice(0, 400)
  const out: Alike[] = []
  const used = new Set<string>()
  // Most common first: each value is compared with the more common ones before it.
  const sorted = [...list].sort((a, b) => b.count - a.count)
  for (const [i, minor] of sorted.entries()) {
    if (used.has(minor.value)) continue
    const m = norm(minor.value)
    for (const major of sorted.slice(0, i)) {
      if (used.has(major.value) || major.value === minor.value) continue
      const n = norm(major.value)
      const same = m === n
      const max = n.length >= 8 ? 2 : n.length >= 4 ? 1 : 0
      const typo = !same && max > 0 && m[0] === n[0] && major.count >= minor.count * 5 && distance(m, n, max) <= max
      if (same || typo) {
        out.push({ from: minor.value, to: major.value, fromRows: minor.count, toRows: major.count })
        used.add(minor.value)
        break
      }
    }
  }
  return out.sort((a, b) => b.fromRows - a.fromRows).slice(0, limit)
}
