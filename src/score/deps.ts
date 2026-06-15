/**
 * The one place gui-score reaches outside its own module. Inside the kit these
 * are sibling modules; routing every cross-module import through here keeps the
 * levels and gate free of path noise and the coupling visible in one file.
 *
 *   validate   — the Valid half of the gate (schema)
 *   parseXml   — the one parser: the resolved model + token/style provenance,
 *                which is all the levels and the gate need
 *
 * The optimizer (Clean's diff signal) is NOT imported here. It is injected into
 * score() as an optional capability (ScoreContext.optimize), so the kit never
 * hard-depends on the not-yet-stable optimizer.
 */
export { validate } from '../schema/validate'
export type { ValidationResult, ValidationError } from '../schema/validate'

export { parseXml } from '../parser'
export type { ParsedGUI, ParsedNode, ParsedFill, ParsedAppearance, TokenDef } from '../parser'
