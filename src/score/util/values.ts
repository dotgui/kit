/**
 * Value-entropy helpers for Consistent. A coherent file draws from a small,
 * deliberate set of spacing / size / radius values. Many distinct values, or
 * lone near-duplicates (a `13` sitting among `8 / 16 / 24`), are smells.
 */

/** Distinct numeric values, sorted. */
export function distinct(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

export interface NearDuplicate {
  value: number
  near: number
  delta: number
}

/**
 * Find lone outliers that sit suspiciously close to a more popular value.
 * A value is flagged when it occurs rarely and is within `tolerance` of a
 * value that occurs more often — i.e. it looks like a typo of an established
 * step, not a deliberate new one.
 */
export function nearDuplicates(values: number[], tolerance = 2): NearDuplicate[] {
  const freq = new Map<number, number>()
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1)

  const uniq = [...freq.keys()]
  const out: NearDuplicate[] = []
  for (const v of uniq) {
    const count = freq.get(v)!
    for (const other of uniq) {
      if (other === v) continue
      const delta = Math.abs(other - v)
      if (delta > 0 && delta <= tolerance && (freq.get(other)! > count || (freq.get(other)! === count && other < v))) {
        out.push({ value: v, near: other, delta })
        break
      }
    }
  }
  return out
}

/** Pull a leading number out of a value string, e.g. "16", "16px", "16 24" -> 16. null if none. */
export function leadingNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const m = raw.trim().match(/^-?\d+(\.\d+)?/)
  if (!m) return null
  const n = parseFloat(m[0])
  return Number.isNaN(n) ? null : n
}
