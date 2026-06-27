/**
 * gui-score — reference implementation of the dotgui CCAC quality model.
 *
 * Authority is core/spec/QUALITY.md, not this code. All four levels are local,
 * deterministic and zero-AI — there is no external service and no corpus. The
 * score measures the FILE, not the design. Clean, Consistent and Accessible run
 * on the parsed tree; Comprehensible scores how AI-ready the file is as semantics
 * via reach-coverage — each DECLARED role= documents its subtree as far as its
 * catalog `reach` allows, and the score is the fraction of nodes so documented
 * (face value, no inference; resemblance matching is the optimizer's job).
 *
 *   score(xml)            score a bare .guix string
 *   scorePackage(bytes)   score a .gui package (zip): full asset-intact checking
 */
import { strFromU8 } from 'fflate'
import { unpack, isZip } from '../package'
import { parseXml } from './deps'
import { runGate } from './gate'
import { scoreClean } from './levels/clean'
import { scoreConsistent } from './levels/consistent'
import { scoreAccessible } from './levels/accessible'
import { scoreComprehensible } from './levels/comprehensible'
import type { ScoreOutput, Optimize } from './types'

export interface ScoreContext {
  /** Packaged asset paths (e.g. "assets/hero.webp"); enables asset-intact checks. */
  assetPaths?: Set<string>
  /**
   * @deprecated No longer used. Clean is now a standalone analysis over the
   * parsed tree (it does not run the optimizer). Accepted and ignored for
   * back-compat with callers that still inject it.
   */
  optimize?: Optimize
}

export function score(xml: string, ctx: ScoreContext = {}): ScoreOutput {
  // Resolved model — tokens/assets resolved, normalized appearance.
  const parsed = parseXml(xml)
  if (!parsed) {
    return { error: 'invalid', details: [{ type: 'parser', reason: 'file could not be parsed as dotgui markup' }] }
  }

  // Gate first.
  const gate = runGate({
    xml,
    parsed,
    assetPaths: ctx.assetPaths ?? new Set(),
    assetsKnown: ctx.assetPaths !== undefined,
  })
  if (gate) return gate

  return {
    clean: scoreClean(parsed.root),
    consistent: scoreConsistent(parsed),
    accessible: scoreAccessible(parsed.root, parsed.platform),
    comprehensible: scoreComprehensible(parsed.root),
  }
}

export function scorePackage(bytes: Uint8Array, ctx: ScoreContext = {}): ScoreOutput {
  // A raw .guix (not a zip) — score directly, assets unknown (gate stays lenient).
  if (!isZip(bytes)) {
    return score(strFromU8(bytes), ctx)
  }

  let pkg
  try {
    pkg = unpack(bytes)
  } catch {
    return { error: 'invalid', details: [{ type: 'package', reason: '.gui package could not be read' }] }
  }

  const assetPaths = new Set(Object.keys(pkg.assets))
  return score(pkg.xml, { ...ctx, assetPaths })
}

export type { ScoreOutput, ScoreReport, GateFailure, LevelResult, Audit } from './types'
export { isGateFailure } from './types'
