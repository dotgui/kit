/**
 * @dotgui/kit — the dotgui toolkit in one package.
 *
 * This root surface exports only the canonical types. Behavior lives in subpaths
 * so consumers bundle only what they import:
 *
 *   @dotgui/kit/parser      parse .guix → resolved model
 *   @dotgui/kit/validate    validate markup against the schema
 *   @dotgui/kit/lint        conventions the schema does not enforce
 *   @dotgui/kit/score       CCAC quality scorer (local, zero-AI)
 *   @dotgui/kit/package     pack / unpack .gui
 *   @dotgui/kit/rasterize   images, drawn by the Rust renderer (@dotgui/render)
 *
 * Drawing is not here: the one renderer is @dotgui/render, natively, in Node,
 * and on a <gui-canvas> in the browser.
 */
export * from './schema/types'
