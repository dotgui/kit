/**
 * gui-parser's parseXml relies on a global DOMParser. In a browser/Figma plugin
 * that exists; in node/bun it does not. Importing this module once installs
 * happy-dom's DOMParser onto globalThis — the same lenient DOM the renderer and
 * CLI use — so scoring works headless. No-op if a DOMParser is already present.
 */
import { Window } from 'happy-dom'

if (typeof (globalThis as Record<string, unknown>).DOMParser === 'undefined') {
  const win = new Window()
  ;(globalThis as Record<string, unknown>).DOMParser = (win as unknown as { DOMParser: unknown }).DOMParser
}
