/**
 * Deterministic auto-repair for dotgui markup — the kit's canonical autofixer,
 * used for `gui lint --fix` and by gui-app. Models make the same mechanical
 * mistakes (CSS habits, invented attributes, boolean="false", bad color formats);
 * each is a string rewrite, so we fix them here instead of bouncing back to the
 * agent. Only unambiguous fixes belong here — anything needing design judgment
 * (missing sizes, undefined tokens, empty spacers) stays a lint error. Pairs with
 * [lint](../lint).
 */
import { parseGui, serialize, walk, type El } from '../dom'

/** CSS-habit attributes with a direct dotgui equivalent. */
const RENAME_ATTRS: Record<string, string> = { width: 'w', height: 'h', spacing: 'gap' }
/** Axis padding shorthands → the pair of real per-side attributes. */
const PADDING_AXES: Record<string, [string, string]> = { py: ['pt', 'pb'], px: ['pl', 'pr'] }
/** Attributes the renderer ignores and that have no dotgui equivalent. */
const DROP_ATTRS = ['margin', 'mt', 'mb', 'ml', 'mr', 'justify', 'justify-content', 'align-items', 'flex']
/** Presence-based booleans; ="false" means "should be absent". */
const BOOLEAN_ATTRS = ['clip', 'mask', 'wrap', 'abs', 'truncate', 'reverse-z']
/** Invented alignment values → closest valid 9-point value (containers). */
const CONTAINER_ALIGN_REMAP: Record<string, string> = {
  center: 'middle-center', middle: 'middle-center', top: 'top-center', bottom: 'bottom-center',
  left: 'middle-left', right: 'middle-right', 'center-center': 'middle-center',
  'baseline-left': 'middle-left', 'baseline-center': 'middle-center', 'baseline-right': 'middle-right',
}
/** Invented alignment values → closest valid text alignment. */
const TEXT_ALIGN_REMAP: Record<string, string> = {
  middle: 'center', 'middle-center': 'center', 'top-center': 'center', 'bottom-center': 'center',
  'middle-left': 'left', 'top-left': 'left', 'bottom-left': 'left',
  'middle-right': 'right', 'top-right': 'right', 'bottom-right': 'right', justify: 'justified',
}
const TEXT_TAGS = new Set(['text', 'segment'])
const SHORT_HEX = /#([0-9a-fA-F]{3})(?![0-9a-fA-F])/g
const RGB_FUNC = /rgba?\(([^)]*)\)/gi

function expandShortHex(value: string): string {
  return value.replace(SHORT_HEX, (_m, hex: string) => `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`)
}
function rgbToHex(value: string): string {
  return value.replace(RGB_FUNC, (match, args: string) => {
    const parts = args.split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return match
    const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
    let hex = `#${byte(parts[0])}${byte(parts[1])}${byte(parts[2])}`.toUpperCase()
    if (parts.length >= 4 && Number.isFinite(parts[3]) && parts[3] < 1) hex += byte(parts[3] * 255)
    return hex
  })
}
function label(el: El): string {
  const name = el.getAttribute('name')
  return name ? `<${el.tagName} "${name}">` : `<${el.tagName}>`
}

/** Rewrite mechanical mistakes on root + descendants in place. Returns fix lines. */
function autofixFragment(root: El): string[] {
  const fixes: string[] = []
  for (const el of walk(root)) {
    const tag = el.tagName

    for (const [from, to] of Object.entries(RENAME_ATTRS)) {
      const val = el.getAttribute(from)
      if (val === null) continue
      if (!el.hasAttribute(to)) el.setAttribute(to, val)
      el.removeAttribute(from)
      fixes.push(`${label(el)}: renamed ${from}= to ${to}=.`)
    }

    for (const [axis, [a, b]] of Object.entries(PADDING_AXES)) {
      const val = el.getAttribute(axis)
      if (val === null) continue
      if (!el.hasAttribute(a)) el.setAttribute(a, val)
      if (!el.hasAttribute(b)) el.setAttribute(b, val)
      el.removeAttribute(axis)
      fixes.push(`${label(el)}: expanded ${axis}="${val}" to ${a}/${b}.`)
    }

    for (const attr of DROP_ATTRS) {
      if (!el.hasAttribute(attr)) continue
      el.removeAttribute(attr)
      fixes.push(`${label(el)}: removed ${attr}= (not a dotgui attribute; the renderer ignores it).`)
    }

    for (const attr of BOOLEAN_ATTRS) {
      if (el.getAttribute(attr) === 'false') {
        el.removeAttribute(attr)
        fixes.push(`${label(el)}: removed ${attr}="false" (booleans are presence-based).`)
      }
    }

    const textAlign = el.getAttribute('text-align')
    if (textAlign !== null) {
      if (TEXT_TAGS.has(tag) && !el.hasAttribute('align')) {
        el.setAttribute('align', textAlign)
        fixes.push(`${label(el)}: renamed text-align= to align=.`)
      } else {
        fixes.push(`${label(el)}: removed text-align= (use align=).`)
      }
      el.removeAttribute('text-align')
    }

    const align = el.getAttribute('align')
    if (align !== null) {
      const remap = TEXT_TAGS.has(tag) ? TEXT_ALIGN_REMAP : CONTAINER_ALIGN_REMAP
      const fixed = remap[align]
      if (fixed) {
        el.setAttribute('align', fixed)
        fixes.push(`${label(el)}: remapped align="${align}" to align="${fixed}".`)
      }
    }

    const stroke = el.getAttribute('stroke')
    if (stroke !== null) {
      if (!el.hasAttribute('border')) el.setAttribute('border', `${el.getAttribute('stroke-width') || '1'} ${stroke}`)
      el.removeAttribute('stroke')
      el.removeAttribute('stroke-width')
      fixes.push(`${label(el)}: converted legacy stroke= to border= shorthand.`)
    }

    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i]
      if (attr.name === 'value' || attr.name === 'name' || attr.name === 'id') continue
      let next = expandShortHex(attr.value)
      next = rgbToHex(next)
      if (next !== attr.value) {
        fixes.push(`${label(el)}: rewrote ${attr.name}="${attr.value}" as "${next}".`)
        el.setAttribute(attr.name, next)
      }
    }

    const value = el.getAttribute('value')
    if (value && value.includes('—')) {
      el.setAttribute('value', value.replace(/\s*—\s*/g, ' - '))
      fixes.push(`${label(el)}: replaced em-dash in copy with a hyphen.`)
    }
  }
  return fixes
}

export interface AutofixResult {
  xml: string
  fixes: string[]
  error?: string
}

/** Parse → autofix → serialize. Returns the (possibly) rewritten markup. */
export function autofixMarkup(xml: string): AutofixResult {
  const { root, win, error } = parseGui(xml)
  if (error || !root) return { xml, fixes: [], error: error ?? 'parse failed' }
  const fixes = autofixFragment(root)
  if (fixes.length === 0) return { xml, fixes: [] }
  return { xml: serialize(win, root), fixes }
}
