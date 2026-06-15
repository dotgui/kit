/**
 * The output shapes of gui-score. These mirror core/spec/QUALITY.md exactly:
 * every scored level emits the same envelope `{ score, audits }`; the audit
 * objects carry level-specific fields on top of a common spine.
 */

export type Severity = 'error' | 'warn' | 'info'

/**
 * One finding. The spine (severity/path/why/autofixable) is shared; each level
 * adds its own fields (rule, check, criterion, token, computed, ...). QUALITY.md
 * fixes the shape of the envelope, not the contents of the audit.
 */
export interface Audit {
  severity?: Severity
  path?: string
  why?: string
  autofixable?: boolean
  [key: string]: unknown
}

export interface LevelResult {
  /** 0–100. */
  score: number
  audits: Audit[]
}

/**
 * Clean's diff signal. The optimizer is a standalone, not-yet-stable package, so
 * the kit does not depend on it — callers inject it via ScoreContext.optimize.
 * Only the aggregate stats Clean reads are typed here.
 */
export interface OptimizeStats {
  removedNodes: number
  flattenedWrappers: number
  deduplicatedStyles: number
}
export interface OptimizeResult {
  stats: OptimizeStats
}
export type Optimize = (xml: string) => OptimizeResult

/** A level that cannot run locally. Not zeroed, not faked — absent, with a reason. */
export interface NaLevel {
  status: 'na'
  reason: string
}

/** A single broken reference or schema error from the gate. */
export interface GateDetail {
  ref?: string
  type?: string
  path?: string
  reason: string
}

/** The gate failed. There is no report — per QUALITY.md, an invalid or broken file is rejected, not scored. */
export interface GateFailure {
  error: 'invalid' | 'intact'
  details: GateDetail[]
}

/** A passing gate followed by the CCACT report. CT are NA until gui.farm exists. */
export interface ScoreReport {
  clean: LevelResult | NaLevel
  consistent: LevelResult
  accessible: LevelResult
  conventional: NaLevel
  trend: NaLevel
}

export type ScoreOutput = ScoreReport | GateFailure

export function isGateFailure(out: ScoreOutput): out is GateFailure {
  return 'error' in out
}
