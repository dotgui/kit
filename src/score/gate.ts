/**
 * The gate. Two binary conditions that must hold before any scoring (QUALITY.md):
 *
 *   Valid  — conforms to the dotgui spec. validate.ts is the authority.
 *   Intact — every reference resolves: $token names are declared, asset src
 *            values point to real packaged files, instance component ids match
 *            a declared component.
 *
 * Works off the gui-parser tree. The parser resolves declared tokens away, so
 * any value still containing a `$ref` is an UNDECLARED token — that's the intact
 * signal, no raw second parse required. Asset src is left unresolved here
 * (score never passes an assetMap), so it can be checked against the package.
 */
import { validate, type ParsedGUI, type ParsedNode } from './deps'
import { walkParsed } from './util/walk'
import type { GateFailure, GateDetail } from './types'

const TOKEN_REF = /\$[A-Za-z_][A-Za-z0-9_-]*/g

export interface GateInput {
  xml: string
  parsed: ParsedGUI
  /** Packaged asset paths, e.g. "assets/hero.webp". Empty when scoring bare XML. */
  assetPaths: Set<string>
  /** Whether asset references can be checked (false when no package context). */
  assetsKnown: boolean
}

/** Returns null when the gate passes, or a GateFailure when it does not. */
export function runGate(input: GateInput): GateFailure | null {
  // Valid — schema conformance.
  const v = validate(input.xml)
  if (!v.valid) {
    return {
      error: 'invalid',
      details: v.errors.map((e) => ({ type: 'schema', path: e.path, reason: `${e.code}: ${e.message}` })),
    }
  }

  // Intact — referential integrity.
  const details: GateDetail[] = []
  const componentIds = new Set(Object.keys(input.parsed.components || {}))

  const scan = (val: unknown, path: string) => {
    if (typeof val !== 'string' || val.indexOf('$') === -1) return
    const refs = val.match(TOKEN_REF)
    if (!refs) return
    for (const ref of refs) {
      details.push({ ref, type: 'token', path, reason: 'token not declared in <tokens> block' })
    }
  }

  for (const { node, path } of walkParsed(input.parsed.root)) {
    // Undeclared $token refs surviving resolution, on any node attribute.
    for (const [key, val] of Object.entries(node)) {
      if (key === 'children' || key === 'appearance' || key === 'segments' || key === 'tokens') continue
      scan(val, path)
    }
    // ...and inside resolved appearance leaves.
    const ap = node.appearance
    if (ap) {
      for (const f of ap.fills || []) for (const [k, vv] of Object.entries(f)) { if (k !== 'tokens') scan(vv, path) }
      for (const b of ap.borders || []) for (const [k, vv] of Object.entries(b)) { if (k !== 'tokens') scan(vv, path) }
      for (const e of ap.effects || []) for (const [k, vv] of Object.entries(e)) { if (k !== 'tokens') scan(vv, path) }
    }

    // Asset src must resolve to a packaged file ($token and URLs excepted).
    if (input.assetsKnown) {
      const src = (node as ParsedNode).src
      const external = typeof src === 'string' && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:'))
      if (typeof src === 'string' && src && !src.startsWith('$') && !external && !input.assetPaths.has(src)) {
        details.push({ ref: src, type: 'asset', path, reason: 'asset src does not resolve to a packaged file' })
      }
    }

    // instance -> declared component.
    if (node.type === 'instance') {
      const cid = (node as ParsedNode).component
      if (typeof cid === 'string' && cid && !componentIds.has(cid)) {
        details.push({ ref: cid, type: 'component', path, reason: 'instance component id matches no declared <component>' })
      }
    }
  }

  if (details.length) return { error: 'intact', details }
  return null
}
