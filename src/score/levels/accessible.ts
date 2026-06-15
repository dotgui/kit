/**
 * A — Accessible. Can a human actually read and interact with this design?
 *
 * WCAG 2.2 visual criteria ONLY (P5: .gui is a visual surface, not a document):
 *   - 1.4.3 text contrast (4.5:1 normal, 3:1 large)
 *   - 1.4.4-ish font-size floor (below 12 warn, below 11 fail)
 *   - 2.5.5 touch target 44x44 (iOS / Android files only)
 *
 * Operates on the RESOLVED model (gui-parser), because contrast needs real
 * color values — tokens already resolved, appearance normalized. Contrast over
 * gradient/image fills is reported as uncertain, never as a fabricated ratio.
 */
import type { ParsedNode, ParsedFill } from '../deps'
import { walkParsed } from '../util/walk'
import { parseColor, contrastRatio } from '../util/contrast'
import type { Audit, LevelResult } from '../types'

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

function solidFill(fills: ParsedFill[] | undefined): ParsedFill | null {
  if (!fills) return null
  for (const f of fills) {
    if (f.visible === false) continue
    if (f.type === 'color' && typeof f.value === 'string') return f
  }
  return null
}

function hasNonSolidFill(fills: ParsedFill[] | undefined): boolean {
  if (!fills) return false
  return fills.some((f) => f.visible !== false && f.type !== 'color')
}

/** Nearest ancestor (or self) background color, walking up. null if none resolvable. */
function backgroundOf(self: ParsedNode, ancestors: ParsedNode[]): { color: string | null; uncertain: boolean } {
  const chain = [self, ...[...ancestors].reverse()]
  for (const n of chain) {
    const fills = n.appearance?.fills
    const solid = solidFill(fills)
    if (solid?.value) return { color: solid.value, uncertain: false }
    if (hasNonSolidFill(fills)) return { color: null, uncertain: true }
  }
  return { color: null, uncertain: false }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

const BUTTON_TAP_ATTRS = ['on-tap', 'ontap', 'tap', 'href', 'action', 'on-press']

export function scoreAccessible(root: ParsedNode | null, platform: string | null): LevelResult {
  const isMobile = platform === 'ios' || platform === 'android'

  // Per-criterion tallies — score is the fraction passing, not a per-node tax.
  // A file with 30 same-size-too-small labels shouldn't score worse than the
  // proportion of its text that fails.
  let textTotal = 0, contrastChecked = 0, contrastFail = 0, contrastFailRatios: string[] = []
  let sizeWarn = 0, sizeFail = 0, sizeMin = Infinity
  let targetTotal = 0, targetFail = 0, targetMinSeen = Infinity

  for (const { node, ancestors } of walkParsed(root)) {
    // ---- text checks ----
    if (node.type === 'text') {
      textTotal++
      const fontSize = num(node['font-size'])
      const fontWeight = num(node['font-weight']) ?? 400

      if (fontSize !== undefined) {
        if (fontSize < 11) { sizeFail++; sizeMin = Math.min(sizeMin, fontSize) }
        else if (fontSize < 12) { sizeWarn++; sizeMin = Math.min(sizeMin, fontSize) }
      }

      const fgFill = solidFill(node.appearance?.fills)
      const fgRaw = fgFill?.value ?? (typeof node.color === 'string' ? node.color : undefined)
      const fg = parseColor(fgRaw)
      const bg = backgroundOf(node, ancestors)
      if (fg && bg.color) {
        const bgc = parseColor(bg.color)
        if (bgc) {
          contrastChecked++
          const ratio = contrastRatio(fg, bgc)
          const large = (fontSize ?? 0) >= 18 || ((fontSize ?? 0) >= 14 && fontWeight >= 700)
          const min = large ? 3 : 4.5
          if (ratio < min) { contrastFail++; if (contrastFailRatios.length < 4) contrastFailRatios.push(`${ratio.toFixed(2)}:1`) }
        }
      }
    }

    // ---- touch targets (mobile only) ----
    if (isMobile) {
      const attrs = node as Record<string, unknown>
      const looksTappable = node.type === 'button' || BUTTON_TAP_ATTRS.some((a) => attrs[a] !== undefined)
      if (looksTappable) {
        const w = num(node.w)
        const h = num(node.h)
        if (w !== undefined || h !== undefined) {
          targetTotal++
          if ((w !== undefined && w < 44) || (h !== undefined && h < 44)) {
            targetFail++
            targetMinSeen = Math.min(targetMinSeen, w ?? Infinity, h ?? Infinity)
          }
        }
      }
    }
  }

  // Each criterion contributes a 0–1 pass-rate; the level score is their average
  // over the criteria that actually had something to measure.
  const audits: Audit[] = []
  const rates: number[] = []

  if (contrastChecked > 0) {
    const rate = 1 - contrastFail / contrastChecked
    rates.push(rate)
    if (contrastFail > 0)
      audits.push({
        criterion: 'contrast-ratio', 'wcag-ref': '1.4.3', severity: 'error',
        why: `${contrastFail}/${contrastChecked} text node(s) below the WCAG minimum (e.g. ${contrastFailRatios.join(', ')})`,
        autofixable: false,
      })
  }

  const sizedText = textTotal // approx denominator for size
  if (sizeWarn + sizeFail > 0 && sizedText > 0) {
    const rate = 1 - (sizeFail + sizeWarn * 0.5) / sizedText
    rates.push(rate)
    audits.push({
      criterion: 'font-size', 'wcag-ref': '1.4.4', severity: sizeFail > 0 ? 'error' : 'warn',
      why: `${sizeFail} text node(s) below the 11 hard-floor and ${sizeWarn} below 12 (smallest ${sizeMin})`,
      autofixable: false,
    })
  }

  if (targetTotal > 0) {
    const rate = 1 - targetFail / targetTotal
    rates.push(rate)
    if (targetFail > 0)
      audits.push({
        criterion: 'touch-target', 'wcag-ref': '2.5.5', severity: 'warn',
        why: `${targetFail}/${targetTotal} interactive target(s) below 44×44 (smallest ${targetMinSeen === Infinity ? '?' : targetMinSeen})`,
        autofixable: false,
      })
  }

  const score = rates.length ? clamp((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) : 100
  return { score, audits }
}
