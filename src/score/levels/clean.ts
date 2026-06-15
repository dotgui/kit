/**
 * C — Clean. How much unnecessary work does the file contain?
 *
 * The optimizer is the format's own definition of structural messiness. We run
 * it and read its diff as a quality signal, not a cleanup log: if it barely
 * touches the file, the file is clean; if it rewrites large portions, it isn't.
 *
 * Supplementary, direct ratios (not covered by optimizer stats): how much of
 * the layout leans on absolute x/y positioning instead of auto-layout.
 *
 * NOTE: the optimizer currently reports AGGREGATE stats, not a per-rule fired
 * list. So Clean audits are category-level for now. Enriching the optimizer to
 * emit per-rule findings (with node paths + autofix flags) is a clean follow-up
 * that this level will consume without changing shape. Tracked in QUALITY.md.
 */
import { type ParsedNode } from '../deps'
import { walkParsed } from '../util/walk'
import type { Audit, LevelResult, Optimize } from '../types'

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

export function scoreClean(xml: string, root: ParsedNode | null, optimize: Optimize): LevelResult {
  const audits: Audit[] = []

  const nodes = walkParsed(root)
  const total = Math.max(1, nodes.length)

  let result
  try {
    result = optimize(xml)
  } catch {
    // If the optimizer cannot run, we cannot measure Clean honestly.
    return { score: 0, audits: [{ severity: 'warn', why: 'optimizer could not process the file; Clean not measured' }] }
  }

  const s = result.stats
  // Structural ops the optimizer would perform, as a fraction of the tree.
  const ops = s.removedNodes + s.flattenedWrappers + s.deduplicatedStyles
  let score = 100 * (1 - ops / total)

  if (s.removedNodes > 0)
    audits.push({
      rule: 'remove-dead-nodes',
      severity: 'warn',
      why: `${s.removedNodes} node(s) the optimizer removes as non-rendering or empty`,
      autofixable: true,
    })
  if (s.flattenedWrappers > 0)
    audits.push({
      rule: 'flatten-wrappers',
      severity: 'warn',
      why: `${s.flattenedWrappers} redundant wrapper(s) adding nesting with no layout or visual purpose`,
      autofixable: true,
    })
  if (s.deduplicatedStyles > 0)
    audits.push({
      rule: 'deduplicate-styles',
      severity: 'info',
      why: `${s.deduplicatedStyles} duplicated style group(s) the optimizer would collapse`,
      autofixable: true,
    })

  // Supplementary: absolute positioning. A node carrying explicit x AND y is
  // pinned rather than laid out. Some are legitimate (overlays), so this is a
  // gentle penalty, not a hard one.
  let absolute = 0
  for (const { node } of nodes) {
    if (node.x !== undefined && node.y !== undefined) absolute++
  }
  const absRatio = absolute / total
  if (absRatio > 0.25) {
    score -= Math.min(20, (absRatio - 0.25) * 80)
    audits.push({
      check: 'auto-layout-coverage',
      severity: 'warn',
      why: `${absolute}/${total} nodes use absolute x/y positioning instead of auto-layout`,
      autofixable: false,
    })
  }

  return { score: clamp(score), audits }
}
