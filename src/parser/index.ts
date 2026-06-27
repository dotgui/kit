import { unzipSync } from 'fflate'
import { DOMParser as XmlDOMParser } from '@xmldom/xmldom'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FontInfo {
  source: string
  category?: string
  weights?: string
  styles?: string
  variants?: string
}

/**
 * Token provenance for a node. Maps an attribute to the `$token` name it
 * resolved from, e.g. `{ fill: "color-bg", radius: "radius-card" }`. A node holds
 * many attributes, so its provenance is a map. Leaf objects (fill/border/effect)
 * have one main value and use a plain `token` string instead. Absent = literal.
 */
export type TokenRefs = Record<string, string>

export interface ParsedFill {
  type: 'color' | 'linear-gradient' | 'radial-gradient' | 'angular-gradient' | 'image'
  value?: string
  src?: string
  fit?: string
  opacity?: number
  blend?: string
  visible?: boolean
  x?: number
  y?: number
  w?: number
  h?: number
  /** The `$token` this fill's `value` resolved from, if any. */
  token?: string
  [key: string]: unknown
}

export interface ParsedEffect {
  type: 'drop-shadow' | 'inner-shadow' | 'layer-blur' | 'background-blur' | 'glass' | string
  x?: number
  y?: number
  radius?: number
  spread?: number
  color?: string
  opacity?: number
  blend?: string
  visible?: boolean
  /** The `$token` this effect's `color` resolved from, if any. */
  token?: string
}

export interface ParsedBorder {
  color?: string
  paint?: string
  w?: number
  align?: string
  style?: string
  visible?: boolean
  /** The `$token` this border's `color` resolved from, if any. */
  token?: string
  [key: string]: unknown
}

export interface ParsedAppearance {
  fills: ParsedFill[]
  effects: ParsedEffect[]
  borders: ParsedBorder[]
}

export interface ParsedNode {
  type: string
  children?: ParsedNode[]
  appearance?: ParsedAppearance
  segments?: ParsedNode[]
  paths?: string[]
  svgContent?: string
  /** Which of this node's attributes resolved from a `$token`, e.g. `{ fill: "color-bg", radius: "radius-card" }`. */
  tokens?: TokenRefs
  /** Name of the text style this node applied (from `text-style="..."`), if any. */
  textStyle?: string
  /** Name of the fill style this node applied (from `fill-style="..."`), if any. */
  fillStyle?: string
  /** Name of the effect style this node applied (from `effect-style="..."`), if any. */
  effectStyle?: string
  [key: string]: unknown
}

export interface ParsedComponent {
  id: string
  name?: string
  props: ParsedProp[]
  body: ParsedNode | null
  variants?: ParsedComponentVariant[]
}

export interface ParsedComponentVariant {
  id: string
  attrs: Record<string, string>
  body: ParsedNode | null
}

export interface ParsedProp {
  name: string
  type: string
  target: string
  bind?: string
}

/** A token mode axis (RFC-0037): a named dimension with enumerated values. */
export interface ModeAxis {
  /** Enumerated mode values for this axis, e.g. ['light','dark']. */
  values: string[]
  /** The value used when no active mode is supplied; one of `values`. */
  default: string
}

/** A token definition (RFC-0037). Either constant or varying on one axis. */
export interface TokenDef {
  type: 'color' | 'number' | 'string'
  /** Constant (modeless) value, when the token does not vary by mode. */
  value?: string
  /** The single axis this token varies on, when moded. */
  axis?: string
  /** Per-mode-value map for `axis`, e.g. { light: '#FFF', dark: '#000' }. */
  byValue?: Record<string, string>
}

export interface ParsedGUI {
  version: string | null
  name: string | null
  platform: string | null
  fonts: Record<string, FontInfo>
  /** Token mode axes, keyed by axis name (RFC-0037). Empty when no modes declared. */
  modes: Record<string, ModeAxis>
  /** Full per-mode token definitions (RFC-0037), keyed by token name. */
  tokenDefs: Record<string, TokenDef>
  /** Raw tokens — consumers that walk DOM elements still need these for $ref resolution. Resolved at each axis's default mode. */
  tokens: Record<string, string>
  /** Named text styles. */
  textStyles: Record<string, Record<string, string>>
  /**
   * @deprecated Renamed to `textStyles` for symmetry with `fillStyles` /
   * `effectStyles`. This alias points at the same object and will be removed in a
   * future major version. Migrate to `textStyles`.
   */
  styles: Record<string, Record<string, string>>
  /** Named fill styles */
  fillStyles: Record<string, string>
  /** Named effect styles — already parsed to plain objects */
  effectStyles: Record<string, ParsedEffect[]>
  /** Resolved asset map: { 'assets/img-1.png': 'data:image/png;base64,...' } */
  assets: Record<string, string>
  components: Record<string, ParsedComponent>
  root: ParsedNode | null
}

// ---------------------------------------------------------------------------
// Numeric / boolean attribute coercion
// ---------------------------------------------------------------------------

const NUMERIC_ATTRS = new Set([
  'x', 'y', 'w', 'h',
  'opacity', 'rotation', 'radius', 'spread',
  'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'arc-start', 'arc-end', 'arc-inner',
  'border-width', 'min-width', 'max-width', 'min-height', 'max-height',
  'columns', 'corner-smoothing', 'paragraph-spacing', 'paragraph-indent',
  'pt', 'pr', 'pb', 'pl', 'max-lines',
  'mask-x', 'mask-y', 'mask-width', 'mask-height',
  'miter-limit',
  'unit', 'col-span', 'row-span',
])

const BOOLEAN_ATTRS = new Set([
  'wrap', 'clip', 'mask', 'abs', 'truncate', 'reverse-z',
])

function coerce(key: string, value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (BOOLEAN_ATTRS.has(key) && value === '') return true
  if (NUMERIC_ATTRS.has(key)) {
    if ((key === 'w' || key === 'h') && (value === 'fill' || value === 'hug')) return value
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  return value
}

function attrsToObject(
  el: Element,
  tokens: Record<string, string>,
  fillStyles: Record<string, string>,
  textStyles: Record<string, Record<string, string>>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  const refs: TokenRefs = {}
  for (let i = 0; i < el.attributes.length; i++) {
    const { name, value } = el.attributes[i]
    const resolved = resolveToken(value, tokens)
    obj[name] = coerce(name, resolved)
    const ref = resolveTokenRef(value, tokens)
    if (ref) refs[name] = ref
  }

  // Inline fill-style → fill. The provenance is the style name (a named-style
  // reference), recorded on the node as `fillStyle`; we don't dig into the
  // style's own internal token.
  const fillStyleName = el.getAttribute('fill-style')
  if (fillStyleName && fillStyles[fillStyleName] !== undefined) {
    obj['fill'] = resolveToken(fillStyles[fillStyleName], tokens)
    delete obj['fill-style']
    delete refs['fill-style']
    obj['fillStyle'] = fillStyleName
  }

  // Inline text-style attrs. Provenance is the style name on `textStyle`.
  const textStyleName = el.getAttribute('text-style')
  if (textStyleName && textStyles[textStyleName]) {
    const style = textStyles[textStyleName]
    for (const attr of Object.keys(style)) {
      // Only apply style attr if not already explicitly set on the element
      if (el.getAttribute(attr) === null) {
        obj[attr] = coerce(attr, resolveToken(style[attr], tokens))
      }
    }
    delete obj['text-style']
    delete refs['text-style']
    obj['textStyle'] = textStyleName
  }

  if (Object.keys(refs).length) obj['tokens'] = refs

  return obj
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

function resolveToken(value: string, tokens: Record<string, string>): string {
  if (!value || value.indexOf('$') === -1) return value
  return value.replace(/\$([A-Za-z0-9_.-]+)/g, (match, name) => tokens[name] ?? match)
}

/**
 * The token name an attribute value resolved from, for provenance.
 *
 * Returns the first `$name` in the value that is a declared token. The common
 * case is a value that is exactly one token (`$color-bg`); a value that composes
 * several tokens records only the first — composite multi-token values are rare
 * and provenance is a best-effort signal, not a binding table.
 */
function resolveTokenRef(value: string, tokens: Record<string, string>): string | undefined {
  if (!value || value.indexOf('$') === -1) return undefined
  const matches = value.match(/\$([A-Za-z0-9_.-]+)/g)
  if (!matches) return undefined
  for (const m of matches) {
    const name = m.slice(1)
    if (tokens[name] !== undefined) return name
  }
  return undefined
}

/**
 * Resolve a single token definition to its value for a given active mode (RFC-0037).
 *
 * Cascade per the RFC: for the axis the token varies on, use the active mode's
 * value, else the axis default, else the token's constant value.
 *
 * @param def        - the token definition
 * @param modes      - the declared axis table
 * @param activeMode - axis → active value map (e.g. { theme: 'dark' }); may be partial
 */
export function resolveTokenValue(
  def: TokenDef,
  modes: Record<string, ModeAxis>,
  activeMode: Record<string, string>,
): string | undefined {
  if (def.axis && def.byValue) {
    const axisDefault = modes[def.axis] ? modes[def.axis].default : undefined
    const want = activeMode[def.axis] !== undefined ? activeMode[def.axis] : axisDefault
    if (want !== undefined && def.byValue[want] !== undefined) return def.byValue[want]
    if (axisDefault !== undefined && def.byValue[axisDefault] !== undefined) return def.byValue[axisDefault]
  }
  return def.value
}

/** Flatten all token definitions to a `name → value` map for a given active mode. */
export function flattenTokens(
  tokenDefs: Record<string, TokenDef>,
  modes: Record<string, ModeAxis>,
  activeMode: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(tokenDefs)) {
    const v = resolveTokenValue(tokenDefs[name], modes, activeMode)
    if (v !== undefined) out[name] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Preprocessing — normalize boolean presence attrs before DOMParser
// ---------------------------------------------------------------------------

const PRESENCE_ATTR_VALUES: Record<string, string> = {
  abs: 'true',
  clip: 'true',
  gap: 'auto',
  mask: 'true',
  'reverse-z': 'true',
  truncate: 'true',
  wrap: 'true',
}

function normalizeTagPresenceAttrs(tag: string): string {
  let out = ''
  let i = 0
  while (i < tag.length) {
    const ch = tag[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      const start = i
      i++
      while (i < tag.length && tag[i] !== quote) i++
      if (i < tag.length) i++
      out += tag.slice(start, i)
      continue
    }
    const isAttrBoundary = /\s/.test(ch)
    if (!isAttrBoundary) { out += ch; i++; continue }
    const wsStart = i
    while (i < tag.length && /\s/.test(tag[i])) i++
    const nameStart = i
    if (!/[A-Za-z]/.test(tag[i] || '')) { out += tag.slice(wsStart, i + 1); i++; continue }
    while (i < tag.length && /[\w-]/.test(tag[i])) i++
    const name = tag.slice(nameStart, i)
    const afterName = tag[i]
    const value = PRESENCE_ATTR_VALUES[name]
    if (value && (/\s/.test(afterName || '') || afterName === '/' || afterName === '>')) {
      out += `${tag.slice(wsStart, nameStart)}${name}="${value}"`
    } else {
      out += tag.slice(wsStart, i)
    }
  }
  return out
}

function normalizeBooleanAttrs(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const tagStart = code.indexOf('<', i)
    if (tagStart === -1) { out += code.slice(i); break }
    out += code.slice(i, tagStart)
    if (code.startsWith('<!--', tagStart)) {
      const commentEnd = code.indexOf('-->', tagStart + 4)
      const end = commentEnd === -1 ? code.length : commentEnd + 3
      out += code.slice(tagStart, end)
      i = end
      continue
    }
    let tagEnd = tagStart + 1
    let quote: string | null = null
    while (tagEnd < code.length) {
      const ch = code[tagEnd]
      if (quote) { if (ch === quote) quote = null }
      else if (ch === '"' || ch === "'") { quote = ch }
      else if (ch === '>') break
      tagEnd++
    }
    const end = tagEnd < code.length ? tagEnd + 1 : code.length
    const tag = code.slice(tagStart, end)
    if (/^<\/|^<\?|^<!/.test(tag)) { out += tag } else { out += normalizeTagPresenceAttrs(tag) }
    i = end
  }
  return out
}

// ---------------------------------------------------------------------------
// Section parsers (operate on the raw DOM, before token resolution)
// ---------------------------------------------------------------------------

/** Parse <mode>/<modes> declarations (RFC-0037) into an axis table. */
function parseModesSection(gui: Element): Record<string, ModeAxis> {
  const modes: Record<string, ModeAxis> = {}
  const addAxis = (el: Element) => {
    const name = el.getAttribute('name')
    const values = el.getAttribute('values')
    if (!name || !values) return
    const list = values.trim().split(/\s+/).filter(Boolean)
    if (!list.length) return
    const declared = el.getAttribute('default')
    const def = declared && list.indexOf(declared) !== -1 ? declared : list[0]
    modes[name] = { values: list, default: def }
  }
  for (const child of Array.from(gui.children)) {
    if (child.tagName === 'mode') {
      addAxis(child)
    } else if (child.tagName === 'modes') {
      for (const m of Array.from(child.children)) {
        if (m.tagName === 'mode') addAxis(m)
      }
    }
  }
  return modes
}

const TOKEN_TAGS: Record<string, TokenDef['type']> = {
  color: 'color',
  number: 'number',
  string: 'string',
}

/**
 * Parse the <tokens> block into full per-mode definitions (RFC-0037).
 * A token carries either a constant `value` or `{axis}-{value}` attributes for
 * one declared axis.
 */
function parseTokenDefs(
  gui: Element,
  modes: Record<string, ModeAxis>,
): Record<string, TokenDef> {
  const defs: Record<string, TokenDef> = {}
  for (const child of Array.from(gui.children)) {
    if (child.tagName !== 'tokens') continue
    for (const token of Array.from(child.children)) {
      const type = TOKEN_TAGS[token.tagName]
      if (!type) continue
      const name = token.getAttribute('name')
      if (!name) continue

      const def: TokenDef = { type }
      const value = token.getAttribute('value')
      if (value !== null) def.value = value

      // Scan for {axis}-{value} attributes by matching against the *declared*
      // axes (not a naive first-dash split) — an axis name may itself contain a
      // dash (e.g. a Figma collection "Brand Colors" → axis "brand-colors").
      let chosenAxis: string | undefined
      const byValue: Record<string, string> = {}
      for (let i = 0; i < token.attributes.length; i++) {
        const attr = token.attributes[i]
        // Match the longest declared axis prefix so "brand-colors" wins over a
        // hypothetical "brand" axis when both are declared.
        let matchedAxis: string | undefined
        let matchedVal: string | undefined
        for (const axis of Object.keys(modes)) {
          const prefix = axis + '-'
          if (attr.name.indexOf(prefix) !== 0) continue
          const modeVal = attr.name.slice(prefix.length)
          if (modes[axis].values.indexOf(modeVal) === -1) continue
          if (matchedAxis === undefined || axis.length > matchedAxis.length) {
            matchedAxis = axis
            matchedVal = modeVal
          }
        }
        if (matchedAxis === undefined || matchedVal === undefined) continue
        // A token varies on a single axis; lock to the first axis seen.
        if (chosenAxis === undefined) chosenAxis = matchedAxis
        if (matchedAxis !== chosenAxis) continue
        byValue[matchedVal] = attr.value
      }
      if (chosenAxis !== undefined && Object.keys(byValue).length > 0) {
        def.axis = chosenAxis
        def.byValue = byValue
      }

      defs[name] = def
    }
  }
  return defs
}

function parseFontsSection(gui: Element): Record<string, FontInfo> {
  const fonts: Record<string, FontInfo> = {}
  for (const block of Array.from(gui.children)) {
    if (block.tagName !== 'fonts') continue
    for (const font of Array.from(block.children)) {
      if (font.tagName !== 'font') continue
      const family = font.getAttribute('family')
      const source = font.getAttribute('source')
      if (!family || !source) continue
      fonts[family] = {
        source,
        category: font.getAttribute('category') || undefined,
        weights: font.getAttribute('weights') || undefined,
        styles: font.getAttribute('styles') || undefined,
        variants: font.getAttribute('variants') || undefined,
      }
    }
  }
  return fonts
}

const TEXT_STYLE_ATTRS = [
  'font-family', 'font-size', 'font-weight', 'font-style',
  'font-variation', 'font-feature',
  'line-height', 'letter-spacing',
  'decoration', 'decoration-color', 'decoration-style', 'decoration-thickness',
  'text-case',
]

function parseTextStyles(gui: Element): Record<string, Record<string, string>> {
  const styles: Record<string, Record<string, string>> = {}
  for (const child of Array.from(gui.children)) {
    if (child.tagName !== 'styles') continue
    for (const style of Array.from(child.children)) {
      if (style.tagName !== 'text-style') continue
      const name = style.getAttribute('name')
      if (!name) continue
      const entry: Record<string, string> = {}
      for (const attr of TEXT_STYLE_ATTRS) {
        const val = style.getAttribute(attr)
        if (val !== null) entry[attr] = val
      }
      styles[name] = entry
    }
  }
  return styles
}

function parseFillStyles(gui: Element): Record<string, string> {
  const result: Record<string, string> = {}
  for (const child of Array.from(gui.children)) {
    if (child.tagName !== 'styles') continue
    for (const style of Array.from(child.children)) {
      if (style.tagName !== 'fill-style') continue
      const name = style.getAttribute('name')
      const value = style.getAttribute('value')
      if (name && value !== null) result[name] = value
    }
  }
  return result
}

function parseEffectStyles(
  gui: Element,
  tokens: Record<string, string>,
): Record<string, ParsedEffect[]> {
  const result: Record<string, ParsedEffect[]> = {}
  for (const child of Array.from(gui.children)) {
    if (child.tagName !== 'styles') continue
    for (const style of Array.from(child.children)) {
      if (style.tagName !== 'effect-style') continue
      const name = style.getAttribute('name')
      if (!name) continue
      result[name] = Array.from(style.children)
        .filter(c => c.tagName === 'effect')
        .map(c => parseEffectEl(c, tokens))
    }
  }
  return result
}

function parseAssetsSection(
  gui: Element,
  zipAssets: Record<string, string>,
): Record<string, string> {
  // If we have zip assets, prefer those — skip the inline <assets> block
  if (Object.keys(zipAssets).length > 0) return zipAssets

  const map: Record<string, string> = {}
  for (const child of Array.from(gui.children)) {
    if (child.tagName !== 'assets') continue
    for (const img of Array.from(child.children)) {
      if (img.tagName !== 'image') continue
      const id = img.getAttribute('id')
      const format = img.getAttribute('format') || 'png'
      const src = img.getAttribute('src') || ''
      if (!id) continue
      const mime = format === 'svg' ? 'svg+xml' : format
      if (src.startsWith('base64:')) {
        map[`assets/${id}.${format}`] = `data:image/${mime};base64,${src.slice(7)}`
      } else if (src) {
        map[`assets/${id}.${format}`] = src
      }
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Node parsing
// ---------------------------------------------------------------------------

const LAYOUT_TAGS = new Set(['frame', 'stack', 'row', 'col', 'grid', 'group'])
const CONTENT_TAGS = new Set(['text', 'img', 'rect', 'ellipse', 'line', 'svg', 'shape', 'instance'])
const CHILD_TAGS = new Set([...LAYOUT_TAGS, ...CONTENT_TAGS])

function parseEffectEl(el: Element, tokens: Record<string, string>): ParsedEffect {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < el.attributes.length; i++) {
    const { name, value } = el.attributes[i]
    obj[name] = coerce(name, resolveToken(value, tokens))
    // An effect's main value is its color.
    if (name === 'color') {
      const ref = resolveTokenRef(value, tokens)
      if (ref) obj['token'] = ref
    }
  }
  return obj as unknown as ParsedEffect
}

function parseAppearanceEl(
  el: Element,
  tokens: Record<string, string>,
  fillStyles: Record<string, string>,
  effectStyles: Record<string, ParsedEffect[]>,
  assets: Record<string, string>,
): ParsedAppearance {
  const fills: ParsedFill[] = []
  const effects: ParsedEffect[] = []
  const borders: ParsedBorder[] = []

  for (const child of Array.from(el.children)) {
    if (child.tagName === 'fill') {
      const obj: Record<string, unknown> = {}
      for (let i = 0; i < child.attributes.length; i++) {
        const { name, value } = child.attributes[i]
        let resolved = resolveToken(value, tokens)
        // A fill's main value is its `value`.
        if (name === 'value') {
          const ref = resolveTokenRef(value, tokens)
          if (ref) obj['token'] = ref
        }
        // resolve asset src
        if (name === 'src') resolved = assets[resolved] || resolved
        obj[name] = coerce(name, resolved)
      }
      fills.push(obj as ParsedFill)
    } else if (child.tagName === 'effect') {
      effects.push(parseEffectEl(child, tokens))
    } else if (child.tagName === 'border') {
      const obj: Record<string, unknown> = {}
      for (let i = 0; i < child.attributes.length; i++) {
        const { name, value } = child.attributes[i]
        obj[name] = coerce(name, resolveToken(value, tokens))
        // A border's main value is its `color`.
        if (name === 'color') {
          const ref = resolveTokenRef(value, tokens)
          if (ref) obj['token'] = ref
        }
      }
      borders.push(obj as ParsedBorder)
    }
  }

  return { fills, effects, borders }
}

function parseNode(
  el: Element,
  tokens: Record<string, string>,
  fillStyles: Record<string, string>,
  textStyles: Record<string, Record<string, string>>,
  effectStyles: Record<string, ParsedEffect[]>,
  assets: Record<string, string>,
): ParsedNode {
  const nodeAttrs = attrsToObject(el, tokens, fillStyles, textStyles)

  // Resolve asset src on the node itself
  const srcVal = el.getAttribute('src')
  if (srcVal && assets[srcVal]) nodeAttrs['src'] = assets[srcVal]

  // Inline effect-style → appearance.effects
  const effectStyleName = el.getAttribute('effect-style')

  const node: ParsedNode = { type: el.tagName, ...nodeAttrs }
  if (effectStyleName) {
    delete node['effect-style']
    node.effectStyle = effectStyleName
  }

  // Inline SVG: serialize children as raw SVG markup
  if (el.tagName === 'svg' && !el.getAttribute('src')) {
    const serializer = new XMLSerializer()
    const childEls = Array.from(el.children)
    if (childEls.length > 0) {
      let inner = ''
      for (let i = 0; i < childEls.length; i++) {
        inner += serializer.serializeToString(childEls[i])
      }
      node.svgContent = inner.replace(/\s+xmlns=""/g, '')
    }
    return node
  }

  const children: ParsedNode[] = []
  const segments: ParsedNode[] = []
  const paths: string[] = []
  let appearance: ParsedAppearance | undefined

  for (const child of Array.from(el.children)) {
    if (child.tagName === 'appearance') {
      appearance = parseAppearanceEl(child, tokens, fillStyles, effectStyles, assets)
    } else if (child.tagName === 'segment') {
      const segAttrs = attrsToObject(child, tokens, fillStyles, textStyles)
      segments.push({ type: 'segment', ...segAttrs })
    } else if (child.tagName === 'path') {
      const d = child.getAttribute('d')
      if (d) paths.push(d)
    } else if (CHILD_TAGS.has(child.tagName)) {
      children.push(parseNode(child, tokens, fillStyles, textStyles, effectStyles, assets))
    }
  }

  // Merge effect-style into appearance
  if (effectStyleName && effectStyles[effectStyleName]) {
    const styleEffects = effectStyles[effectStyleName]
    if (!appearance) appearance = { fills: [], effects: [], borders: [] }
    appearance.effects = [...styleEffects, ...appearance.effects]
  }

  if (appearance) node.appearance = appearance
  if (segments.length) node.segments = segments
  if (paths.length) node.paths = paths
  if (children.length) node.children = children

  return node
}

// ---------------------------------------------------------------------------
// Component parsing
// ---------------------------------------------------------------------------

function parseComponentsSection(
  gui: Element,
  tokens: Record<string, string>,
  fillStyles: Record<string, string>,
  textStyles: Record<string, Record<string, string>>,
  effectStyles: Record<string, ParsedEffect[]>,
  assets: Record<string, string>,
): Record<string, ParsedComponent> {
  const map: Record<string, ParsedComponent> = {}

  for (const block of Array.from(gui.children)) {
    if (block.tagName !== 'components') continue
    for (const comp of Array.from(block.children)) {
      if (comp.tagName === 'component') {
        const id = comp.getAttribute('id')
        if (!id) continue
        const propsEl = Array.from(comp.children).find(c => c.tagName === 'props')
        const bodyEl = Array.from(comp.children).find(c => c.tagName !== 'props')
        map[id] = {
          id,
          name: comp.getAttribute('name') || undefined,
          props: propsEl ? parsePropsEl(propsEl) : [],
          body: bodyEl ? parseNode(bodyEl, tokens, fillStyles, textStyles, effectStyles, assets) : null,
        }
      } else if (comp.tagName === 'component-set') {
        const setId = comp.getAttribute('id')
        if (!setId) continue
        const variants: ParsedComponentVariant[] = []
        for (const variant of Array.from(comp.children)) {
          if (variant.tagName !== 'variant') continue
          const varId = variant.getAttribute('id')
          if (!varId) continue
          const varAttrs: Record<string, string> = {}
          for (let i = 0; i < variant.attributes.length; i++) {
            const { name, value } = variant.attributes[i]
            if (name !== 'id') varAttrs[name] = value
          }
          const varBodyEl = Array.from(variant.children).find(c => c.tagName !== 'props')
          variants.push({
            id: varId,
            attrs: varAttrs,
            body: varBodyEl ? parseNode(varBodyEl, tokens, fillStyles, textStyles, effectStyles, assets) : null,
          })
          // also register each variant by its own id for direct lookup
          const propsEl = Array.from(variant.children).find(c => c.tagName === 'props')
          map[varId] = {
            id: varId,
            props: propsEl ? parsePropsEl(propsEl) : [],
            body: varBodyEl ? parseNode(varBodyEl, tokens, fillStyles, textStyles, effectStyles, assets) : null,
          }
        }
        map[setId] = { id: setId, name: comp.getAttribute('name') || undefined, props: [], body: null, variants }
      }
    }
  }

  return map
}

function parsePropsEl(propsEl: Element): ParsedProp[] {
  const props: ParsedProp[] = []
  for (const propEl of Array.from(propsEl.children)) {
    if (propEl.tagName !== 'prop') continue
    const name = propEl.getAttribute('name')
    const type = propEl.getAttribute('type')
    const target = propEl.getAttribute('target')
    const bind = propEl.getAttribute('bind')
    if (!name || !type || !target) continue
    const prop: ParsedProp = { name, type, target }
    if (bind) prop.bind = bind
    props.push(prop)
  }
  return props
}

// ---------------------------------------------------------------------------
// Zip extraction
// ---------------------------------------------------------------------------

function mimeForExt(ext: string): string {
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  const len = bytes.length
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < len ? bytes[i + 1] : 0
    const b2 = i + 2 < len ? bytes[i + 2] : 0
    result += chars[b0 >> 2]
    result += chars[((b0 & 3) << 4) | (b1 >> 4)]
    result += i + 1 < len ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '='
    result += i + 2 < len ? chars[b2 & 63] : '='
  }
  return result
}

function extractZip(bytes: Uint8Array): { xml: string; assets: Record<string, string> } | null {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    return null
  }

  // Find the XML entry — the .gui zip contains a .guix file (the XML) plus assets/ folder
  let xml: string | null = null
  const assets: Record<string, string> = {}

  for (const path of Object.keys(files)) {
    if (path.endsWith('.guix')) {
      xml = new TextDecoder().decode(files[path])
      continue
    }
    if (path.startsWith('assets/')) {
      const ext = path.split('.').pop() || 'png'
      const b64 = bytesToBase64(files[path])
      assets[path] = `data:${mimeForExt(ext)};base64,${b64}`
    }
  }

  if (!xml) return null
  return { xml, assets }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a .gui file (zip) into a fully resolved plain object tree.
 *
 * - All $token references are substituted with their values
 * - All fill-style / text-style / effect-style references are inlined into nodes
 * - All asset src attributes are replaced with data URIs
 * - Numeric and boolean attributes are type-coerced
 *
 * @param bytes - Raw bytes of a .gui zip file
 * @returns ParsedGUI or null if the file is invalid
 */
export function parse(bytes: Uint8Array): ParsedGUI | null {
  const extracted = extractZip(bytes)
  if (!extracted) return null
  const { xml, assets } = extracted
  return parseXml(xml, assets)
}

/**
 * Parse a raw .gui XML string directly (no zip).
 * Useful when you already have the XML and asset map (e.g. from the Figma plugin).
 *
 * @param xml      - Raw .gui XML string
 * @param assetMap - Optional pre-built asset map `{ 'assets/img-1.png': 'data:...' }`
 */
export function parseXml(xml: string, assetMap?: Record<string, string>): ParsedGUI | null {
  let doc: Document
  try {
    const sanitized = normalizeBooleanAttrs(xml).replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;')
    // Prefer the platform's native DOMParser (browser / Figma UI) — fast and
    // exact. Fall back to @xmldom/xmldom (pure JS) wherever there's no DOM (node,
    // edge, the Figma sandbox), so the parser runs everywhere.
    const Native = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser
    if (Native) {
      doc = new Native().parseFromString(sanitized, 'text/xml')
      if (doc.querySelector?.('parsererror')) return null
    } else {
      // xmldom throws on malformed XML (caught below) instead of a <parsererror>.
      doc = new XmlDOMParser({
        onError: (level: string, msg: string) => { if (level === 'fatalError') throw new Error(msg) },
      }).parseFromString(sanitized, 'text/xml') as unknown as Document
    }
  } catch {
    return null
  }

  const gui = doc.documentElement
  if (!gui || gui.tagName !== 'gui') return null

  // Parse sections in dependency order
  const modes = parseModesSection(gui)
  const tokenDefs = parseTokenDefs(gui, modes)
  // Back-compat flat token map: each token resolved at its axis default mode.
  const tokens = flattenTokens(tokenDefs, modes, {})
  const fonts = parseFontsSection(gui)
  const textStyles = parseTextStyles(gui)
  const fillStyles = parseFillStyles(gui)
  const effectStyles = parseEffectStyles(gui, tokens)
  const assets = parseAssetsSection(gui, assetMap || {})
  const components = parseComponentsSection(gui, tokens, fillStyles, textStyles, effectStyles, assets)

  // Find root layout node
  const STACK_TAGS = new Set(['stack', 'row', 'col', 'grid'])
  let rootEl: Element | null = null
  for (const child of Array.from(gui.children)) {
    if (child.tagName === 'frame' || STACK_TAGS.has(child.tagName)) {
      rootEl = child
      break
    }
  }

  const root = rootEl
    ? parseNode(rootEl, tokens, fillStyles, textStyles, effectStyles, assets)
    : null

  return {
    version: gui.getAttribute('version'),
    name: gui.getAttribute('name'),
    platform: gui.getAttribute('platform'),
    fonts,
    modes,
    tokenDefs,
    tokens,
    textStyles,
    styles: textStyles, // deprecated alias — same object; see ParsedGUI.styles
    fillStyles,
    effectStyles,
    assets,
    components,
    root,
  }
}
