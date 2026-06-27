/**
 * C — Clean. How much structure does the file carry that costs without
 * contributing to the render — *and that can be safely removed or replaced*?
 *
 * Clean is a SIGNAL, not an action. It analyses the tree and reports; it never
 * mutates and it does not depend on the optimizer. The optimizer is the actor
 * that later applies the fixes Clean marks safe.
 *
 * The two-gate test — a node is "dead weight" only if BOTH hold:
 *   1. renders nothing (no paint; or visible=false / opacity=0 / zero-size /
 *      empty text), and
 *   2. removing it is safe — it neither breaks a contract (instance/mask) nor
 *      moves its siblings.
 *
 * Gate #2 is parent-aware. Under an auto-layout parent a node may be invisible
 * yet load-bearing: opacity=0 is visibility:hidden — it still holds its slot, so
 * removing it collapses the layout. Such a node is NOT dead weight; it is a
 * spacer hack and is reclassified (bucket C), never deleted.
 *
 * Buckets scored: A dead weight · B redundant structure · C hard-way layout
 * (absolute positioning + reclassified spacer hacks). Duplication is Consistent's
 * concern; pure value-formatting has no render impact and is not scored here.
 */
import { type ParsedNode } from '../deps'
import { walkParsed } from '../util/walk'
import { leadingNumber } from '../util/values'
import type { Audit, LevelResult } from '../types'

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

/** Parents that distribute space — children are load-bearing on the main axis. */
const AUTO_LAYOUT = new Set(['row', 'col', 'grid'])
/** Plain containers that can wrap without a layout role of their own. */
const PLAIN_CONTAINERS = new Set(['frame', 'group'])

// The parser coerces attribute values: presence attrs (mask/clip/abs) arrive as
// booleans, numerics (opacity/w/h) as numbers, the rest as strings. Read defensively.
const isTrue = (v: unknown) => v === true || v === 'true'

function isAutoLayout(node: ParsedNode | undefined): boolean {
  if (!node) return false
  if (AUTO_LAYOUT.has(node.type)) return true
  return node.type === 'stack' && typeof node.direction === 'string' && node.direction !== 'none'
}

/** Read a numeric attribute that may arrive as a number or a "16"/"16px" string. */
function numAttr(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return leadingNumber(v) ?? undefined
  return undefined
}

/** A node whose removal would break a component contract or a mask. Never debt. */
function isProtected(node: ParsedNode): boolean {
  return (
    node.type === 'instance' ||
    node['component-ref'] !== undefined ||
    isTrue(node.mask) ||
    (node.children ?? []).some((c) => isTrue(c.mask))
  )
}

/** No paint of its own: no fill, border, or effect, and not a clip. */
function isVisuallyEmpty(node: ParsedNode): boolean {
  const ap = node.appearance
  const painted =
    !!ap && (((ap.fills?.length ?? 0) > 0) || ((ap.borders?.length ?? 0) > 0) || ((ap.effects?.length ?? 0) > 0))
  return !painted && !isTrue(node.clip)
}

type Deadness = 'visible-false' | 'opacity-zero' | 'zero-size' | 'empty-text' | null

/** Why — if at all — this node renders nothing. The reason drives the safety gate. */
function deadnessReason(node: ParsedNode): Deadness {
  if (node.visible === false || node.visible === 'false') return 'visible-false'
  if (numAttr(node.opacity) === 0) return 'opacity-zero'
  if (node.type === 'text') {
    const hasSeg = (node.segments?.length ?? 0) > 0
    const v = typeof node.value === 'string' ? node.value : undefined
    if (!hasSeg && (v === undefined || v.trim() === '')) return 'empty-text'
  }
  const zero = (x: unknown) => x !== 'fill' && x !== 'hug' && numAttr(x) === 0
  if (zero(node.w) || zero(node.h)) return 'zero-size'
  return null
}

/** True when this node is absolutely positioned — pinned, not laid out. */
function isAbsolute(node: ParsedNode): boolean {
  return isTrue(node.abs) || (node.x !== undefined && node.y !== undefined)
}

/** Gap contribution of an auto-layout parent: 'auto' (space-between) is load-bearing. */
function parentGap(parent: ParsedNode | undefined): number {
  if (!isAutoLayout(parent)) return 0
  if (parent!.gap === 'auto') return 1
  return numAttr(parent!.gap) ?? 0
}

const subtreeSize = (n: ParsedNode): number =>
  1 + (n.children ?? []).reduce((s, c) => s + subtreeSize(c), 0)

export function scoreClean(root: ParsedNode | null): LevelResult {
  const visits = walkParsed(root)
  const total = Math.max(1, visits.length)
  const audits: Audit[] = []

  let deadWeight = 0 // bucket A — weighted by the subtree it removes
  let redundant = 0 // bucket B — redundant wrappers (one level each)
  let spacerHacks = 0 // bucket C — invisible-but-load-bearing, reclassified
  let protectedDead = 0 // guarded — reported, never charged
  let absolute = 0 // bucket C — absolute x/y positioning

  // When a dead-and-safe node is charged, its whole subtree goes with it — don't
  // also charge its descendants. Track pruned path prefixes and skip beneath them.
  const pruned: string[] = []
  const underPruned = (p: string) => pruned.some((pre) => p === pre || p.startsWith(pre + ' >'))

  for (const { node, path, ancestors } of visits) {
    if (underPruned(path)) continue
    const parent = ancestors[ancestors.length - 1]

    // ── A / C: renders nothing → dead weight, or reclassified spacer hack ──
    const reason = deadnessReason(node)
    if (reason) {
      if (isProtected(node)) {
        protectedDead++
        continue
      }
      const parentAuto = isAutoLayout(parent)
      let safe: boolean
      if (reason === 'opacity-zero')
        safe = !parentAuto // visibility:hidden holds its slot only under auto-layout
      else if (reason === 'zero-size')
        safe = !(parentAuto && parentGap(parent) > 0) // a 0-size child still pulls a gap
      else safe = true // visible-false (display:none) and empty-text leave no slot

      if (safe) {
        const size = subtreeSize(node)
        deadWeight += size
        pruned.push(path)
        audits.push({
          rule: 'dead-weight',
          severity: 'warn',
          path,
          why: `${reason}: renders nothing and is safe to remove${size > 1 ? ` (${size}-node subtree)` : ''}`,
          autofixable: true,
        })
      } else {
        spacerHacks++
        audits.push({
          rule: 'spacer-hack',
          severity: 'warn',
          path,
          why: `${reason} but load-bearing in an auto-layout parent — use gap/padding, not an invisible node`,
          autofixable: false,
        })
      }
      continue
    }

    // ── B: redundant single-child wrapper — contributes nothing. A wrapper that
    // paints, pads, aligns, sizes itself, or is pinned has a real role; exclude it. ──
    const sizes = (x: unknown) => x !== undefined && x !== 'fill' && x !== 'hug'
    if (
      PLAIN_CONTAINERS.has(node.type) &&
      !isProtected(node) &&
      isVisuallyEmpty(node) &&
      node.p === undefined &&
      node.align === undefined &&
      !sizes(node.w) &&
      !sizes(node.h) &&
      !isAbsolute(node) &&
      (node.children?.length ?? 0) === 1
    ) {
      redundant++
      audits.push({
        rule: 'flatten-wrapper',
        severity: 'warn',
        path,
        why: 'single-child wrapper with no visual or layout role',
        autofixable: true,
      })
    }

    // ── C: absolute positioning (a node pinned rather than laid out) ──
    if (isAbsolute(node)) absolute++
  }

  // Impact-weighted debt: dead weight carries its subtree; wrappers and spacer
  // hacks are one node each. Absolute positioning is a separate gentle penalty.
  const debt = deadWeight + redundant + spacerHacks
  let score = 100 * (1 - debt / total)

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

  if (protectedDead > 0)
    audits.push({
      check: 'protected',
      severity: 'info',
      why: `${protectedDead} invisible node(s) left intact — protected as mask/instance/component`,
      autofixable: false,
    })

  return { score: clamp(score), audits }
}
