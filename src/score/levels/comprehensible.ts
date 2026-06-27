/**
 * C — Comprehensible. How AI-ready is this file as semantics — how much meaning
 * does it carry that an agent can translate into dev-ready code with context?
 *
 * The carrier of that meaning is the `role=` attribute (RFC-0041). A role names
 * what a structure IS — nav-bar, tab-bar, card — the way <nav> does in HTML:
 * self-description an agent reads without guessing.
 *
 * Scored by REACH-COVERAGE. Each role declares a `reach` (core/roles/, mirrored
 * in roleReach.ts) — how far down its own subtree its meaning documents the
 * content: `full` for self-contained widgets (a dropdown's items are all the
 * dropdown), 2 for two-level structures (table row→cell), 1 for host surfaces
 * (a card frames one level; its payload carries its own roles). A node is
 * DOCUMENTED if it sits within the reach of some roled ancestor-or-self.
 * Comprehensible is the fraction of content nodes that are documented.
 *
 * No inference, no confidence, no coverage-by-guessing: roles are read at FACE
 * VALUE and reach is read from the catalog. Plain nodes are not "missing" a role
 * — they are simply outside any role's reach, which is a fact about the tree, not
 * a guess about what should have been tagged. The audits are a plain inventory of
 * the declared roles — { role, path } — facts, not findings.
 *
 * The root element (the canvas wrapper) is excluded from the denominator: it is
 * scaffolding, not taggable content. A still-roled ancestor at the root level
 * (e.g. a top-level <col role="...">) still documents its descendants.
 */
import { type ParsedNode } from '../deps'
import { walkParsed } from '../util/walk'
import { reachOf } from '../roleReach'
import type { Audit, LevelResult } from '../types'

/** The role value on a node, or undefined if it carries none. */
function roleOf(node: ParsedNode): string | undefined {
  const r = node.role
  return typeof r === 'string' && r.trim() !== '' ? r.trim() : undefined
}

/**
 * Is this node documented? True if the node itself has a role, or some ancestor
 * `d` levels up has a role whose `reach` covers distance `d`. `ancestors` is
 * ordered root→parent, so the immediate parent is distance 1.
 */
function isDocumented(node: ParsedNode, ancestors: ParsedNode[]): boolean {
  if (roleOf(node)) return true
  for (let d = 1; d <= ancestors.length; d++) {
    const ancestor = ancestors[ancestors.length - d]
    const role = roleOf(ancestor)
    if (role && reachOf(role) >= d) return true
  }
  return false
}

export function scoreComprehensible(root: ParsedNode | null): LevelResult {
  const visits = walkParsed(root)

  // Inventory: one { role, path } fact per declared role (root included).
  const audits: Audit[] = []
  for (const { node, path } of visits) {
    const role = roleOf(node)
    if (role) audits.push({ role, path })
  }

  // Coverage over content nodes — every node except the root canvas wrapper.
  const content = visits.slice(1)
  if (content.length === 0) return { score: 0, audits }

  let documented = 0
  for (const { node, ancestors } of content) {
    if (isDocumented(node, ancestors)) documented++
  }

  const score = Math.round((100 * documented) / content.length)
  return { score, audits }
}
