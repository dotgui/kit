/**
 * Shared XML helpers for the linter and autofixer. Parses dotgui markup
 * (expanding bare boolean attributes so standard XML parsing accepts them) and
 * serializes back with those booleans collapsed to their bare authoring form.
 *
 * DOM-free: prefers the platform's native DOMParser/XMLSerializer (browser /
 * Figma UI) and falls back to @xmldom/xmldom (pure JS) everywhere else (node,
 * edge, the Figma sandbox), so lint/autofix run in any environment.
 */
import { DOMParser as XmlDOMParser, XMLSerializer as XmlXMLSerializer } from '@xmldom/xmldom'

export type El = any // Element (native or xmldom — same read surface)

export const BOOLEAN_ATTRS = ['clip', 'mask', 'wrap', 'abs', 'truncate', 'reverse-z']
const BARE_BOOL_RE = new RegExp(`(\\s)(${BOOLEAN_ATTRS.join('|')})(?=\\s|/|>)`, 'g')

export interface ParseResult {
  root: El | null
  error?: string
}

export function parseGui(xml: string): ParseResult {
  const sanitized = xml
    .replace(BARE_BOOL_RE, '$1$2="true"')
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;')
  try {
    const Native = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser
    let doc: any
    if (Native) {
      doc = new Native().parseFromString(sanitized, 'application/xml')
      if (doc.querySelector?.('parsererror')) return { root: null, error: 'markup is not well-formed XML' }
    } else {
      // xmldom throws on malformed XML (caught below) instead of a <parsererror>.
      doc = new XmlDOMParser({
        onError: (level: string, msg: string) => { if (level === 'fatalError') throw new Error(msg) },
      }).parseFromString(sanitized, 'application/xml')
    }
    const root = doc.documentElement
    if (!root || root.tagName !== 'gui') return { root, error: `root element must be <gui>, got <${root?.tagName ?? '?'}>` }
    return { root }
  } catch (e: any) {
    return { root: null, error: `markup is not well-formed XML: ${e?.message ?? e}` }
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
export function serialize(root: El): string {
  const Native = (globalThis as { XMLSerializer?: typeof XMLSerializer }).XMLSerializer
  const ser = Native ? new Native() : new XmlXMLSerializer()
  let xml = ser.serializeToString(root)
  for (const b of BOOLEAN_ATTRS) xml = xml.replace(new RegExp(`\\s${b}="true"`, 'g'), ` ${b}`)
  return xml
}
