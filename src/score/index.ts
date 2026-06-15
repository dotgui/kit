/**
 * gui-score — reference implementation of the dotgui CCACT quality model.
 *
 * Authority is core/spec/QUALITY.md, not this code. This implements the three
 * LOCAL levels (Clean, Consistent, Accessible). Conventional and Trend require
 * the gui.farm corpus and are reported as NA — absent with a reason, never
 * zeroed and never faked.
 *
 *   score(xml)            score a bare .guix string
 *   scorePackage(bytes)   score a .gui package (zip): full asset-intact checking
 */
import './util/dom' // installs a global DOMParser (headless) before the parser runs
import { strFromU8 } from 'fflate'
import { unpack, isZip } from '../package'
import { parseXml } from './deps'
import { runGate } from './gate'
import { scoreClean } from './levels/clean'
import { scoreConsistent } from './levels/consistent'
import { scoreAccessible } from './levels/accessible'
import type { ScoreOutput, Optimize } from './types'

const NA = (reason: string) => ({ status: 'na' as const, reason })

export interface ScoreContext {
  /** Packaged asset paths (e.g. "assets/hero.webp"); enables asset-intact checks. */
  assetPaths?: Set<string>
  /**
   * The optimizer, injected. Clean uses its diff as a cleanliness signal. The kit
   * does not depend on gui-optimizer; if omitted, Clean is reported NA (absent
   * with a reason), per the CCACT doctrine — never zeroed, never faked.
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
    clean: ctx.optimize
      ? scoreClean(xml, parsed.root, ctx.optimize)
      : NA('Clean requires the optimizer (inject via ScoreContext.optimize); not supplied'),
    consistent: scoreConsistent(parsed),
    accessible: scoreAccessible(parsed.root, parsed.platform),
    conventional: NA('requires the gui.farm corpus (remote)'),
    trend: NA('requires the gui.farm corpus with temporal metadata (remote)'),
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
