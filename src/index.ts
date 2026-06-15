/**
 * @dotgui/kit — the dotgui engine in one package.
 *
 * This root surface exports only the canonical types. Behavior lives in subpaths
 * so consumers bundle only what they import:
 *
 *   @dotgui/kit/parser      parse .guix → resolved model
 *   @dotgui/kit/validate    validate markup against the schema
 *   @dotgui/kit/render      render the resolved model → HTML (browser-clean)
 *   @dotgui/kit/score       CCACT quality scorer (optimizer injected)
 */
export * from './schema/types'
