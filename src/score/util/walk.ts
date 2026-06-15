/**
 * Tree traversal over the gui-parser model (ParsedNode): typed, token/asset-
 * resolved, with token/style provenance and a normalized `appearance`. Yields
 * the node, an XPath-style path, and the ancestor chain — so a level can walk up
 * for context (e.g. nearest background fill).
 */
import type { ParsedNode } from '../deps'

export interface ParsedVisit {
  node: ParsedNode
  path: string
  ancestors: ParsedNode[]
}

export function walkParsed(root: ParsedNode | null): ParsedVisit[] {
  const out: ParsedVisit[] = []
  if (!root) return out
  const recurse = (node: ParsedNode, path: string, ancestors: ParsedNode[]) => {
    out.push({ node, path, ancestors })
    const counts: Record<string, number> = {}
    for (const child of node.children || []) {
      const t = child.type
      const idx = counts[t] ?? 0
      counts[t] = idx + 1
      recurse(child, `${path} > ${t}[${idx}]`, [...ancestors, node])
    }
  }
  recurse(root, root.type || 'gui', [])
  return out
}
