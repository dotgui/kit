/**
 * C — Consistent. Does the file agree with itself?
 *
 * Reads gui-parser's resolved tree + token provenance (node.tokens map, leaf
 * .token on fills/borders/effects, node.textStyle/fillStyle/effectStyle). The
 * provenance is what makes "token or literal?" answerable from a single parse —
 * no second raw parser needed.
 *
 * Scoring is deduction-with-caps, not unbounded per-issue subtraction: a file
 * that repeats one smell 30 times is not 30× worse than one that does it once.
 * Audits are deduped (with a count) for the same reason.
 */
import type { ParsedGUI, ParsedNode } from '../deps'
import { walkParsed } from '../util/walk'
import { distinct, nearDuplicates } from '../util/values'
import type { Audit, LevelResult } from '../types'

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

type Family = 'color' | 'spacing' | 'radius' | 'font-size' | 'size' | 'border-width' | 'other'

const PROP_FAMILY: Record<string, Family> = {
  fill: 'color', color: 'color', background: 'color', 'background-color': 'color',
  'border-color': 'color', stroke: 'color', tint: 'color',
  gap: 'spacing', 'item-spacing': 'spacing', 'row-gap': 'spacing', 'column-gap': 'spacing',
  p: 'spacing', padding: 'spacing', pt: 'spacing', pr: 'spacing', pb: 'spacing', pl: 'spacing',
  'padding-x': 'spacing', 'padding-y': 'spacing',
  radius: 'radius', 'corner-radius': 'radius',
  'font-size': 'font-size',
  w: 'size', h: 'size', 'min-width': 'size', 'max-width': 'size', 'min-height': 'size', 'max-height': 'size',
  'border-width': 'border-width', 'stroke-width': 'border-width',
}
const COVERAGE_FAMILIES = new Set<Family>(['color', 'spacing', 'font-size', 'radius'])
const NUMERIC_FAMILIES = new Set<Family>(['spacing', 'radius', 'font-size', 'size', 'border-width'])
const propFamily = (k: string): Family => PROP_FAMILY[k] ?? 'other'

function nameFamily(name: string): Family {
  const n = name.toLowerCase()
  if (/(^|[-_])(radius|corner)([-_]|$)/.test(n)) return 'radius'
  if (/(^|[-_])(color|colour|fill|bg|background|border|stroke)([-_]|$)/.test(n)) return 'color'
  if (/font[-_]?size/.test(n)) return 'font-size'
  if (/(^|[-_])(space|spacing|gap|pad|padding|margin|inset)([-_]|$)/.test(n)) return 'spacing'
  return 'other'
}

function nameVerdict(name: string): 'pass' | 'weak' | 'fail' {
  const n = name.toLowerCase()
  if (/^\d/.test(n) || /(px|rem|em|pt)$/.test(n)) return 'fail'
  if (/^(red|green|blue|black|white|gray|grey|yellow|orange|purple|pink|cyan|magenta|brown|teal)$/.test(n)) return 'fail'
  if (/-\d+$/.test(n) || /^[a-z]+\d+$/.test(n)) return 'fail'
  if (n.length < 3) return 'fail'
  return n.split('-').filter(Boolean).length >= 3 ? 'pass' : 'weak'
}

/** Collect every (attribute, token-name) provenance pair on a node + its leaves. */
function nodeRefs(node: ParsedNode): Array<{ field: Family; token: string }> {
  const out: Array<{ field: Family; token: string }> = []
  const tokens = node.tokens as Record<string, string> | undefined
  if (tokens) for (const [attr, tok] of Object.entries(tokens)) out.push({ field: propFamily(attr), token: tok })
  const ap = node.appearance
  if (ap) {
    for (const f of ap.fills || []) if (f.token) out.push({ field: 'color', token: f.token })
    for (const b of ap.borders || []) if (b.token) out.push({ field: 'color', token: b.token })
    for (const e of ap.effects || []) if (e.token) out.push({ field: 'color', token: e.token })
  }
  return out
}

export function scoreConsistent(parsed: ParsedGUI): LevelResult {
  const tokenDefs = parsed.tokenDefs || {}
  const nodes = walkParsed(parsed.root)

  // --- gather ---
  const referenced = new Set<string>()
  let coverageBacked = 0
  let coverageTotal = 0
  const spacing: number[] = []
  const radii: number[] = []
  const fontSizes: number[] = []
  const colors: string[] = []
  const misuse: Array<{ token: string; defined: Family | 'color' | 'number' | 'string'; used: Family }> = []

  for (const { node } of nodes) {
    const refs = nodeRefs(node)
    for (const r of refs) {
      referenced.add(r.token)
      const def = tokenDefs[r.token]
      if (def && r.field !== 'other') {
        if (def.type === 'color' && NUMERIC_FAMILIES.has(r.field)) misuse.push({ token: r.token, defined: 'color', used: r.field })
        else if (def.type === 'number' && r.field === 'color') misuse.push({ token: r.token, defined: 'number', used: r.field })
        else {
          const nf = nameFamily(r.token)
          if (NUMERIC_FAMILIES.has(r.field) && NUMERIC_FAMILIES.has(nf) && nf !== r.field)
            misuse.push({ token: r.token, defined: nf, used: r.field })
        }
      }
    }

    // coverage + literal entropy from node attributes
    const tokens = (node.tokens as Record<string, string>) || {}
    for (const [attr, raw] of Object.entries(node)) {
      const fam = propFamily(attr)
      if (fam === 'other') continue
      const backed = tokens[attr] !== undefined
      if (COVERAGE_FAMILIES.has(fam)) { coverageTotal++; if (backed) coverageBacked++ }
      if (backed) continue
      if (typeof raw === 'number') {
        if (fam === 'spacing') spacing.push(raw)
        else if (fam === 'radius') radii.push(raw)
        else if (fam === 'font-size') fontSizes.push(raw)
      } else if (typeof raw === 'string' && fam === 'color') {
        colors.push(raw.toLowerCase())
      }
    }
    // fills as color coverage
    for (const f of node.appearance?.fills || []) {
      if (f.type !== 'color' || f.value === undefined) continue
      coverageTotal++
      if (f.token) coverageBacked++
      else if (typeof f.value === 'string') colors.push(f.value.toLowerCase())
    }
  }

  // --- score: deduction with per-category caps ---
  const audits: Audit[] = []
  let score = 100
  const deduct = (n: number) => { score -= n }

  // token coverage (ratio-based)
  if (coverageTotal > 0) {
    const coverage = coverageBacked / coverageTotal
    if (coverage < 0.6) {
      deduct(Math.min(20, (0.6 - coverage) * 33))
      audits.push({
        check: 'token-coverage', severity: 'warn',
        why: `${Math.round(coverage * 100)}% of fill/gap/font-size/radius values reference tokens; the rest are inline literals`,
        autofixable: false,
      })
    }
  }

  // value entropy (capped per family)
  const entropy = (label: string, values: number[], softCap: number) => {
    if (!values.length) return
    const d = distinct(values)
    if (d.length > softCap) {
      deduct(Math.min(8, (d.length - softCap) * 1.5))
      audits.push({ check: 'value-entropy', severity: 'warn', why: `${d.length} distinct ${label} values (${d.join(', ')}); reuse a small scale`, autofixable: false })
    }
    const nd = nearDuplicates(values)
    if (nd.length) {
      deduct(Math.min(6, nd.length * 2))
      audits.push({ check: 'near-duplicate-value', severity: 'warn', why: `${nd.length} ${label} value(s) sit one step off a more common one (likely drift): ${nd.map(x => `${x.value}≈${x.near}`).join(', ')}`, autofixable: false })
    }
  }
  entropy('spacing', spacing, 6)
  entropy('radius', radii, 4)
  entropy('font-size', fontSizes, 7)
  const colorCount = new Set(colors).size
  if (colorCount > 12) {
    deduct(Math.min(8, (colorCount - 12)))
    audits.push({ check: 'value-entropy', severity: 'warn', why: `${colorCount} distinct inline color values; consider consolidating into tokens`, autofixable: false })
  }

  // dead tokens (capped)
  const dead = Object.keys(tokenDefs).filter(n => !referenced.has(n))
  if (dead.length) {
    deduct(Math.min(10, dead.length * 2))
    audits.push({ check: 'token-usage-coherence', severity: 'info', why: `${dead.length} defined token(s) never referenced (dead): ${dead.slice(0, 6).join(', ')}${dead.length > 6 ? '…' : ''}`, autofixable: false })
  }

  // semantic misuse (capped; the most serious smell)
  if (misuse.length) {
    const uniq = [...new Map(misuse.map(m => [`${m.token}:${m.used}`, m])).values()]
    deduct(Math.min(30, uniq.length * 6))
    for (const m of uniq.slice(0, 5)) {
      audits.push({ check: 'token-semantic-misuse', severity: 'error', token: `$${m.token}`, 'defined-as': m.defined, 'used-on': m.used, why: `${m.defined} token used on a ${m.used} property`, autofixable: false })
    }
    if (uniq.length > 5) audits.push({ check: 'token-semantic-misuse', severity: 'error', why: `…and ${uniq.length - 5} more token misuse(s)`, autofixable: false })
  }

  // naming coherence (capped)
  const badNames = Object.keys(tokenDefs).filter(n => nameVerdict(n) === 'fail')
  if (badNames.length) {
    deduct(Math.min(10, badNames.length * 2))
    audits.push({ check: 'token-naming-coherence', severity: 'warn', why: `${badNames.length} token name(s) are meaningless/appearance-based/enumerated (want category-property-variant): ${badNames.slice(0, 6).join(', ')}${badNames.length > 6 ? '…' : ''}`, autofixable: false })
  }

  return { score: clamp(score), audits }
}
