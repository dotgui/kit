/**
 * Shared DOM helpers for the linter and autofixer. Parses dotgui markup with
 * happy-dom (lenient like the renderer), expanding bare boolean attributes so
 * standard XML parsing accepts them, and serializing back with those booleans
 * collapsed to their bare authoring form.
 */
import { Window } from 'happy-dom'

export type El = any // happy-dom Element

export const BOOLEAN_ATTRS = ['clip', 'mask', 'wrap', 'abs', 'truncate', 'reverse-z']
const BARE_BOOL_RE = new RegExp(`(\\s)(${BOOLEAN_ATTRS.join('|')})(?=\\s|/|>)`, 'g')

export interface ParseResult {
  root: El | null
  win: any
  error?: string
}

export function parseGui(xml: string): ParseResult {
  const sanitized = xml
    .replace(BARE_BOOL_RE, '$1$2="true"')
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;')
  const win = new Window()
  try {
    const doc = new win.DOMParser().parseFromString(sanitized, 'application/xml')
    if (doc.querySelector('parsererror')) return { root: null, win, error: 'markup is not well-formed XML' }
    const root = doc.documentElement
    if (!root || root.tagName !== 'gui') return { root, win, error: `root element must be <gui>, got <${root?.tagName ?? '?'}>` }
    return { root, win }
  } catch (e: any) {
    return { root: null, win, error: `markup is not well-formed XML: ${e?.message ?? e}` }
  }
}

/** Document-order, depth-first list of root + all descendant elements. */
export function walk(root: El): El[] {
  const out: El[] = []
  const visit = (el: El) => { out.push(el); for (const c of Array.from(el.children) as El[]) visit(c) }
  visit(root)
  return out
}

/** Serialize back to markup, collapsing boolean="true" to the bare form. */
export function serialize(win: any, root: El): string {
  let xml = new win.XMLSerializer().serializeToString(root)
  for (const b of BOOLEAN_ATTRS) xml = xml.replace(new RegExp(`\\s${b}="true"`, 'g'), ` ${b}`)
  return xml
}
