/**
 * dotgui-core — Validator
 * Reads documents up to spec 0.3.9 (see SUPPORTED_VERSION).
 *
 * Validates a .guix markup string against the dotgui spec.
 * Goes beyond structural checks — resolves token refs, asset refs,
 * and enforces contextual constraints that XSD cannot express.
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ValidationError {
  code: string
  message: string
  /** XPath-style path to the offending node, e.g. "gui > stack[0] > text[2]" */
  path: string
}

export interface ValidationResult {
  valid: boolean
  version: string | null
  errors: ValidationError[]
  warnings: ValidationError[]
}

// ---------------------------------------------------------------------------
// Minimal element representation (mirrors GUIElement in gui-optimizer)
// ---------------------------------------------------------------------------

export interface El {
  tag: string
  attrs: Record<string, string>
  children: El[]
}

/** Parse markup into the validator's bare element tree. Throws on bad XML. */
export function parseTree(xml: string): El {
  return parse(xml)
}

// ---------------------------------------------------------------------------
// Tiny XML parser (structural only — no validation yet)
// ---------------------------------------------------------------------------

function parse(xml: string): El {
  let pos = 0

  function skipWS() {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++
  }

  function parseEl(): El {
    skipWS()
    if (xml[pos] !== '<') throw new SyntaxError(`Expected '<' at position ${pos}`)
    pos++ // consume <
    skipWS()

    // Tag name
    let tag = ''
    while (pos < xml.length && !/[\s/>]/.test(xml[pos])) {
      tag += xml[pos++]
    }

    const attrs: Record<string, string> = {}

    // Attributes
    while (pos < xml.length) {
      skipWS()
      if (xml[pos] === '/' || xml[pos] === '>') break

      let key = ''
      while (pos < xml.length && !/[\s=/>]/.test(xml[pos])) key += xml[pos++]
      skipWS()
      if (xml[pos] === '=') {
        pos++ // consume =
        skipWS()
        const quote = xml[pos++]
        const start = pos
        while (pos < xml.length && xml[pos] !== quote) pos++
        attrs[key] = xml.slice(start, pos)
        pos++ // consume closing quote
      }
    }

    // Self-closing
    if (xml[pos] === '/') {
      pos += 2 // consume />
      return { tag, attrs, children: [] }
    }

    pos++ // consume >

    const children: El[] = []

    // Children
    while (pos < xml.length) {
      skipWS()
      if (xml.startsWith('</', pos)) {
        // Closing tag
        while (pos < xml.length && xml[pos] !== '>') pos++
        pos++
        break
      }
      if (xml[pos] === '<' && xml[pos + 1] !== '!') {
        children.push(parseEl())
      } else if (xml.startsWith('<!--', pos)) {
        // Comment — skip to its terminator. Must advance pos or we loop forever.
        const end = xml.indexOf('-->', pos)
        pos = end === -1 ? xml.length : end + 3
      } else if (xml[pos] === '<') {
        // <!...> declaration / CDATA — skip to the next '>'.
        while (pos < xml.length && xml[pos] !== '>') pos++
        pos++
      } else {
        // Text content — skip to the next tag.
        while (pos < xml.length && xml[pos] !== '<') pos++
      }
    }

    return { tag, attrs, children }
  }

  // Skip XML declaration if present
  skipWS()
  if (xml.startsWith('<?')) {
    while (pos < xml.length && !xml.startsWith('?>', pos)) pos++
    pos += 2
  }

  return parseEl()
}

// ---------------------------------------------------------------------------
// Known tags and their allowed contexts
// ---------------------------------------------------------------------------

const LAYOUT_TAGS = new Set(['frame', 'stack', 'row', 'col', 'grid', 'group'])

/**
 * Grid-placement geometry (RFC-032). A grid child placed by a gc/gr *range* or a
 * col-span/row-span derives that axis's size from the span — the renderer fills
 * it (see render applyGridPlacement). Such children don't need explicit w/h on
 * the spanned axis. w covers the column axis (gc range / col-span); h the row
 * axis (gr range / row-span). A bare gc/gr cell index does NOT size the child.
 */
function gridFillsWidth(el: El, parentTag: string): boolean {
  if (parentTag !== 'grid') return false
  const gc = el.attrs.gc
  return (gc !== undefined && gc.includes('/')) || el.attrs['col-span'] !== undefined
}
function gridFillsHeight(el: El, parentTag: string): boolean {
  if (parentTag !== 'grid') return false
  const gr = el.attrs.gr
  return (gr !== undefined && gr.includes('/')) || el.attrs['row-span'] !== undefined
}
const CONTENT_TAGS = new Set(['text', 'img', 'svg', 'shape', 'instance'])
const CHILD_TAGS = new Set([...LAYOUT_TAGS, ...CONTENT_TAGS])
const ROOT_SECTION_TAGS = new Set(['preview', 'tokens', 'styles', 'fonts', 'assets', 'meta', 'components'])
const ALL_KNOWN_TAGS = new Set([
  ...CHILD_TAGS,
  ...ROOT_SECTION_TAGS,
  'gui',
  // token children
  'color', 'number', 'string',
  // style children
  'text-style', 'fill-style', 'effect-style',
  // font / asset children
  'font', 'image',
  // appearance children
  'appearance', 'fill', 'effect',
  // text children
  'segment',
  // shape path data child
  'path',
  // component / instance system (RFC-0008, RFC-0034, RFC-0044)
  'component', 'component-set', 'variant', 'props', 'prop', 'slot',
])

/** RFC-0034 prop types: data types. */
const PROP_TYPES = new Set(['string', 'boolean', 'number', 'color', 'image', 'component', 'style'])
/** The 0.1 prop type names, still rendered, and what replaced them. */
const LEGACY_PROP_TYPES: Record<string, string> = { text: 'string', visible: 'boolean', fill: 'color', src: 'image' }
const STYLE_BINDS = new Set(['text-style', 'fill-style', 'effect-style', 'stroke-style'])

function countTextIds(el: El, id: string): number {
  let n = el.tag === 'text' && el.attrs.id === id ? 1 : 0
  for (const child of el.children) n += countTextIds(child, id)
  return n
}

/** Layout containers that can be a slot (RFC-0044). */
const SLOT_CONTAINERS = new Set(['frame', 'stack', 'row', 'col', 'grid'])

const LAYOUT_DIRECTIONS = new Set(['horizontal', 'vertical', 'grid'])
const SHAPE_TYPES = new Set(['rect', 'ellipse', 'line', 'path'])
const FIT_MODES = new Set(['cover', 'contain', 'crop', 'tile', 'fill', 'none'])
const FONT_SOURCES = new Set(['google', 'system', 'unresolved'])
const STROKE_POSITIONS = new Set(['inside', 'outside', 'center'])

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isTokenRef(value: string): boolean {
  return value.startsWith('$')
}

function isHexColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value)
}

const NUM = '\\d+(?:\\.\\d+)?|\\.\\d+'

/** rgba(r, g, b, a): integers 0–255, alpha 0–1 (RFC-0033). */
function isRgbaColor(value: string): boolean {
  const m = new RegExp(`^rgba\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(${NUM})\\s*\\)$`).exec(value)
  return !!m && [m[1], m[2], m[3]].every((c) => Number(c) <= 255) && Number(m[4]) <= 1
}

/** rgb(r, g, b): drawn for existing exports, but not part of the format — hex says it. */
function isRgbColor(value: string): boolean {
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value)
  return !!m && [m[1], m[2], m[3]].every((c) => Number(c) <= 255)
}

/** The hex an rgb() color should be written as. */
function rgbToHex(value: string): string {
  const [r, g, b] = (value.match(/\d+/g) || []).map(Number)
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('')
}

/** oklch(L C H) or oklch(L C H / a): L 0–1 or a percentage, C ≥ 0, H in degrees, a 0–1 or a percentage. */
function isOklchColor(value: string): boolean {
  const m = new RegExp(`^oklch\\(\\s*(${NUM})(%?)\\s+(${NUM})\\s+(-?(?:${NUM}))(?:deg)?\\s*(?:\\/\\s*(${NUM})(%?)\\s*)?\\)$`).exec(value)
  if (!m) return false
  const lightness = Number(m[1]) / (m[2] ? 100 : 1)
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1)
  return lightness <= 1 && alpha <= 1
}

function isGradient(value: string): boolean {
  return /^(linear-gradient|radial-gradient|conic-gradient)\(/.test(value)
}

/**
 * A value in one of the color notations. The exact rgb(), rgba() and oklch()
 * forms are checked by `checkUnits`, which holds them to 0.3.9's rules.
 */
function isColorNotation(value: string): boolean {
  return isHexColor(value) || /^(rgba?|oklch)\(.*\)$/.test(value)
}

function isValidFill(value: string): boolean {
  // 'none'/'transparent' are honored no-paint sentinels (see render color parser).
  if (value === 'none' || value === 'transparent') return true
  return isColorNotation(value) || isGradient(value) || isTokenRef(value)
}

function isValidColor(value: string): boolean {
  return isColorNotation(value) || isTokenRef(value)
}

/** Every rgb(), rgba() and oklch() call inside a value — the stops of a gradient. */
function colorCalls(value: string): string[] {
  return value.match(/(?:rgba?|oklch)\([^()]*\)/g) || []
}

/** Sizes, which may also be a share of the parent (RFC-0033). */
const SIZE_ATTRS = new Set(['w', 'h', 'min-width', 'max-width', 'min-height', 'max-height'])
/** Other dimensions: bare numbers (or tokens, or a keyword) only. */
const DIMENSION_ATTRS = new Set([
  'x', 'y', 'p', 'pt', 'pr', 'pb', 'pl', 'gap', 'radius',
  'font-size', 'line-height', 'letter-spacing', 'stroke-width', 'border-width',
])

function isNumeric(value: string): boolean {
  return !isNaN(Number(value))
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * The newest spec point this kit implements in full (spec 0.3.6: paint model,
 * multi-document packages, standalone documents, slots, typed props,
 * platform and source on <gui>). Support is
 * cumulative; a document declaring a later point is refused rather than
 * checked against rules this kit does not know. The kit's own version shares
 * the spec's chapter and counts its own patch.
 */
export const SUPPORTED_VERSION = '0.3.9'
const SUPPORTED: [number, number, number] = [0, 3, 9]

/** RFC-0036's recommended platform values. Others are allowed, and warned on. */
export const RECOMMENDED_PLATFORMS = new Set(['ios', 'android', 'web', 'desktop', 'tv', 'watch'])

/** `major.minor.patch`; a missing part reads as 0. Not a version: null. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export interface ValidateOptions {
  /**
   * The markup is served on its own, outside any package (RFC-0043): asset
   * references must be absolute URLs.
   */
  standalone?: boolean
}

/** Attributes whose whole value is an asset reference. */
const ASSET_ATTRIBUTES = new Set(['src', 'mask-src'])

function urlFunctions(value: string): string[] {
  const out: string[] = []
  const re = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value))) out.push(m[2].trim())
  return out
}

const isDataUri = (v: string) => /^\s*data:/i.test(v)
const isAbsoluteUrl = (v: string) => /^https?:\/\//i.test(v.trim())

export function validate(guiXml: string, options: ValidateOptions = {}): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  function err(code: string, message: string, path: string) {
    errors.push({ code, message, path })
  }

  function warn(code: string, message: string, path: string) {
    warnings.push({ code, message, path })
  }

  // Parse
  let root: El
  try {
    root = parse(guiXml)
  } catch (e) {
    return {
      valid: false,
      version: null,
      errors: [{ code: 'PARSE_ERROR', message: String(e), path: 'gui' }],
      warnings: [],
    }
  }

  // Root must be <gui>
  if (root.tag !== 'gui') {
    err('ROOT_TAG', `Root element must be <gui>, got <${root.tag}>`, 'gui')
    return { valid: false, version: null, errors, warnings }
  }

  const version = root.attrs.version || null

  // Rules that arrived in 0.3 are errors in a document declaring 0.3 or higher
  // and warnings in one written before them.
  const versionMatch = /^(\d+)\.(\d+)/.exec((version || '').trim())
  const strict = !!versionMatch && (Number(versionMatch[1]) > 0 || Number(versionMatch[2]) >= 3)
  const violation = strict ? err : warn

  // Version check
  if (!version) {
    err('NO_VERSION', 'Missing required attribute: version', 'gui')
  } else {
    const parsed = parseVersion(version)
    if (!parsed) {
      err('UNSUPPORTED_VERSION', `the document declares version "${version}", which is not a spec version`, 'gui')
    } else if (compareVersions(parsed, SUPPORTED) > 0) {
      err('UNSUPPORTED_VERSION', `the document declares version ${version}, but this validator reads documents up to version ${SUPPORTED_VERSION}; a newer kit is needed`, 'gui')
    }
  }

  // Collect declared tokens, assets, and styles for ref resolution
  const tokenNames = new Set<string>()
  const assetIds = new Set<string>()
  const textStyleNames = new Set<string>()
  const fillStyleNames = new Set<string>()
  const effectStyleNames = new Set<string>()

  // Parse declared mode axes (RFC-0037): <mode name="theme" values="light dark" />,
  // optionally wrapped in <modes>. Moded tokens carry per-mode values as
  // {axis}-{value} attributes (e.g. theme-light) instead of a constant `value`.
  const modeAxes: Record<string, Set<string>> = {}
  const addAxis = function(el: El) {
    const list = (el.attrs.values || '').trim().split(/\s+/).filter(Boolean)
    if (el.attrs.name && list.length) modeAxes[el.attrs.name] = new Set(list)
  }
  for (const c of root.children) {
    if (c.tag === 'mode') addAxis(c)
    else if (c.tag === 'modes') for (const m of c.children) { if (m.tag === 'mode') addAxis(m) }
  }
  // Per-mode values declared on a token via {declared-axis}-{declared-value} attrs.
  const modedValues = function(t: El): string[] {
    const out: string[] = []
    for (const attr of Object.keys(t.attrs)) {
      for (const axis of Object.keys(modeAxes)) {
        const prefix = axis + '-'
        if (attr.indexOf(prefix) === 0 && modeAxes[axis].has(attr.slice(prefix.length))) out.push(t.attrs[attr])
      }
    }
    return out
  }

  // Parse tokens section
  const tokensEl = root.children.find(function(c) { return c.tag === 'tokens' })
  if (tokensEl) {
    for (const t of tokensEl.children) {
      if (!['color', 'number', 'string'].includes(t.tag)) {
        err('INVALID_TOKEN_TAG', `Unknown token type <${t.tag}>`, `gui > tokens > ${t.tag}`)
        continue
      }
      if (!t.attrs.name) {
        err('TOKEN_NO_NAME', `Token missing required attribute: name`, `gui > tokens > ${t.tag}`)
        continue
      }
      const moded = modedValues(t)
      if (t.attrs.value === undefined && moded.length === 0) {
        err('TOKEN_NO_VALUE', `Token "${t.attrs.name}" missing a value: provide value="..." or per-mode {axis}-{value} attributes (e.g. theme-light)`, `gui > tokens > ${t.tag}`)
        continue
      }
      if (t.tag === 'color') {
        const vals = t.attrs.value !== undefined ? [t.attrs.value, ...moded] : moded
        for (const v of vals) {
          if (!isColorNotation(v)) {
            err('TOKEN_INVALID_COLOR', `Color token "${t.attrs.name}" has invalid color value: ${v}. Expected hex, rgba(), or oklch().`, `gui > tokens > color`)
          }
        }
      }
      tokenNames.add(t.attrs.name)
    }
  }

  // Parse styles section
  const stylesEl = root.children.find(function(c) { return c.tag === 'styles' })
  if (stylesEl) {
    stylesEl.children.forEach(function(s, i) {
      const stylePath = `gui > styles > ${s.tag}[${i}]`
      if (!['text-style', 'fill-style', 'effect-style'].includes(s.tag)) {
        warn('UNKNOWN_STYLE_TAG', `Unknown element inside <styles>: <${s.tag}>`, stylePath)
        return
      }
      if (!s.attrs.name) {
        err('STYLE_NO_NAME', `<${s.tag}> missing required attribute: name`, stylePath)
        return
      }
      if (s.tag === 'text-style') {
        textStyleNames.add(s.attrs.name)
      } else if (s.tag === 'fill-style') {
        if (!s.attrs.value) {
          err('MISSING_ATTR', `<fill-style name="${s.attrs.name}"> missing required attribute: value`, stylePath)
        } else if (!isColorNotation(s.attrs.value)) {
          err('INVALID_FILL_STYLE_VALUE', `<fill-style> value must be a color (hex, rgba, or oklch), got "${s.attrs.value}"`, stylePath)
        }
        fillStyleNames.add(s.attrs.name)
      } else if (s.tag === 'effect-style') {
        for (const child of s.children) {
          if (child.tag !== 'effect') {
            warn('UNKNOWN_TAG', `Unexpected child <${child.tag}> inside <effect-style>`, `${stylePath} > ${child.tag}`)
          } else if (!child.attrs.type) {
            err('MISSING_ATTR', `<effect> inside <effect-style> missing required attribute: type`, `${stylePath} > effect`)
          }
        }
        effectStyleNames.add(s.attrs.name)
      }
    })
  }

  // Parse assets section
  const assetsEl = root.children.find(function(c) { return c.tag === 'assets' })
  if (assetsEl) {
    for (const a of assetsEl.children) {
      if (a.tag !== 'image') {
        warn('UNKNOWN_ASSET_TAG', `Unknown asset element <${a.tag}>`, `gui > assets > ${a.tag}`)
        continue
      }
      if (!a.attrs.id) {
        err('ASSET_NO_ID', `Asset missing required attribute: id`, `gui > assets > image`)
        continue
      }
      if (!a.attrs.src) {
        err('ASSET_NO_SRC', `Asset "${a.attrs.id}" missing required attribute: src`, `gui > assets > image`)
      }
      assetIds.add(a.attrs.id)
    }
  }

  // Resolve a token/asset reference
  function resolveRef(value: string, path: string, kind: 'token' | 'asset') {
    if (!isTokenRef(value)) return
    const name = value.slice(1) // strip $
    if (kind === 'token' && !tokenNames.has(name)) {
      err('UNRESOLVED_TOKEN', `Token reference "${value}" not found in <tokens>`, path)
    }
    if (kind === 'asset' && !assetIds.has(name)) {
      err('UNRESOLVED_ASSET', `Asset reference "${value}" not found in <assets>`, path)
    }
  }

  // Resolve a style reference
  function resolveStyleRef(value: string, kind: 'text-style' | 'fill-style' | 'effect-style', path: string) {
    if (kind === 'text-style' && !textStyleNames.has(value)) {
      err('UNRESOLVED_TEXT_STYLE', `text-style reference "${value}" not found in <styles>`, path)
    } else if (kind === 'fill-style' && !fillStyleNames.has(value)) {
      err('UNRESOLVED_FILL_STYLE', `fill-style reference "${value}" not found in <styles>`, path)
    } else if (kind === 'effect-style' && !effectStyleNames.has(value)) {
      err('UNRESOLVED_EFFECT_STYLE', `effect-style reference "${value}" not found in <styles>`, path)
    }
  }

  // Validate fill value
  function validateFill(value: string, path: string) {
    if (!isValidFill(value)) {
      err('INVALID_FILL', `Invalid fill value: "${value}"`, path)
      return
    }
    if (isTokenRef(value)) resolveRef(value, path, 'token')
  }

  // Validate color value
  function validateColor(value: string, path: string) {
    if (!isValidColor(value)) {
      err('INVALID_COLOR', `Invalid color value: "${value}"`, path)
      return
    }
    if (isTokenRef(value)) resolveRef(value, path, 'token')
  }

  // Validate shared visual attrs common to all nodes
  function validateVisualAttrs(el: El, path: string) {
    if (el.attrs.opacity !== undefined) {
      const v = Number(el.attrs.opacity)
      if (isNaN(v) || v < 0 || v > 1) {
        err('INVALID_OPACITY', `opacity must be 0–1, got "${el.attrs.opacity}"`, path)
      }
    }
    if (el.attrs.fill !== undefined) validateFill(el.attrs.fill, path)
    if (el.attrs.stroke !== undefined) validateColor(el.attrs.stroke, path)
    if (el.attrs.color !== undefined) validateColor(el.attrs.color, path)
    if (el.attrs['stroke-position'] !== undefined && !STROKE_POSITIONS.has(el.attrs['stroke-position'])) {
      err('INVALID_STROKE_POSITION', `stroke-position must be inside|outside|center, got "${el.attrs['stroke-position']}"`, path)
    }
    if (el.attrs['fill-style'] !== undefined) {
      resolveStyleRef(el.attrs['fill-style'], 'fill-style', path)
    }
    if (el.attrs['effect-style'] !== undefined) {
      resolveStyleRef(el.attrs['effect-style'], 'effect-style', path)
    }
  }

  // Validate a content/layout node recursively
  function validateNode(el: El, path: string, parentTag: string) {
    if (!ALL_KNOWN_TAGS.has(el.tag)) {
      warn('UNKNOWN_TAG', `Unknown element <${el.tag}>`, path)
      return
    }

    validateVisualAttrs(el, path)

    switch (el.tag) {
      case 'frame': {
        // A frame placed by a grid span (gc/gr range or col/row-span) derives that
        // axis's size from the span — same grid-placement rule as img/svg.
        if (!el.attrs.w && !gridFillsWidth(el, parentTag)) err('MISSING_ATTR', `<frame> missing required attribute: w`, path)
        if (!el.attrs.h && !gridFillsHeight(el, parentTag)) err('MISSING_ATTR', `<frame> missing required attribute: h`, path)
        validateChildren(el, path)
        break
      }

      case 'stack': {
        if (el.attrs.direction && !LAYOUT_DIRECTIONS.has(el.attrs.direction)) {
          err('INVALID_DIRECTION', `<stack> direction must be horizontal|vertical|grid, got "${el.attrs.direction}"`, path)
        }
        if (el.attrs.direction === 'grid' && !el.attrs['grid-columns']) {
          warn('GRID_NO_COLUMNS', `<stack direction="grid"> should specify grid-columns`, path)
        }
        validateChildren(el, path)
        break
      }

      case 'row':
      case 'col': {
        validateChildren(el, path)
        break
      }

      case 'grid': {
        if (!el.attrs.columns) {
          warn('GRID_NO_COLUMNS', `<grid> should specify columns`, path)
        }
        validateChildren(el, path)
        break
      }

      case 'group': {
        validateChildren(el, path)
        break
      }

      case 'instance': {
        // RFC-0008: an instance references a declared component. Referential
        // resolution (id → <component>) is the gate's Intact check; schema only
        // requires the attribute to be present.
        if (!el.attrs.component) {
          err('MISSING_ATTR', `<instance> missing required attribute: component`, path)
        }
        // RFC-0044: an instance's children are only <slot> fills; what each
        // fill holds is ordinary content. The fills are checked against the
        // component once every component is known.
        el.children.forEach(function(child, i) {
          const childPath = `${path} > ${child.tag}[${i}]`
          if (child.tag === 'slot') validateChildren(child, childPath)
          else violation('SLOT_FILL', `<instance component="${el.attrs.component}"> may only contain <slot> elements, found <${child.tag}>`, childPath)
        })
        break
      }

      case 'text': {
        const hasValue = el.attrs.value !== undefined
        const hasSegments = el.children.some(function(c) { return c.tag === 'segment' })
        if (!hasValue && !hasSegments) {
          err('TEXT_NO_CONTENT', `<text> must have either a value attribute or <segment> children`, path)
        }
        if (hasValue && hasSegments) {
          err('TEXT_AMBIGUOUS', `<text> must not have both a value attribute and <segment> children`, path)
        }
        if (el.attrs['text-style'] !== undefined) {
          resolveStyleRef(el.attrs['text-style'], 'text-style', path)
        }
        if (el.attrs['fill-style'] !== undefined) {
          resolveStyleRef(el.attrs['fill-style'], 'fill-style', path)
        }
        break
      }

      case 'img': {
        if (!el.attrs.src) {
          err('MISSING_ATTR', `<img> missing required attribute: src`, path)
        } else {
          if (isTokenRef(el.attrs.src)) resolveRef(el.attrs.src, path, 'asset')
          else if (!el.attrs.src.startsWith('https://') && !el.attrs.src.startsWith('http://'))
            warn('IMG_INLINE_SRC', `<img src> is not an asset reference or URL — expected "$asset-id" or "https://..."`, path)
        }
        if (!el.attrs.w && !gridFillsWidth(el, parentTag)) err('MISSING_ATTR', `<img> missing required attribute: w`, path)
        if (!el.attrs.h && !gridFillsHeight(el, parentTag)) err('MISSING_ATTR', `<img> missing required attribute: h`, path)
        if (el.attrs.fit && !FIT_MODES.has(el.attrs.fit)) {
          err('INVALID_FIT', `<img> fit must be cover|contain|fill|none, got "${el.attrs.fit}"`, path)
        }
        break
      }

      case 'svg': {
        const hasSrc = !!el.attrs.src
        const hasInlineChildren = el.children.some(function(c) { return c.tag !== 'appearance' })
        if (!hasSrc && !hasInlineChildren) {
          err('MISSING_CONTENT', `<svg> must have either a src attribute (asset ref) or inline SVG children`, path)
        } else if (hasSrc) {
          if (isTokenRef(el.attrs.src)) resolveRef(el.attrs.src, path, 'asset')
        }
        // inline SVG children are raw SVG markup — skip .gui child validation for them
        if (!el.attrs.w && !gridFillsWidth(el, parentTag)) err('MISSING_ATTR', `<svg> missing required attribute: w`, path)
        if (!el.attrs.h && !gridFillsHeight(el, parentTag)) err('MISSING_ATTR', `<svg> missing required attribute: h`, path)
        break
      }

      case 'shape': {
        if (!el.attrs.type) {
          err('MISSING_ATTR', `<shape> missing required attribute: type`, path)
        } else if (!SHAPE_TYPES.has(el.attrs.type)) {
          err('INVALID_SHAPE_TYPE', `<shape> type must be rect|ellipse|line|path, got "${el.attrs.type}"`, path)
        }
        if (!el.attrs.w) err('MISSING_ATTR', `<shape> missing required attribute: w`, path)
        if (el.attrs.type !== 'line' && !el.attrs.h) {
          err('MISSING_ATTR', `<shape type="${el.attrs.type}"> missing required attribute: h`, path)
        }
        if (el.attrs.fill) validateFill(el.attrs.fill, path)
        if (el.attrs['fill-style']) resolveStyleRef(el.attrs['fill-style'], 'fill-style', path)
        if (el.attrs['effect-style']) resolveStyleRef(el.attrs['effect-style'], 'effect-style', path)
        // <path d="..." /> child is allowed inside <shape type="path">
        for (const child of el.children) {
          if (child.tag === 'path') {
            if (!child.attrs.d) {
              err('MISSING_ATTR', `<path> inside <shape> missing required attribute: d`, `${path} > path`)
            }
          } else if (child.tag === 'appearance') {
            validateNode(child, `${path} > appearance`, el.tag)
          } else {
            warn('UNEXPECTED_CHILD', `Unexpected child <${child.tag}> inside <shape>`, `${path} > ${child.tag}`)
          }
        }
        break
      }

      case 'appearance': {
        if (parentTag === 'gui') {
          err('APPEARANCE_MISPLACED', `<appearance> must be a child of a layout or shape node`, path)
        }
        for (const child of el.children) {
          const childPath = `${path} > ${child.tag}`
          if (child.tag === 'fill') {
            if (child.attrs.type === 'image' && child.attrs.src) {
              resolveRef(child.attrs.src, childPath, 'asset')
            }
            if (child.attrs.opacity !== undefined) {
              const v = Number(child.attrs.opacity)
              if (isNaN(v) || v < 0 || v > 1) {
                err('INVALID_OPACITY', `<fill> opacity must be 0–1, got "${child.attrs.opacity}"`, childPath)
              }
            }
          } else if (child.tag === 'effect') {
            if (!child.attrs.type) {
              err('MISSING_ATTR', `<effect> missing required attribute: type`, childPath)
            }
            const EFFECT_TYPES = new Set(['drop-shadow', 'inner-shadow', 'layer-blur', 'background-blur', 'glass'])
            if (child.attrs.type && !EFFECT_TYPES.has(child.attrs.type)) {
              err('INVALID_EFFECT_TYPE', `<effect> type must be drop-shadow|inner-shadow|layer-blur|background-blur|glass, got "${child.attrs.type}"`, childPath)
            }
          } else {
            warn('UNKNOWN_TAG', `Unknown element inside <appearance>: <${child.tag}>`, childPath)
          }
        }
        break
      }
    }
  }

  function validateChildren(el: El, path: string) {
    el.children.forEach(function(child, i) {
      const childPath = `${path} > ${child.tag}[${i}]`
      if (child.tag === 'appearance') {
        validateNode(child, childPath, el.tag)
      } else if (child.tag === 'slot') {
        violation('SLOT_MISPLACED', `<slot name="${child.attrs.name ?? ''}"> is only valid directly inside an <instance>`, childPath)
      } else if (CHILD_TAGS.has(child.tag)) {
        validateNode(child, childPath, el.tag)
      } else {
        warn('UNEXPECTED_CHILD', `Unexpected child <${child.tag}> inside <${el.tag}>`, childPath)
      }
    })
  }

  // Validate fonts section
  const fontsEl = root.children.find(function(c) { return c.tag === 'fonts' })
  if (fontsEl) {
    fontsEl.children.forEach(function(f, i) {
      const path = `gui > fonts > font[${i}]`
      if (f.tag !== 'font') {
        warn('UNKNOWN_TAG', `Unknown element inside <fonts>: <${f.tag}>`, path)
        return
      }
      if (!f.attrs.family) err('MISSING_ATTR', `<font> missing required attribute: family`, path)
      if (!f.attrs.source) err('MISSING_ATTR', `<font> missing required attribute: source`, path)
      if (f.attrs.source && !FONT_SOURCES.has(f.attrs.source)) {
        err('INVALID_FONT_SOURCE', `<font> source must be google|system|unresolved, got "${f.attrs.source}"`, path)
      }
    })
  }

  // Validate components section (RFC-0008 component/instance, RFC-0034 props).
  // Mirrors the parser's grammar: <component id> with an optional <props> and a
  // body layout node; <component-set id> of <variant id> entries.
  function validateProps(propsEl: El, basePath: string, body: El | undefined) {
    propsEl.children.forEach(function(p, i) {
      const pPath = `${basePath} > prop[${i}]`
      if (p.tag !== 'prop') {
        warn('UNKNOWN_TAG', `Unknown element inside <props>: <${p.tag}>`, pPath)
        return
      }
      if (!p.attrs.name) err('MISSING_ATTR', `<prop> missing required attribute: name`, pPath)
      const type = p.attrs.type
      if (!type) {
        err('MISSING_ATTR', `<prop> missing required attribute: type`, pPath)
        return
      }
      // RFC-0034: prop types are data types. The 0.1 names still render.
      if (LEGACY_PROP_TYPES[type]) {
        warn('LEGACY_PROP_TYPE', `<prop type="${type}"> is the old name; use type="${LEGACY_PROP_TYPES[type]}"`, pPath)
      } else if (!PROP_TYPES.has(type)) {
        violation('INVALID_PROP_TYPE', `<prop type="${type}"> must be one of ${[...PROP_TYPES].join(', ')}`, pPath)
      }
      if ((type === 'number' || type === 'style') && !p.attrs.bind) {
        violation('PROP_NO_BIND', `<prop name="${p.attrs.name}" type="${type}"> needs bind: a ${type} could mean several attributes`, pPath)
      }
      if (type === 'style' && p.attrs.bind && !STYLE_BINDS.has(p.attrs.bind)) {
        violation('INVALID_PROP_BIND', `<prop type="style"> bind must be one of ${[...STYLE_BINDS].join(', ')}, got "${p.attrs.bind}"`, pPath)
      }
      if (!p.attrs.target) {
        // A string prop may omit target when its name is the id of exactly
        // one <text> in the body.
        const implicit = (type === 'string' || type === 'text') && p.attrs.name && body
          ? countTextIds(body, p.attrs.name) === 1
          : false
        if (!implicit) {
          violation('PROP_NO_TARGET', `<prop name="${p.attrs.name}"> needs target: only a string prop named for exactly one <text> id may omit it`, pPath)
        }
      }
    })
  }
  function validateComponentBody(parent: El, path: string) {
    const propsEl = parent.children.find(function(c) { return c.tag === 'props' })
    const bodyEl = parent.children.find(function(c) { return c.tag !== 'props' })
    if (propsEl) validateProps(propsEl, `${path} > props`, bodyEl)
    if (bodyEl) {
      if (CHILD_TAGS.has(bodyEl.tag)) validateNode(bodyEl, `${path} > ${bodyEl.tag}`, parent.tag)
      else warn('UNEXPECTED_CHILD', `Component body must be a layout node, got <${bodyEl.tag}>`, `${path} > ${bodyEl.tag}`)
    }
  }
  const componentsEl = root.children.find(function(c) { return c.tag === 'components' })
  if (componentsEl) {
    componentsEl.children.forEach(function(comp, i) {
      const cPath = `gui > components > ${comp.tag}[${i}]`
      if (comp.tag === 'component') {
        if (!comp.attrs.id) err('MISSING_ATTR', `<component> missing required attribute: id`, cPath)
        validateComponentBody(comp, cPath)
      } else if (comp.tag === 'component-set') {
        if (!comp.attrs.id) err('MISSING_ATTR', `<component-set> missing required attribute: id`, cPath)
        comp.children.forEach(function(v, vi) {
          const vPath = `${cPath} > variant[${vi}]`
          if (v.tag !== 'variant') {
            warn('UNKNOWN_TAG', `Unknown element inside <component-set>: <${v.tag}>`, vPath)
            return
          }
          if (!v.attrs.id) err('MISSING_ATTR', `<variant> missing required attribute: id`, vPath)
          validateComponentBody(v, vPath)
        })
      } else {
        warn('UNKNOWN_TAG', `Unknown element inside <components>: <${comp.tag}>`, cPath)
      }
    })
  }

  // Validate root layout node
  const layoutRoot = root.children.find(function(c) { return CHILD_TAGS.has(c.tag) })
  if (!layoutRoot) {
    err('NO_ROOT_NODE', 'No root layout node found in <gui>. Expected <frame>, <stack>, or <group>.', 'gui')
  } else {
    validateNode(layoutRoot, `gui > ${layoutRoot.tag}`, 'gui')
  }

  // platform and source on the root (RFC-0036). Both are open strings;
  // a platform outside the recommended list is likely a typo.
  if (root.attrs.platform !== undefined && !RECOMMENDED_PLATFORMS.has(root.attrs.platform)) {
    warn('UNKNOWN_PLATFORM', `platform="${root.attrs.platform}" is not a recommended value (${[...RECOMMENDED_PLATFORMS].join(', ')})`, 'gui')
  }
  // From 0.3.6 provenance is <gui source>; <meta> is what older exports wrote.
  const parsedVersion = version ? parseVersion(version) : null
  if (parsedVersion && compareVersions(parsedVersion, [0, 3, 6]) >= 0 && root.children.some((c) => c.tag === 'meta')) {
    warn('OBSOLETE_META', '<meta> is obsolete from 0.3.6: write source="…" on <gui>, and leave out exported-at and source-node', 'gui > meta')
  }

  // Slots (RFC-0044): declared on a component's layout containers, filled by
  // name inside an instance.
  checkSlots(root, violation, warn)

  // Colors and dimensions (RFC-0033). 0.3.9 rules — errors from 0.3.9,
  // warnings before.
  checkUnits(root, parsedVersion && compareVersions(parsedVersion, [0, 3, 9]) >= 0 ? err : warn, warn)

  // Identity (RFC-0046): ids, prop target paths, and source-id. These are
  // 0.3.7 rules — errors from 0.3.7, warnings in a document written before.
  const identity = parsedVersion && compareVersions(parsedVersion, [0, 3, 7]) >= 0 ? err : warn
  checkIdentity(root, identity)

  // detached-from (RFC-0035): a reference to a declared component, on layout
  // containers only. 0.3.8 rules — errors from 0.3.8, warnings before.
  checkDetached(root, parsedVersion && compareVersions(parsedVersion, [0, 3, 8]) >= 0 ? err : warn)

  // Asset references (RFC-0043): never a data: URI, and in a standalone
  // document never a local path. These are 0.3 rules — errors in a document
  // declaring 0.3 or higher, warnings in one written before them.
  const tokenValues = new Map<string, string>()
  if (tokensEl) {
    for (const t of tokensEl.children) {
      if (t.attrs.name && t.attrs.value !== undefined) tokenValues.set(t.attrs.name, t.attrs.value)
      for (const v of Object.values(t.attrs)) {
        if (isDataUri(v) || urlFunctions(v).some(isDataUri)) {
          violation('DATA_URI', `token '${t.attrs.name}' holds a data: URI; assets are referenced, never inlined`, `gui > tokens > ${t.tag}`)
          break
        }
      }
    }
  }
  function checkAssets(el: El, path: string) {
    for (const [attr, raw] of Object.entries(el.attrs)) {
      const value = raw.startsWith('$') && tokenValues.has(raw.slice(1)) ? tokenValues.get(raw.slice(1))! : raw
      const sources = urlFunctions(value)
      if (ASSET_ATTRIBUTES.has(attr)) sources.push(value.trim())
      for (const source of sources) {
        if (!source || source.startsWith('$')) continue
        if (isDataUri(source)) {
          violation('DATA_URI', `<${el.tag} ${attr}> is a data: URI; assets are referenced, never inlined`, path)
        } else if (options.standalone && !isAbsoluteUrl(source)) {
          violation('LOCAL_ASSET_IN_STANDALONE', `<${el.tag} ${attr}="${source}"> is a local asset path, which a standalone document cannot have; use an absolute URL or package the document`, path)
        }
      }
    }
    for (const child of el.children) checkAssets(child, `${path} > ${child.tag}`)
  }
  for (const block of root.children) {
    if (block.tag !== 'tokens') checkAssets(block, `gui > ${block.tag}`)
  }

  return {
    valid: errors.length === 0,
    version,
    errors,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Slots (RFC-0044)
// ---------------------------------------------------------------------------

type Report = (code: string, message: string, path: string) => void

interface SlotComponent {
  body: El | undefined
  /** Slot containers by name. */
  slots: Map<string, El>
}

/**
 * Checks slot declarations and every instance's fills, with the native
 * renderer's rules and messages. `violation` reports an error from 0.3 (a
 * warning before); `advise` reports `slot-min` / `slot-max`, which never fail.
 */
function checkSlots(root: El, violation: Report, advise: Report) {
  const components = new Map<string, SlotComponent>()
  const sets = new Map<string, string[]>()
  const componentsEl = root.children.find((c) => c.tag === 'components')

  function declareComponent(id: string, holder: El, path: string) {
    const body = holder.children.find((c) => c.tag !== 'props')
    const slots = new Map<string, El>()
    if (body?.attrs.slot !== undefined) {
      violation('SLOT_DECLARATION', `component '${id}': a slot may not be the component's root`, path)
    }
    function collect(node: El, insideSlot: boolean) {
      for (const child of node.children) {
        const name = child.attrs.slot
        if (name === undefined) { collect(child, insideSlot); continue }
        if (insideSlot) violation('SLOT_DECLARATION', `component '${id}': slot '${name}' is declared inside another slot`, path)
        if (!SLOT_CONTAINERS.has(child.tag)) {
          violation('SLOT_DECLARATION', `component '${id}': slot '${name}' is on a <${child.tag}>, but only a layout container can be a slot`, path)
        }
        if (!name.trim()) violation('SLOT_DECLARATION', `component '${id}': a slot has an empty name`, path)
        else if (slots.has(name)) violation('SLOT_DECLARATION', `component '${id}': slot '${name}' is declared twice`, path)
        else slots.set(name, child)
        collect(child, true)
      }
    }
    if (body) collect(body, false)
    components.set(id, { body, slots })
  }

  componentsEl?.children.forEach((comp, i) => {
    const path = `gui > components > ${comp.tag}[${i}]`
    if (comp.tag === 'component' && comp.attrs.id) declareComponent(comp.attrs.id, comp, path)
    if (comp.tag === 'component-set' && comp.attrs.id) {
      const variants: string[] = []
      for (const v of comp.children) {
        if (v.tag === 'variant' && v.attrs.id) { variants.push(v.attrs.id); declareComponent(v.attrs.id, v, path) }
      }
      sets.set(comp.attrs.id, variants)
    }
  })

  /** Whether `nodes` reach an instance of `id`, through slot content or component bodies. */
  function reaches(id: string, nodes: El[], seen: Set<string>): boolean {
    for (const node of nodes) {
      if (node.tag === 'instance' && node.attrs.component) {
        const target = node.attrs.component
        if (target === id) return true
        if (!seen.has(target)) {
          seen.add(target)
          const body = components.get(target)?.body
          if (body && reaches(id, [body], seen)) return true
        }
      }
      if (reaches(id, node.children, seen)) return true
    }
    return false
  }

  function checkInstance(el: El, path: string) {
    const id = el.attrs.component
    const component = id ? components.get(id) : undefined
    if (!id || !component) return
    const filled = new Set<string>()
    for (const fill of el.children) {
      if (fill.tag !== 'slot') continue // reported where the instance is validated
      const name = fill.attrs.name
      if (!name || !name.trim()) {
        violation('SLOT_FILL', `<instance component="${id}"> has a <slot> without a name`, path)
        continue
      }
      const slot = component.slots.get(name)
      if (!slot) {
        violation('SLOT_FILL', `<instance component="${id}"> fills slot '${name}', which the component does not declare`, path)
        continue
      }
      if (filled.has(name)) {
        violation('SLOT_FILL', `<instance component="${id}"> fills slot '${name}' twice`, path)
        continue
      }
      filled.add(name)

      if (reaches(id, fill.children, new Set())) {
        violation('SLOT_SELF', `component '${id}' contains itself through slot '${name}'`, path)
      }

      const accept = slot.attrs['slot-accept']
      if (accept !== undefined) {
        const accepted = accept.split(/\s+/).filter(Boolean).flatMap((a) => sets.get(a) ?? [a])
        for (const child of fill.children) {
          // A container detached from an accepted component still fits (RFC-0035).
          const origin = child.tag === 'instance' ? child.attrs.component : child.attrs['detached-from']
          const fits = !!origin && accepted.includes(origin)
          if (!fits) {
            const what = child.tag === 'instance' && child.attrs.component ? `an instance of '${child.attrs.component}'` : `a <${child.tag}>`
            violation('SLOT_ACCEPT', `slot '${name}' of component '${id}' accepts only instances of ${accept}, but was given ${what}`, path)
          }
        }
      }

      const count = fill.children.length
      const bound = (attr: string) => {
        const n = parseInt(slot.attrs[attr] ?? '', 10)
        return Number.isFinite(n) ? n : undefined
      }
      const min = bound('slot-min')
      const max = bound('slot-max')
      if (min !== undefined && count < min) advise('SLOT_COUNT', `slot '${name}' of component '${id}' has ${count} item(s), fewer than slot-min ${min}`, path)
      if (max !== undefined && count > max) advise('SLOT_COUNT', `slot '${name}' of component '${id}' has ${count} item(s), more than slot-max ${max}`, path)
    }
  }

  function walk(el: El, path: string) {
    if (el.tag === 'instance') checkInstance(el, path)
    el.children.forEach((child, i) => walk(child, `${path} > ${child.tag}[${i}]`))
  }
  root.children.forEach((child, i) => walk(child, `gui > ${child.tag}[${i}]`))
}

// ---------------------------------------------------------------------------
// Identity (RFC-0046)
// ---------------------------------------------------------------------------

const ID_FORMAT = /^[a-z][a-z0-9-]*$/

/** Every node of one scope by id. Instances are not entered: their children are slot fills, which belong to the scope that wrote them. */
function collectScope(body: El, path: string, report: Report): Map<string, El> {
  const ids = new Map<string, El>()
  function visit(el: El, at: string) {
    const id = el.attrs.id
    if (id !== undefined) {
      if (!ID_FORMAT.test(id)) report('INVALID_ID', `id="${id}" must be lowercase kebab-case beginning with a letter`, at)
      if (ids.has(id)) report('DUPLICATE_ID', `id "${id}" is used twice in the same scope`, at)
      else ids.set(id, el)
    }
    el.children.forEach((child, i) => {
      if (child.tag === 'slot') child.children.forEach((c, j) => visit(c, `${at} > slot[${i}] > ${c.tag}[${j}]`))
      else visit(child, `${at} > ${child.tag}[${i}]`)
    })
  }
  visit(body, path)
  return ids
}

/**
 * Checks ids within each scope (the screen tree, each component and variant
 * body), component ids across the document, every prop target and path, and
 * that a document with any source-id names its source.
 */
function checkIdentity(root: El, report: Report) {
  const bodies = new Map<string, { body: El | undefined; props: El | undefined; path: string }>()
  const componentsEl = root.children.find((c) => c.tag === 'components')
  const declareBody = (holder: El, path: string) => {
    const id = holder.attrs.id
    if (!id) return
    if (bodies.has(id)) report('DUPLICATE_COMPONENT_ID', `component id "${id}" is declared twice; component ids are unique across the package`, path)
    bodies.set(id, {
      body: holder.children.find((c) => c.tag !== 'props'),
      props: holder.children.find((c) => c.tag === 'props'),
      path,
    })
  }
  if (componentsEl) {
    componentsEl.children.forEach((comp, i) => {
      const path = `gui > components > ${comp.tag}[${i}]`
      if (comp.tag === 'component') declareBody(comp, path)
      else if (comp.tag === 'component-set') {
        if (comp.attrs.id && bodies.has(comp.attrs.id)) report('DUPLICATE_COMPONENT_ID', `component id "${comp.attrs.id}" is declared twice; component ids are unique across the package`, path)
        comp.children.forEach((v, vi) => { if (v.tag === 'variant') declareBody(v, `${path} > variant[${vi}]`) })
      }
    })
  }

  const scopes = new Map<string, Map<string, El>>()
  for (const [id, c] of bodies) {
    if (c.body) scopes.set(id, collectScope(c.body, `${c.path} > ${c.body.tag}`, report))
  }
  const layoutRoot = root.children.find((c) => CHILD_TAGS.has(c.tag))
  if (layoutRoot) collectScope(layoutRoot, `gui > ${layoutRoot.tag}`, report)

  // A target is an id in the body, or a path whose every segment but the last
  // names an <instance>; the next segment is read in that instance's component.
  function resolves(path: string, scope: Map<string, El> | undefined): string | null {
    const segments = path.split('/')
    let ids = scope
    for (let i = 0; i < segments.length; i++) {
      const node = ids ? ids.get(segments[i]) : undefined
      if (!node) return `"${segments[i]}" is not an id ${i === 0 ? 'in the component body' : `in component '${segments.slice(0, i).join('/')}'`}`
      if (i === segments.length - 1) return null
      if (node.tag !== 'instance') return `"${segments[i]}" is a <${node.tag}>, but every segment but the last must name an <instance>`
      ids = scopes.get(node.attrs.component)
    }
    return null
  }
  for (const [id, c] of bodies) {
    if (!c.props) continue
    c.props.children.forEach((p, i) => {
      if (p.tag !== 'prop' || !p.attrs.target) return
      for (const target of p.attrs.target.trim().split(/\s+/)) {
        const problem = resolves(target, scopes.get(id))
        if (problem) report('UNRESOLVED_TARGET', `<prop name="${p.attrs.name}"> target "${target}" does not resolve: ${problem}`, `${c.path} > props > prop[${i}]`)
      }
    })
  }

  if (root.attrs.source === undefined) {
    const hasSourceId = (el: El): boolean => el.attrs['source-id'] !== undefined || el.children.some(hasSourceId)
    if (hasSourceId(root)) report('SOURCE_ID_NO_SOURCE', 'the document has source-id values but no source on <gui> to read them against', 'gui')
  }
}

// ---------------------------------------------------------------------------
// detached-from (RFC-0035)
// ---------------------------------------------------------------------------

/**
 * `detached-from` names a component or variant declared in the document (the
 * library is inlined before validation), and sits only on layout containers.
 * `component` belongs to `<instance>` alone.
 */
function checkDetached(root: El, report: Report) {
  const declared = new Set<string>()
  const componentsEl = root.children.find((c) => c.tag === 'components')
  if (componentsEl) {
    for (const comp of componentsEl.children) {
      if (comp.tag === 'component' && comp.attrs.id) declared.add(comp.attrs.id)
      if (comp.tag === 'component-set') {
        for (const v of comp.children) if (v.tag === 'variant' && v.attrs.id) declared.add(v.attrs.id)
      }
    }
  }
  function visit(el: El, path: string) {
    const origin = el.attrs['detached-from']
    if (origin !== undefined) {
      if (!LAYOUT_TAGS.has(el.tag)) {
        report('DETACHED_FROM_MISPLACED', `<${el.tag}> cannot carry detached-from; only a layout container (${[...LAYOUT_TAGS].join(', ')}) can${el.tag === 'instance' ? ' — an instance names its component with component' : ''}`, path)
      } else if (!declared.has(origin)) {
        report('UNRESOLVED_DETACHED_FROM', `detached-from="${origin}" names no component or variant declared in the document or its library`, path)
      }
    }
    if (el.attrs.component !== undefined && el.tag !== 'instance' && el.tag !== 'prop') {
      report('COMPONENT_ON_NON_INSTANCE', `<${el.tag} component="${el.attrs.component}">: component is only valid on <instance>; a detached container uses detached-from`, path)
    }
    el.children.forEach((child, i) => visit(child, `${path} > ${child.tag}[${i}]`))
  }
  root.children.forEach((child, i) => {
    if (child.tag !== 'tokens') visit(child, `gui > ${child.tag}[${i}]`)
  })
}

// ---------------------------------------------------------------------------
// Colors and dimensions (RFC-0033)
// ---------------------------------------------------------------------------

/**
 * Colors: every rgba() and oklch() — in a fill, a gradient stop, a token —
 * has the exact form, and rgb() warns with the hex to write. Dimensions: a
 * bare number everywhere, `%` on sizes only, and no px suffix, rem, vw/vh or
 * calc().
 */
function checkUnits(root: El, report: Report, advise: Report) {
  function checkColors(value: string, at: string) {
    for (const call of colorCalls(value)) {
      if (call.startsWith('rgb(')) {
        if (isRgbColor(call)) advise('RGB_COLOR', `${call} is not part of the format; write ${rgbToHex(call)}`, at)
        else report('INVALID_COLOR', `"${call}" is not a valid rgb() color`, at)
      } else if (call.startsWith('rgba(') ? !isRgbaColor(call) : !isOklchColor(call)) {
        report('INVALID_COLOR', `"${call}" is not a valid color: write rgba(r, g, b, a) with r, g, b 0–255 and a 0–1, or oklch(L C H) / oklch(L C H / a)`, at)
      }
    }
  }
  function checkDimension(attr: string, value: string, at: string) {
    if (value.trim().startsWith('calc(')) {
      report('INVALID_DIMENSION', `${attr}="${value}": calc() is not part of the format; use fill with padding or gap`, at)
      return
    }
    for (const part of value.trim().split(/\s+/)) {
      const unit = /^-?(?:\d+(?:\.\d+)?|\.\d+)(px|rem|em|vw|vh|%)$/.exec(part)
      if (!unit) continue
      if (unit[1] === '%') {
        if (!SIZE_ATTRS.has(attr)) report('INVALID_DIMENSION', `${attr}="${value}": % is a share of the parent, and only sizes (w, h, min-*, max-*) take it`, at)
      } else if (unit[1] === 'px') {
        report('INVALID_DIMENSION', `${attr}="${value}": write ${part.slice(0, -2)} — a bare number is pixels`, at)
      } else {
        report('INVALID_DIMENSION', `${attr}="${value}": ${unit[1]} is not a unit of the format; dimensions are bare numbers in pixels`, at)
      }
    }
  }
  function visit(el: El, at: string) {
    for (const [attr, value] of Object.entries(el.attrs)) {
      if (SIZE_ATTRS.has(attr) || DIMENSION_ATTRS.has(attr)) checkDimension(attr, value, at)
      else checkColors(value, at)
    }
    el.children.forEach((child, i) => visit(child, `${at} > ${child.tag}[${i}]`))
  }
  root.children.forEach((child, i) => visit(child, `gui > ${child.tag}[${i}]`))
}
