import Panzoom, { type PanzoomObject } from '@panzoom/panzoom'
import {
  parseXml,
  resolveTokenValue,
  type ParsedEffect,
  type FontInfo,
  type ModeAxis,
  type TokenDef,
} from '../parser'

type Ctx = {
  absolute: boolean
  offsetX?: number
  offsetY?: number
  parentDirection?: 'horizontal' | 'vertical' | 'grid'
}

let activeTokens: Record<string, string> = {}
// RFC-0037 token modes: axis table, full per-mode token defs, and the active
// mode in effect at the current point in the DOM walk (axis → value).
let activeModes: Record<string, ModeAxis> = {}
let activeTokenDefs: Record<string, TokenDef> = {}
let currentMode: Record<string, string> = {}
let activeFonts: Record<string, FontInfo> = {}
let activeStyles: Record<string, Record<string, string>> = {}
let activeFillStyles: Record<string, string> = {}
let activeEffectStyles: Record<string, ParsedEffect[]> = {}
let activeComponents: Map<string, Element> = new Map()

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
    if (!isAttrBoundary) {
      out += ch
      i++
      continue
    }

    const wsStart = i
    while (i < tag.length && /\s/.test(tag[i])) i++
    const nameStart = i
    if (!/[A-Za-z]/.test(tag[i] || '')) {
      out += tag.slice(wsStart, i + 1)
      i++
      continue
    }

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

export function normalizeBooleanAttrs(code: string): string {
  let out = ''
  let i = 0

  while (i < code.length) {
    const tagStart = code.indexOf('<', i)
    if (tagStart === -1) {
      out += code.slice(i)
      break
    }

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
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      tagEnd++
    }

    const end = tagEnd < code.length ? tagEnd + 1 : code.length
    const tag = code.slice(tagStart, end)
    if (/^<\/|^<\?|^<!/.test(tag)) {
      out += tag
    } else {
      out += normalizeTagPresenceAttrs(tag)
    }
    i = end
  }

  return out
}

function resolveToken(v: string | null): string | null {
  if (!v || v.indexOf('$') === -1) return v
  return v.replace(/\$([A-Za-z0-9_.-]+)/g, (match, name) => {
    // RFC-0037: resolve per the active mode at this node, then fall back to the
    // flat (default-mode) token map, then leave the literal $ref untouched.
    const def = activeTokenDefs[name]
    if (def) {
      const resolved = resolveTokenValue(def, activeModes, currentMode)
      if (resolved !== undefined) return resolved
    }
    return activeTokens[name] !== undefined ? activeTokens[name] : match
  })
}

/**
 * RFC-0037: compute the active mode for an element by layering its `mode-{axis}`
 * attributes over the inherited mode (nearest ancestor-or-self wins). Returns the
 * inherited object unchanged when the element pins no mode (no allocation).
 */
function computeMode(el: Element, inherited: Record<string, string>): Record<string, string> {
  let next: Record<string, string> | null = null
  for (let i = 0; i < el.attributes.length; i++) {
    const name = el.attributes[i].name
    if (name.indexOf('mode-') !== 0) continue
    const axis = name.slice(5)
    if (!activeModes[axis]) continue
    if (!next) next = { ...inherited }
    next[axis] = el.attributes[i].value
  }
  return next || inherited
}

function resolveSrc(src: string | null, assets: Record<string, string>): string | null {
  if (!src) return null
  if (assets[src]) return assets[src]
  if (src.startsWith('https://') || src.startsWith('http://') || src.startsWith('data:')) return src
  return null
}

function get(el: Element, attr: string): string | null {
  return resolveToken(el.getAttribute(attr))
}

function getRaw(el: Element, attr: string): string | null {
  return el.getAttribute(attr)
}

/** Append px to bare numbers; pass unit strings (%, rem, vw, vh, calc) through unchanged. */
function toPx(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v
}

function px(v: string | null): string {
  if (!v) return 'auto'
  if (v === 'fill') return '100%'
  if (v === 'hug') return 'fit-content'
  return toPx(v)
}

function hexToRgba(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const a = (parseInt(hex.slice(6, 8), 16) / 255).toFixed(3)
  return `rgba(${r},${g},${b},${a})`
}

function col(v: string | null): string {
  if (!v) return 'transparent'
  // rgba() and oklch() are valid CSS — pass straight through
  if (v.startsWith('rgba(') || v.startsWith('oklch(')) return v
  // Normalise 8-digit hex stops embedded inside gradient strings for broad CSS compat
  if (v.startsWith('linear-gradient') || v.startsWith('radial-gradient') || v.startsWith('conic-gradient')) {
    return v.replace(/#([0-9a-fA-F]{8})\b/g, (_, h) => hexToRgba(h))
  }
  // 8-digit hex (#RRGGBBAA) → rgba() for CSS compatibility
  if (v.length === 9 && v[0] === '#') return hexToRgba(v.slice(1))
  return v
}

// SVG fill/stroke attrs don't support CSS gradients — extract first stop colour
function colSolid(v: string | null): string {
  if (!v) return 'none'
  if (v.startsWith('linear-gradient') || v.startsWith('radial-gradient') || v.startsWith('conic-gradient')) {
    const m = v.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{6,8}/)
    return m ? col(m[0]) : 'none'
  }
  return col(v)
}

function radii(v: string | null): string {
  if (!v) return '0'
  return v.split(' ').map(toPx).join(' ')
}

function pad(v: string | null): string {
  if (!v) return '0'
  return v.split(' ').map(toPx).join(' ')
}

function shadow(v: string | null): string | null {
  if (!v) return null
  const p = v.split(' ')
  if (p.length >= 5) return `${p[0]}px ${p[1]}px ${p[2]}px ${p[3]}px ${col(p[4])}`
  return null
}

function lineHeight(v: string): string {
  // Already has a unit — pass through as-is
  if (!/^-?\d+(\.\d+)?$/.test(v)) return v
  // Bare number: ≤ 4 → unitless multiplier (e.g. 1.5 = 1.5× font size), > 4 → px
  const n = parseFloat(v)
  if (Number.isFinite(n) && n > 0 && n <= 4) return String(n)
  return `${v}px`
}

function cssString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function genericFontFallback(font: FontInfo | undefined, family: string): string {
  if (font?.source === 'system') return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  if (font?.category === 'serif') return 'serif'
  if (font?.category === 'monospace' || /mono|code|console/i.test(family)) return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  if (font?.category === 'handwriting') return 'cursive'
  return 'sans-serif'
}

function fontStack(family: string): string {
  return `${cssString(family)}, ${genericFontFallback(activeFonts[family], family)}`
}


/**
 * Apply gap to a flex stack container. Align is handled by CSS attribute selectors.
 * Returns negative gap value if present (needs margin treatment), else null.
 */
function applyGapLayout(
  div: HTMLElement,
  direction: 'horizontal' | 'vertical',
  gapRaw: string | null,
): number | null {
  if (gapRaw === null) return null

  // Parse gap: "auto"=space-between, "16"=fixed, "16 10"=main+cross
  const parts = (gapRaw === '' ? 'auto' : gapRaw).trim().split(/\s+/)
  const mainGap = parts[0]
  const crossGap = parts[1] || null

  let negativeGap: number | null = null

  if (mainGap === 'auto') {
    // Inline style overrides CSS [gap="auto"] rule, wins over align justify-content
    div.style.justifyContent = 'space-between'
  } else if (/^-\d+(\.\d+)?$/.test(mainGap)) {
    // Negative bare number → overlap gap (special margin treatment)
    negativeGap = parseFloat(mainGap)
  } else {
    const gapCss = toPx(mainGap)
    if (direction === 'horizontal') div.style.columnGap = gapCss
    else div.style.rowGap = gapCss
  }

  // Cross-axis gap (only matters when wrapping)
  if (crossGap !== null) {
    if (crossGap === 'auto') {
      div.style.alignContent = 'space-between'
    } else {
      const crossCss = toPx(crossGap)
      if (direction === 'horizontal') div.style.rowGap = crossCss
      else div.style.columnGap = crossCss
    }
  }

  return negativeGap
}

const RENDER_UTILITIES = `
/* ── Base reset ──────────────────────────────────────────────────────────── */
gui-frame, gui-stack, gui-row, gui-col, gui-grid,
gui-text, gui-img, gui-svg, gui-shape, gui-group {
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
}

/* ── Frame ───────────────────────────────────────────────────────────────── */
gui-frame { position: relative; display: block; }

/* ── Group ───────────────────────────────────────────────────────────────── */
gui-group { position: relative; display: block; }

/* ── Stack / row / col ───────────────────────────────────────────────────── */
gui-stack, gui-row, gui-col { display: flex; position: relative; }
gui-stack[direction="horizontal"], gui-row  { flex-direction: row; }
gui-stack[direction="vertical"],   gui-col,
gui-stack:not([direction])                  { flex-direction: column; }

/* ── Grid ────────────────────────────────────────────────────────────────── */
gui-grid { display: grid; position: relative; }

/* ── Wrap ────────────────────────────────────────────────────────────────── */
[wrap="true"] { flex-wrap: wrap; }

/* ── Overflow ────────────────────────────────────────────────────────────── */
[clip="true"] { overflow: hidden; }

/* ── Text ────────────────────────────────────────────────────────────────── */
/* Default to grayscale antialiasing to match Figma's text rendering. Browsers
   (esp. macOS) default to subpixel-antialiased, which renders text heavier and
   slightly wider — enough to shift line wrapping. An explicit font-smoothing
   attribute still overrides this via inline style. */
gui-text { display: block; white-space: pre-wrap; line-height: normal; font-size: initial; font-family: initial; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
gui-text[data-h-mode="hug"] { height: auto; min-height: max-content; }

/* ── Image ───────────────────────────────────────────────────────────────── */
gui-img { display: block; position: relative; }
gui-img > img { display: block; width: 100%; height: 100%; }
gui-img[fit="cover"]   > img { object-fit: cover; }
gui-img[fit="contain"] > img { object-fit: contain; }
gui-img[fit="fill"]    > img { object-fit: fill; }
gui-img[fit="none"]    > img { object-fit: none; }

/* ── Sizing ──────────────────────────────────────────────────────────────── */
[data-w-mode="fixed"] { width: var(--gui-w); flex-shrink: 0; }
[data-w-mode="hug"]   { width: fit-content; flex-shrink: 0; }
[data-w-mode="fill"]  { width: 100%; }
[data-h-mode="fixed"] { height: var(--gui-h); flex-shrink: 0; }
[data-h-mode="hug"]   { height: fit-content; }
[data-h-mode="fill"]  { height: 100%; }

/* Fill / hug adjusted for flex parent direction */
[data-parent-dir="horizontal"][data-w-mode="fill"] { flex: 1 1 0; width: auto; min-width: 0; flex-shrink: 1; }
[data-parent-dir="horizontal"][data-w-mode="hug"]  { width: auto; }
[data-parent-dir="vertical"][data-h-mode="fill"]   { flex: 1 1 0; height: auto; min-height: 0; flex-shrink: 1; }
[data-parent-dir="vertical"][data-h-mode="hug"]    { height: auto; }

/* ── Position ────────────────────────────────────────────────────────────── */
[data-pos="absolute"] { position: absolute; left: var(--gui-x, 0px); top: var(--gui-y, 0px); }

/* ── 9-point align — horizontal stacks ──────────────────────────────────── */
gui-stack[direction="horizontal"][align="top-left"],      gui-row[align="top-left"]      { align-items: flex-start; justify-content: flex-start; }
gui-stack[direction="horizontal"][align="top-center"],    gui-row[align="top-center"]    { align-items: flex-start; justify-content: center; }
gui-stack[direction="horizontal"][align="top-right"],     gui-row[align="top-right"]     { align-items: flex-start; justify-content: flex-end; }
gui-stack[direction="horizontal"][align="middle-left"],   gui-row[align="middle-left"]   { align-items: center; justify-content: flex-start; }
gui-stack[direction="horizontal"][align="middle-center"], gui-row[align="middle-center"] { align-items: center; justify-content: center; }
gui-stack[direction="horizontal"][align="middle-right"],  gui-row[align="middle-right"]  { align-items: center; justify-content: flex-end; }
gui-stack[direction="horizontal"][align="bottom-left"],   gui-row[align="bottom-left"]   { align-items: flex-end; justify-content: flex-start; }
gui-stack[direction="horizontal"][align="bottom-center"], gui-row[align="bottom-center"] { align-items: flex-end; justify-content: center; }
gui-stack[direction="horizontal"][align="bottom-right"],  gui-row[align="bottom-right"]  { align-items: flex-end; justify-content: flex-end; }
gui-stack[direction="horizontal"][align="stretch"],  gui-row[align="stretch"]  { align-items: stretch; }
gui-stack[direction="horizontal"][align="baseline"], gui-row[align="baseline"] { align-items: baseline; }

/* ── 9-point align — vertical stacks ────────────────────────────────────── */
gui-stack[direction="vertical"][align="top-left"],      gui-col[align="top-left"]      { justify-content: flex-start; align-items: flex-start; }
gui-stack[direction="vertical"][align="top-center"],    gui-col[align="top-center"]    { justify-content: flex-start; align-items: center; }
gui-stack[direction="vertical"][align="top-right"],     gui-col[align="top-right"]     { justify-content: flex-start; align-items: flex-end; }
gui-stack[direction="vertical"][align="middle-left"],   gui-col[align="middle-left"]   { justify-content: center; align-items: flex-start; }
gui-stack[direction="vertical"][align="middle-center"], gui-col[align="middle-center"] { justify-content: center; align-items: center; }
gui-stack[direction="vertical"][align="middle-right"],  gui-col[align="middle-right"]  { justify-content: center; align-items: flex-end; }
gui-stack[direction="vertical"][align="bottom-left"],   gui-col[align="bottom-left"]   { justify-content: flex-end; align-items: flex-start; }
gui-stack[direction="vertical"][align="bottom-center"], gui-col[align="bottom-center"] { justify-content: flex-end; align-items: center; }
gui-stack[direction="vertical"][align="bottom-right"],  gui-col[align="bottom-right"]  { justify-content: flex-end; align-items: flex-end; }
gui-stack[direction="vertical"][align="stretch"],  gui-col[align="stretch"]  { align-items: stretch; }

/* Default alignment (top-left) when no align attr — prevents CSS stretch default */
gui-stack[direction="horizontal"]:not([align]), gui-row:not([align]) { align-items: flex-start; justify-content: flex-start; }
gui-stack[direction="vertical"]:not([align]),   gui-col:not([align]) { justify-content: flex-start; align-items: flex-start; }

/* gap="auto" → space-between (inline style overrides this when combined with numeric align) */
gui-stack[gap="auto"], gui-row[gap="auto"], gui-col[gap="auto"] { justify-content: space-between; }

/* ── Internal overlay utilities (used by renderer for fill/stroke layers) ── */
.gui-layer               { position: absolute; inset: 0; pointer-events: none; z-index: 0; }
.gui-pointer-events-none { pointer-events: none; }
.gui-block               { display: block; }
.gui-w-full              { width: 100%; }
.gui-h-full              { height: 100%; }
.gui-overflow-hidden     { overflow: hidden; }
.gui-overflow-visible    { overflow: visible; }
.gui-pre-wrap            { white-space: pre-wrap; }
.gui-fit-fill            { object-fit: fill; }
.gui-fit-cover           { object-fit: cover; }
.gui-fit-contain         { object-fit: contain; }
.gui-fit-none            { object-fit: none; }
.gui-relative            { position: relative; }
`

function ensureRenderUtilities(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-gui-render-utilities]')) return

  const style = document.createElement('style')
  style.setAttribute('data-gui-render-utilities', 'true')
  style.textContent = RENDER_UTILITIES
  document.head.appendChild(style)
}

function addClass(el: HTMLElement | SVGElement, name: string): void {
  el.classList.add(name)
}

let clipId = 0
let squircleId = 0

/**
 * Build the path string for a squircle shape at (0,0)..(w,h).
 * Faithful port of the figma-squircle algorithm (phamfoo/figma-squircle),
 * which itself implements Figma's "desperately seeking squircles" geometry.
 * smoothing: 0 = plain rounded rect, 1 = maximum iOS-style smoothing.
 */
function squirclePath(w: number, h: number, r: number, smoothing: number): string {
  const round = (n: number) => Math.round(n * 1e4) / 1e4
  const toRad = (deg: number) => (deg * Math.PI) / 180

  const budget = Math.min(w, h) / 2
  const cornerRadius = Math.min(Math.max(r, 0), budget)
  if (cornerRadius <= 0) {
    return `M 0 0 L ${round(w)} 0 L ${round(w)} ${round(h)} L 0 ${round(h)} Z`
  }

  let cornerSmoothing = Math.min(1, Math.max(0, smoothing))
  let p = (1 + cornerSmoothing) * cornerRadius
  // No preserve-smoothing: keep the corner inside the available budget.
  const maxCornerSmoothing = budget / cornerRadius - 1
  cornerSmoothing = Math.max(0, Math.min(cornerSmoothing, maxCornerSmoothing))
  p = Math.min(p, budget)

  const arcMeasure = 90 * (1 - cornerSmoothing)
  const arcSectionLength = Math.sin(toRad(arcMeasure / 2)) * cornerRadius * Math.SQRT2
  const angleAlpha = (90 - arcMeasure) / 2
  const p3ToP4Distance = cornerRadius * Math.tan(toRad(angleAlpha / 2))
  const angleBeta = 45 * cornerSmoothing
  const c = p3ToP4Distance * Math.cos(toRad(angleBeta))
  const d = c * Math.tan(toRad(angleBeta))
  const b = (p - arcSectionLength - c - d) / 3
  const a = 2 * b

  const cr = cornerRadius
  const arc = arcSectionLength
  // Relative cubic + arc segments for each corner, per figma-squircle's draw.ts.
  const topRight = `c ${round(a)} 0 ${round(a + b)} 0 ${round(a + b + c)} ${round(d)} ` +
    `a ${round(cr)} ${round(cr)} 0 0 1 ${round(arc)} ${round(arc)} ` +
    `c ${round(d)} ${round(c)} ${round(d)} ${round(b + c)} ${round(d)} ${round(a + b + c)}`
  const bottomRight = `c 0 ${round(a)} 0 ${round(a + b)} ${round(-d)} ${round(a + b + c)} ` +
    `a ${round(cr)} ${round(cr)} 0 0 1 ${round(-arc)} ${round(arc)} ` +
    `c ${round(-c)} ${round(d)} ${round(-(b + c))} ${round(d)} ${round(-(a + b + c))} ${round(d)}`
  const bottomLeft = `c ${round(-a)} 0 ${round(-(a + b))} 0 ${round(-(a + b + c))} ${round(-d)} ` +
    `a ${round(cr)} ${round(cr)} 0 0 1 ${round(-arc)} ${round(-arc)} ` +
    `c ${round(-d)} ${round(-c)} ${round(-d)} ${round(-(b + c))} ${round(-d)} ${round(-(a + b + c))}`
  const topLeft = `c 0 ${round(-a)} 0 ${round(-(a + b))} ${round(d)} ${round(-(a + b + c))} ` +
    `a ${round(cr)} ${round(cr)} 0 0 1 ${round(arc)} ${round(-arc)} ` +
    `c ${round(c)} ${round(-d)} ${round(b + c)} ${round(-d)} ${round(a + b + c)} ${round(-d)}`

  return `M ${round(w - p)} 0 ${topRight} ` +
    `L ${round(w)} ${round(h - p)} ${bottomRight} ` +
    `L ${round(p)} ${round(h)} ${bottomLeft} ` +
    `L 0 ${round(p)} ${topLeft} Z`
}

/**
 * Generate a squircle SVG clipPath element and return [svgEl, clipId].
 * smoothing: 0 = regular rounded rect, 1 = pure squircle (iOS-style).
 */
function buildSquircleClipPath(w: number, h: number, r: number, smoothing: number): [SVGElement, string] {
  const id = `gui-squircle-${++squircleId}`
  const ns = 'http://www.w3.org/2000/svg'
  const d = squirclePath(w, h, r, smoothing)

  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.style.pointerEvents = 'none'

  const defs = document.createElementNS(ns, 'defs')
  const clipPath = document.createElementNS(ns, 'clipPath')
  clipPath.setAttribute('id', id)
  clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', d)
  clipPath.appendChild(path)
  defs.appendChild(clipPath)
  svg.appendChild(defs)

  return [svg as unknown as SVGElement, id]
}

/**
 * Render an SVG stroke that traces the squircle path.
 *
 * CSS clip-path clips both children and box-shadows of the element, so neither
 * approach from strokeStyle works on squircle elements. This function appends
 * an SVG overlay:
 *   - inside: draw 2× stroke, clip to squircle interior → stroke stays inside
 *   - center: draw 1× stroke centered on path; clip to squircle → inner half visible
 *   - outside: cannot render inside the clipped element; caller must use a wrapper
 *
 * Returns true if the stroke was rendered, false if the caller must handle it
 * externally (squircle + outside/center-with-visible-outer-half).
 */
function squircleStrokeOverlay(
  target: HTMLElement,
  w: number, h: number, r: number, smoothing: number,
  strokeWidth: number, color: string, align: string,
  opacity?: string | null, blend?: string | null,
): void {
  const ns = 'http://www.w3.org/2000/svg'
  const d = squirclePath(w, h, r, smoothing)

  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  svg.style.position = 'absolute'
  svg.style.left = '0'
  svg.style.top = '0'
  svg.style.overflow = 'visible'
  svg.style.pointerEvents = 'none'
  svg.style.zIndex = '2'
  if (opacity) svg.style.opacity = opacity
  if (blend) svg.style.mixBlendMode = blend as string

  // Clip path: squircle interior (used for inside; center clips outer half away)
  const clipId = `gui-ssclip-${++squircleId}`
  const defs = document.createElementNS(ns, 'defs')
  const clipPathEl = document.createElementNS(ns, 'clipPath')
  clipPathEl.setAttribute('id', clipId)
  clipPathEl.setAttribute('clipPathUnits', 'userSpaceOnUse')
  const clipShape = document.createElementNS(ns, 'path')
  clipShape.setAttribute('d', d)
  clipPathEl.appendChild(clipShape)
  defs.appendChild(clipPathEl)
  svg.appendChild(defs)

  const pathEl = document.createElementNS(ns, 'path')
  pathEl.setAttribute('d', d)
  pathEl.setAttribute('fill', 'none')
  pathEl.setAttribute('stroke', col(color))

  if (align === 'inside') {
    // Double stroke-width, clipped to interior → full width visible inside
    pathEl.setAttribute('stroke-width', String(strokeWidth * 2))
    pathEl.setAttribute('clip-path', `url(#${clipId})`)
  } else {
    // center (or outside — outside not renderable inside clip-path, show center as fallback)
    pathEl.setAttribute('stroke-width', String(strokeWidth))
    pathEl.setAttribute('clip-path', `url(#${clipId})`)
  }

  svg.appendChild(pathEl)
  target.appendChild(svg)
}

function applyCornerSmoothing(el: HTMLElement, guiEl: Element): void {
  const smoothingAttr = get(guiEl, 'corner-smoothing')
  if (!smoothingAttr) return
  const smoothing = parseFloat(smoothingAttr)
  if (!Number.isFinite(smoothing) || smoothing <= 0) return

  const rAttr = get(guiEl, 'radius')
  if (!rAttr) return
  const r = parseFloat(rAttr)
  if (!Number.isFinite(r) || r <= 0) return

  const wAttr = get(guiEl, 'w')
  const hAttr = get(guiEl, 'h')
  const w = wAttr ? parseFloat(wAttr) : NaN
  const h = hAttr ? parseFloat(hAttr) : NaN
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return

  // Remove regular border-radius — squircle clip-path takes over
  el.style.borderRadius = ''

  const [svgEl, id] = buildSquircleClipPath(w, h, r, smoothing)
  el.insertBefore(svgEl as unknown as Node, el.firstChild)
  el.style.clipPath = `url(#${id})`
}

function position(el: HTMLElement | SVGElement, guiEl: Element, ctx: Ctx): void {
  const wVal = get(guiEl, 'w')
  const hVal = get(guiEl, 'h')
  const sizingW = wVal === null || wVal === 'hug' ? 'hug' : wVal === 'fill' ? 'fill' : 'fixed'
  const sizingH = hVal === null || hVal === 'hug' ? 'hug' : hVal === 'fill' ? 'fill' : 'fixed'

  el.setAttribute('data-w-mode', sizingW)
  el.setAttribute('data-h-mode', sizingH)

  // Pass an editor-supplied node id through to the rendered element so tools can
  // map a clicked canvas element back to its source node. No-op when absent.
  const uid = getRaw(guiEl, 'data-uid')
  if (uid !== null) el.setAttribute('data-uid', uid)
  if (sizingW === 'fixed') el.style.setProperty('--gui-w', toPx(wVal!))
  if (sizingH === 'fixed') el.style.setProperty('--gui-h', toPx(hVal!))

  if (ctx.parentDirection) el.setAttribute('data-parent-dir', ctx.parentDirection)

  const minW = get(guiEl, 'min-width')
  const maxW = get(guiEl, 'max-width')
  const minH = get(guiEl, 'min-height')
  const maxH = get(guiEl, 'max-height')
  if (minW) el.style.minWidth = toPx(minW)
  if (maxW) el.style.maxWidth = toPx(maxW)
  if (minH) el.style.minHeight = toPx(minH)
  if (maxH) el.style.maxHeight = toPx(maxH)

  const op = get(guiEl, 'opacity')
  if (op) el.style.opacity = op

  const blend = get(guiEl, 'blend')
  if (blend) el.style.mixBlendMode = blend as CSSStyleDeclaration['mixBlendMode']

  const maskVal = getRaw(guiEl, 'mask')
  if (maskVal !== null && maskVal !== 'false') el.setAttribute('data-mask', 'true')

  rotationStyle(el, guiEl)

  const filterVal = get(guiEl, 'filter')
  if (filterVal) (el as HTMLElement).style.filter = filterVal

  const isolationVal = get(guiEl, 'isolation')
  if (isolationVal && isolationVal !== 'false') (el as HTMLElement).style.isolation = 'isolate'

  const aspectRatio = get(guiEl, 'aspect-ratio')
  if (aspectRatio) (el as HTMLElement).style.aspectRatio = aspectRatio

  const zIndex = get(guiEl, 'z-index')
  if (zIndex) (el as HTMLElement).style.zIndex = zIndex

  const visibleVal = get(guiEl, 'visible')
  if (visibleVal === 'false') (el as HTMLElement).style.display = 'none'

  if (ctx.absolute) {
    const x = parseFloat(get(guiEl, 'x') || '0') - (ctx.offsetX || 0)
    const y = parseFloat(get(guiEl, 'y') || '0') - (ctx.offsetY || 0)
    el.setAttribute('data-pos', 'absolute')
    el.style.setProperty('--gui-x', `${x}px`)
    el.style.setProperty('--gui-y', `${y}px`)
  }
}

const TRANSFORM_ORIGIN_MAP: Record<string, string> = {
  'top-left':      '0% 0%',
  'top-center':    '50% 0%',
  'top-right':     '100% 0%',
  'middle-left':   '0% 50%',
  'center':        '50% 50%',
  'middle-center': '50% 50%',
  'middle-right':  '100% 50%',
  'bottom-left':   '0% 100%',
  'bottom-center': '50% 100%',
  'bottom-right':  '100% 100%',
}

function applyTransform(el: HTMLElement | SVGElement, guiEl: Element): void {
  const rotation = get(guiEl, 'rotation')
  const flip = get(guiEl, 'flip')
  const scaleX = get(guiEl, 'scale-x')
  const scaleY = get(guiEl, 'scale-y')
  const skewX = get(guiEl, 'skew-x')
  const skewY = get(guiEl, 'skew-y')

  const parts: string[] = []

  const deg = rotation ? parseFloat(rotation) : 0
  if (Number.isFinite(deg) && deg !== 0) parts.push(`rotate(${deg}deg)`)

  if (flip === 'h') parts.push('scaleX(-1)')
  else if (flip === 'v') parts.push('scaleY(-1)')
  else if (flip === 'both') parts.push('scaleX(-1) scaleY(-1)')

  if (scaleX !== null) {
    const sx = parseFloat(scaleX)
    if (Number.isFinite(sx)) parts.push(`scaleX(${sx})`)
  }
  if (scaleY !== null) {
    const sy = parseFloat(scaleY)
    if (Number.isFinite(sy)) parts.push(`scaleY(${sy})`)
  }

  if (skewX !== null) {
    const sx = parseFloat(skewX)
    if (Number.isFinite(sx)) parts.push(`skewX(${sx}deg)`)
  }
  if (skewY !== null) {
    const sy = parseFloat(skewY)
    if (Number.isFinite(sy)) parts.push(`skewY(${sy}deg)`)
  }

  if (parts.length > 0) {
    el.style.transform = parts.join(' ')
    ;(el.style as CSSStyleDeclaration & { transformBox?: string }).transformBox = 'fill-box'
  }

  // transform-origin
  const toRaw = get(guiEl, 'transform-origin')
  if (toRaw) {
    el.style.transformOrigin = TRANSFORM_ORIGIN_MAP[toRaw] || toRaw
  } else if (parts.length > 0) {
    el.style.transformOrigin = 'center'
  }
}

function rotationStyle(el: HTMLElement | SVGElement, guiEl: Element): void {
  applyTransform(el, guiEl)
}

function normalizedRightAngle(el: Element): number | null {
  const rotation = get(el, 'rotation')
  const degrees = rotation ? parseFloat(rotation) : 0
  if (!Number.isFinite(degrees)) return null

  const normalized = ((degrees % 360) + 360) % 360
  const rounded = Math.round(normalized / 90) * 90
  if (Math.abs(normalized - rounded) > 0.001) return null
  return rounded % 360
}

function parseBorder(val: string): { color: string; width: number; style: string; align: string } | null {
  const ALIGN = new Set(['inside', 'outside', 'center'])
  const STYLE = new Set(['solid', 'dashed', 'dotted'])
  let color = '', width = 1, style = 'solid', align = 'center'
  for (const tok of val.trim().split(/\s+/)) {
    if (tok.startsWith('#') || tok.startsWith('$') || /^rgba?/.test(tok)) color = tok
    else if (ALIGN.has(tok)) align = tok
    else if (STYLE.has(tok)) style = tok
    else if (/^\d/.test(tok)) width = parseFloat(tok)
  }
  return color ? { color, width, style, align } : null
}

/**
 * Wrap `el` in a relative-positioned container so that an outside stroke SVG
 * can be appended as a sibling — escaping the element's clip-path boundary.
 * Transfers layout attributes/styles needed by the flex system to the wrapper.
 */
function wrapForOutsideStroke(el: HTMLElement): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.style.position = 'relative'

  // Transfer flex/sizing attributes so the wrapper participates in layout correctly
  for (const attr of ['data-w-mode', 'data-h-mode', 'data-parent-dir']) {
    const v = el.getAttribute(attr)
    if (v !== null) { wrapper.setAttribute(attr, v); el.removeAttribute(attr) }
  }
  // Transfer sizing CSS variables and flex-related inline styles
  const toTransfer = ['--gui-w', '--gui-h', 'width', 'height', 'flexShrink', 'flexGrow', 'alignSelf',
    'justifySelf', 'marginLeft', 'marginTop', 'marginRight', 'marginBottom',
    'gridColumn', 'gridRow', 'zIndex', 'position', 'left', 'top', 'right', 'bottom', 'transform', 'transformOrigin']
  for (const prop of toTransfer) {
    if (prop.startsWith('--')) {
      const v = el.style.getPropertyValue(prop)
      if (v) { wrapper.style.setProperty(prop, v); el.style.removeProperty(prop) }
    } else {
      const key = prop as keyof CSSStyleDeclaration
      const v = el.style[key] as string
      if (v) { (wrapper.style as unknown as Record<string, string>)[prop] = v; (el.style as unknown as Record<string, string>)[prop] = '' }
    }
  }
  // Transfer positioning classes (gui-absolute, gui-relative, etc.)
  for (const cls of ['gui-absolute', 'gui-relative', 'gui-fill-w', 'gui-fill-h']) {
    if (el.classList.contains(cls)) { wrapper.classList.add(cls); el.classList.remove(cls) }
  }
  // Inner element fills wrapper exactly
  el.style.position = 'absolute'
  el.style.inset = '0'

  wrapper.appendChild(el)
  return wrapper
}

function strokeStyle(el: HTMLElement, guiEl: Element, radius?: string | null): HTMLElement | null {
  // <appearance><border> stack takes full ownership — skip the shorthand path
  if (hasAppearanceBorder(guiEl)) return null

  const borderVal = get(guiEl, 'border')
  let color: string, width: number, align: string, style: string

  if (borderVal) {
    const parsed = parseBorder(borderVal)
    if (!parsed) return null
    color = parsed.color
    width = parsed.width
    align = parsed.align
    style = parsed.style
  } else {
    // Legacy fallback for files using stroke= / stroke-width=
    const s = get(guiEl, 'stroke')
    const sw = get(guiEl, 'stroke-width')
    if (!s || !sw) return null
    color = s
    width = parseFloat(sw)
    align = get(guiEl, 'stroke-position') || 'center'
    style = 'solid'
  }

  if (!Number.isFinite(width) || width <= 0) return null

  // Detect squircle — corner-smoothing removes border-radius and uses clip-path.
  // clip-path clips both children and box-shadows, so we need SVG-based strokes.
  const smoothingAttr = get(guiEl, 'corner-smoothing')
  const rAttr = get(guiEl, 'radius')
  const wAttr = get(guiEl, 'w')
  const hAttr = get(guiEl, 'h')
  const smoothing = smoothingAttr ? parseFloat(smoothingAttr) : NaN
  const sqR = rAttr ? parseFloat(rAttr) : NaN
  const sqW = wAttr ? parseFloat(wAttr) : NaN
  const sqH = hAttr ? parseFloat(hAttr) : NaN
  const isSquircle = Number.isFinite(smoothing) && smoothing > 0
    && Number.isFinite(sqR) && sqR > 0
    && Number.isFinite(sqW) && sqW > 0
    && Number.isFinite(sqH) && sqH > 0

  if (isSquircle && style === 'solid') {
    if (align === 'outside' || align === 'center') {
      // Outside/center strokes extend beyond the element — they cannot be rendered
      // as children because the parent's clip-path clips all children.
      // Wrap el in a relative container, then append the SVG stroke as a sibling.
      const wrapper = wrapForOutsideStroke(el)
      const outset = align === 'outside' ? width : width / 2
      const ns = 'http://www.w3.org/2000/svg'
      const totalW = sqW + outset * 2
      const totalH = sqH + outset * 2

      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('width', String(totalW))
      svg.setAttribute('height', String(totalH))
      svg.style.position = 'absolute'
      svg.style.left = `${-outset}px`
      svg.style.top = `${-outset}px`
      svg.style.overflow = 'visible'
      svg.style.pointerEvents = 'none'
      svg.style.zIndex = '2'
      addClass(svg as unknown as HTMLElement, 'gui-pointer-events-none')

      const d = squirclePath(sqW, sqH, sqR, smoothing)

      if (align === 'outside') {
        // evenodd clip: large rect minus squircle interior → stroke only outside
        const clipId = `gui-ssclip-${++squircleId}`
        const defs = document.createElementNS(ns, 'defs')
        const cp = document.createElementNS(ns, 'clipPath')
        cp.setAttribute('id', clipId)
        cp.setAttribute('clipPathUnits', 'userSpaceOnUse')
        const cs = document.createElementNS(ns, 'path')
        cs.setAttribute('d', `M -9999 -9999 H 99999 V 99999 H -9999 Z ${d}`)
        cs.setAttribute('fill-rule', 'evenodd')
        cp.appendChild(cs); defs.appendChild(cp); svg.appendChild(defs)

        const g = document.createElementNS(ns, 'g')
        g.setAttribute('transform', `translate(${outset},${outset})`)
        const pathEl = document.createElementNS(ns, 'path')
        pathEl.setAttribute('d', d)
        pathEl.setAttribute('fill', 'none')
        pathEl.setAttribute('stroke', col(color))
        pathEl.setAttribute('stroke-width', String(width * 2))
        pathEl.setAttribute('clip-path', `url(#${clipId})`)
        g.appendChild(pathEl); svg.appendChild(g)
      } else {
        // Center: stroke straddles the squircle edge — clip to interior so only inner half shows
        const clipId = `gui-ssclip-${++squircleId}`
        const defs = document.createElementNS(ns, 'defs')
        const cp = document.createElementNS(ns, 'clipPath')
        cp.setAttribute('id', clipId)
        cp.setAttribute('clipPathUnits', 'userSpaceOnUse')
        const cs = document.createElementNS(ns, 'path')
        cs.setAttribute('d', d)
        cp.appendChild(cs); defs.appendChild(cp); svg.appendChild(defs)

        const g = document.createElementNS(ns, 'g')
        g.setAttribute('transform', `translate(${outset},${outset})`)
        const pathEl = document.createElementNS(ns, 'path')
        pathEl.setAttribute('d', d)
        pathEl.setAttribute('fill', 'none')
        pathEl.setAttribute('stroke', col(color))
        pathEl.setAttribute('stroke-width', String(width))
        g.appendChild(pathEl); svg.appendChild(g)
      }

      wrapper.appendChild(svg)
      return wrapper
    } else {
      // Inside: SVG child clipped to squircle interior — stays within clip-path, works correctly
      squircleStrokeOverlay(el, sqW, sqH, sqR, smoothing, width, color, 'inside')
      return null
    }
  }

  // Regular border-radius: use box-shadow — not clipped by overflow:hidden,
  // follows border-radius automatically.
  if (style === 'solid') {
    let shadowVal: string
    if (align === 'inside') {
      shadowVal = `inset 0 0 0 ${width}px ${col(color)}`
    } else if (align === 'outside') {
      shadowVal = `0 0 0 ${width}px ${col(color)}`
    } else {
      shadowVal = `inset 0 0 0 ${width / 2}px ${col(color)}, 0 0 0 ${width / 2}px ${col(color)}`
    }
    appendBoxShadow(el, shadowVal)
    return null
  }

  // Non-solid (dashed/dotted): overlay div fallback
  const outset = align === 'outside' ? width : align === 'center' ? width / 2 : 0
  const stroke = document.createElement('div')

  stroke.style.position = 'absolute'
  addClass(stroke, 'gui-pointer-events-none')
  stroke.style.left = `${-outset}px`
  stroke.style.top = `${-outset}px`
  stroke.style.right = `${-outset}px`
  stroke.style.bottom = `${-outset}px`
  stroke.style.border = `${width}px ${style} ${col(color)}`
  stroke.style.boxSizing = 'border-box'
  stroke.style.zIndex = '2'
  if (radius) stroke.style.borderRadius = radius

  el.appendChild(stroke)
  return null
}

const BORDER_SIDES = [
  { attr: 'border-top',    prop: 'borderTop'    },
  { attr: 'border-right',  prop: 'borderRight'  },
  { attr: 'border-bottom', prop: 'borderBottom' },
  { attr: 'border-left',   prop: 'borderLeft'   },
] as const

function strokePerSideStyle(el: HTMLElement, guiEl: Element, radius?: string | null): void {
  const active = BORDER_SIDES.filter(s => get(guiEl, s.attr) !== null)
  if (!active.length) return

  const overlay = document.createElement('div')
  overlay.style.position = 'absolute'
  overlay.style.left = '0'
  overlay.style.top = '0'
  overlay.style.right = '0'
  overlay.style.bottom = '0'
  overlay.style.boxSizing = 'border-box'
  addClass(overlay, 'gui-pointer-events-none')
  overlay.style.zIndex = '2'
  if (radius) overlay.style.borderRadius = radius

  for (const { attr, prop } of active) {
    const val = get(guiEl, attr)
    if (!val) continue
    const parsed = parseBorder(val)
    if (!parsed) continue
    overlay.style[prop] = `${parsed.width}px ${parsed.style} ${col(parsed.color)}`
  }

  el.appendChild(overlay)
}

function appendBoxShadow(el: HTMLElement, value: string): void {
  el.style.boxShadow = el.style.boxShadow
    ? `${el.style.boxShadow}, ${value}`
    : value
}

function appendFilter(el: HTMLElement, prop: 'filter' | 'backdropFilter', value: string): void {
  el.style[prop] = el.style[prop] ? `${el.style[prop]} ${value}` : value
  if (prop === 'backdropFilter') {
    ;(el.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = el.style[prop]
  }
}

function appearanceEl(el: Element): Element | null {
  return Array.from(el.children).find(child => child.tagName === 'appearance') || null
}

function hasAppearance(el: Element): boolean {
  return !!appearanceEl(el)
}

function hasAppearanceFill(el: Element): boolean {
  const appearance = appearanceEl(el)
  if (!appearance) return false
  return Array.from(appearance.children).some(child => child.tagName === 'fill')
}

function hasAppearanceBorder(el: Element): boolean {
  const appearance = appearanceEl(el)
  if (!appearance) return false
  return Array.from(appearance.children).some(child => child.tagName === 'border')
}

function isGradientFill(type: string | null, value?: string | null): boolean {
  if (!type) return false
  return type === 'linear-gradient' || type === 'radial-gradient' || type === 'angular-gradient'
    || type.startsWith('gradient')
    || (type === 'color' && !!value && (
        value.startsWith('linear-gradient') ||
        value.startsWith('radial-gradient') ||
        value.startsWith('conic-gradient')
      ))
}

function getAppearanceGradientFill(el: Element): string | null {
  const appearance = appearanceEl(el)
  if (!appearance) return null
  for (const child of Array.from(appearance.children)) {
    if (child.tagName !== 'fill') continue
    if (get(child, 'visible') === 'false') continue
    const type = get(child, 'type')
    const value = get(child, 'value')
    const gradient = get(child, 'gradient')
    if (isGradientFill(type, value)) {
      // For gradient types, use the value or gradient attr
      return gradient || value
    }
  }
  return null
}

function renderBorderElement(target: HTMLElement, borderEl: Element, radius?: string | null): void {
  // Skip hidden borders
  if (get(borderEl, 'visible') === 'false') return

  const color = get(borderEl, 'color')
  const paint = get(borderEl, 'paint')
  const widthStr = get(borderEl, 'w') || '1'
  const width = parseFloat(widthStr)
  if (!Number.isFinite(width) || width <= 0) return

  // Resolve the border colour: prefer explicit color, fall back to paint (extract solid from gradient)
  const borderColor = color ? col(color) : (paint ? colSolid(paint) : null)
  if (!borderColor) return

  const align = get(borderEl, 'align') || 'center'
  const style = get(borderEl, 'style') || 'solid'
  const outset = align === 'outside' ? width : align === 'center' ? width / 2 : 0

  const stroke = document.createElement('div')
  stroke.style.position = 'absolute'
  addClass(stroke, 'gui-pointer-events-none')
  stroke.style.left = `${-outset}px`
  stroke.style.top = `${-outset}px`
  stroke.style.right = `${-outset}px`
  stroke.style.bottom = `${-outset}px`
  stroke.style.border = `${width}px ${style} ${borderColor}`
  stroke.style.boxSizing = 'border-box'
  stroke.style.zIndex = '2'
  if (radius) stroke.style.borderRadius = radius

  const opacity = get(borderEl, 'opacity')
  if (opacity) stroke.style.opacity = opacity

  const blend = get(borderEl, 'blend')
  if (blend) stroke.style.mixBlendMode = blend as CSSStyleDeclaration['mixBlendMode']

  target.appendChild(stroke)
}

function multiplyColorAlpha(color: string, factor: number): string {
  // rgba(r,g,b,a) — multiply a by factor
  const m = color.match(/rgba?\((\d+),(\d+),(\d+)(?:,([0-9.]+))?\)/)
  if (m) {
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1
    return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + (a * factor).toFixed(3) + ')'
  }
  return color
}

// Render a ParsedEffect plain object (from named effect styles via gui-parser)
function applyEffectData(target: HTMLElement, effect: ParsedEffect): void {
  if (effect.visible === false) return

  const type = effect.type
  const radius = String(effect.radius ?? 0)
  const opacityFactor = typeof effect.opacity === 'number' ? effect.opacity : 1

  if (type === 'drop-shadow' || type === 'inner-shadow') {
    const x = String(effect.x ?? 0)
    const y = String(effect.y ?? 0)
    const spread = String(effect.spread ?? 0)
    let color = col(effect.color ?? null)
    if (opacityFactor !== 1 && Number.isFinite(opacityFactor)) color = multiplyColorAlpha(color, opacityFactor)
    appendBoxShadow(target, (type === 'inner-shadow' ? 'inset ' : '') + x + 'px ' + y + 'px ' + radius + 'px ' + spread + 'px ' + color)
  } else if (type === 'layer-blur') {
    appendFilter(target, 'filter', 'blur(' + radius + 'px)')
  } else if (type === 'background-blur' || type === 'glass') {
    const saturation = String((effect as unknown as Record<string, unknown>)['saturation'] ?? 180)
    appendFilter(target, 'backdropFilter', 'blur(' + radius + 'px) saturate(' + saturation + '%)')
  }
}

// Render an inline <effect> DOM element (from <appearance> blocks)
function applyEffectElement(target: HTMLElement, effectEl: Element): void {
  if (get(effectEl, 'visible') === 'false') return
  applyEffectData(target, {
    type: get(effectEl, 'type') || '',
    visible: true,
    radius: parseFloat(get(effectEl, 'radius') || '0'),
    x: parseFloat(get(effectEl, 'x') || '0'),
    y: parseFloat(get(effectEl, 'y') || '0'),
    spread: parseFloat(get(effectEl, 'spread') || '0'),
    color: get(effectEl, 'color') || undefined,
    opacity: get(effectEl, 'opacity') !== null ? parseFloat(get(effectEl, 'opacity')!) : undefined,
    blend: get(effectEl, 'blend') || undefined,
    ...(get(effectEl, 'saturation') !== null ? { saturation: parseFloat(get(effectEl, 'saturation')!) } : {}),
  } as ParsedEffect)
}

function applyEffectStyle(target: HTMLElement, styleName: string): void {
  const effects = activeEffectStyles[styleName]
  if (!effects) return
  for (let i = 0; i < effects.length; i++) applyEffectData(target, effects[i])
}

function renderAppearanceStroke(target: HTMLElement, strokeEl: Element, radius?: string | null): void {
  if (get(strokeEl, 'visible') === 'false') return

  const color = get(strokeEl, 'color')
  if (!color) return
  const widthStr = get(strokeEl, 'width') || '1'
  const strokeWidth = parseFloat(widthStr)
  if (!Number.isFinite(strokeWidth) || strokeWidth <= 0) return

  const dashArray = get(strokeEl, 'dash-array')
  const dashOffset = get(strokeEl, 'dash-offset')
  const align = get(strokeEl, 'align') || 'center'
  const style = get(strokeEl, 'style') || 'solid'
  const opacity = get(strokeEl, 'opacity')
  const blend = get(strokeEl, 'blend')

  if (dashArray) {
    // SVG overlay — CSS border cannot represent arbitrary dash patterns
    const ns = 'http://www.w3.org/2000/svg'
    const svgEl = document.createElementNS(ns, 'svg')
    svgEl.setAttribute('width', '100%')
    svgEl.setAttribute('height', '100%')
    svgEl.style.position = 'absolute'
    svgEl.style.left = '0'
    svgEl.style.top = '0'
    svgEl.style.overflow = 'visible'
    svgEl.style.zIndex = '2'
    svgEl.style.pointerEvents = 'none'
    if (opacity) svgEl.style.opacity = opacity
    if (blend) svgEl.style.mixBlendMode = blend as string

    const rectEl = document.createElementNS(ns, 'rect')
    rectEl.setAttribute('x', '0')
    rectEl.setAttribute('y', '0')
    rectEl.setAttribute('width', '100%')
    rectEl.setAttribute('height', '100%')
    rectEl.setAttribute('fill', 'none')
    rectEl.setAttribute('stroke', col(color))
    rectEl.setAttribute('stroke-width', String(strokeWidth))
    rectEl.setAttribute('stroke-dasharray', dashArray)
    if (dashOffset) rectEl.setAttribute('stroke-dashoffset', dashOffset)
    rectEl.setAttribute('vector-effect', 'non-scaling-stroke')
    // Apply border-radius: parse first value from CSS radius string (e.g. "8px" or "4px 8px")
    if (radius) {
      const rMatch = radius.match(/^([0-9.]+)/)
      if (rMatch) {
        const rx = rMatch[1]
        rectEl.setAttribute('rx', rx)
        rectEl.setAttribute('ry', rx)
      }
    }
    // Stroke alignment via SVG paint-order is not directly available;
    // center alignment is default (stroke straddles the path edge)
    if (align === 'inside') {
      rectEl.setAttribute('stroke-width', String(strokeWidth * 2))
      const id = 'gui-sclip-' + (++clipId)
      const defs = document.createElementNS(ns, 'defs')
      const clipPath = document.createElementNS(ns, 'clipPath')
      clipPath.setAttribute('id', id)
      const clipRect = document.createElementNS(ns, 'rect')
      clipRect.setAttribute('x', '0')
      clipRect.setAttribute('y', '0')
      clipRect.setAttribute('width', '100%')
      clipRect.setAttribute('height', '100%')
      if (radius) {
        const rMatch = radius.match(/^([0-9.]+)/)
        if (rMatch) { clipRect.setAttribute('rx', rMatch[1]); clipRect.setAttribute('ry', rMatch[1]) }
      }
      clipPath.appendChild(clipRect)
      defs.appendChild(clipPath)
      svgEl.appendChild(defs)
      rectEl.setAttribute('clip-path', 'url(#' + id + ')')
    }
    svgEl.appendChild(rectEl)
    target.appendChild(svgEl)
  } else if (style === 'solid' && !opacity && !blend) {
    // Use box-shadow — not clipped by overflow:hidden, follows border-radius automatically.
    let shadowVal: string
    if (align === 'inside') {
      shadowVal = `inset 0 0 0 ${strokeWidth}px ${col(color)}`
    } else if (align === 'outside') {
      shadowVal = `0 0 0 ${strokeWidth}px ${col(color)}`
    } else {
      shadowVal = `inset 0 0 0 ${strokeWidth / 2}px ${col(color)}, 0 0 0 ${strokeWidth / 2}px ${col(color)}`
    }
    appendBoxShadow(target, shadowVal)
  } else {
    // Plain CSS div overlay — fallback for non-solid styles or when opacity/blend are set
    const outset = align === 'outside' ? strokeWidth : align === 'center' ? strokeWidth / 2 : 0
    const stroke = document.createElement('div')
    stroke.style.position = 'absolute'
    addClass(stroke, 'gui-pointer-events-none')
    stroke.style.left = (-outset) + 'px'
    stroke.style.top = (-outset) + 'px'
    stroke.style.right = (-outset) + 'px'
    stroke.style.bottom = (-outset) + 'px'
    stroke.style.border = strokeWidth + 'px ' + style + ' ' + col(color)
    stroke.style.boxSizing = 'border-box'
    stroke.style.zIndex = '2'
    if (radius) stroke.style.borderRadius = radius
    if (opacity) stroke.style.opacity = opacity
    if (blend) stroke.style.mixBlendMode = blend as string
    target.appendChild(stroke)
  }
}

function renderAppearance(el: Element, target: HTMLElement, assets: Record<string, string>, radius?: string | null, skipGradientFills?: boolean): void {
  const appearance = appearanceEl(el)
  if (!appearance) return

  for (const child of Array.from(appearance.children)) {
    if (child.tagName === 'effect') {
      applyEffectElement(target, child)
      continue
    }

    if (child.tagName === 'border') {
      renderBorderElement(target, child, radius)
      continue
    }

    if (child.tagName === 'stroke') {
      renderAppearanceStroke(target, child, radius)
      continue
    }

    if (child.tagName !== 'fill') continue

    // Skip paints that are marked hidden (visible="false")
    if (get(child, 'visible') === 'false') continue

    const type = get(child, 'type')
    const value = get(child, 'value')

    // Skip gradient fill layers for text nodes (applied via background-clip:text instead)
    if (skipGradientFills && isGradientFill(type, value)) continue

    const layer = document.createElement('div')
    addClass(layer, 'gui-layer')
    if (radius) layer.style.borderRadius = radius

    const opacity = get(child, 'opacity')
    if (opacity) layer.style.opacity = opacity

    const blend = get(child, 'blend')
    if (blend) layer.style.mixBlendMode = blend

    if (type === 'image') {
      const src = get(child, 'src')
      const resolvedSrc = resolveSrc(src, assets)
      if (!resolvedSrc) continue
      if (get(child, 'fit') === 'tile') {
        layer.style.backgroundImage = `url("${resolvedSrc}")`
        layer.style.backgroundRepeat = 'repeat'
        layer.style.backgroundSize = 'auto'
        target.appendChild(layer)
        continue
      }

      const img = document.createElement('img')
      img.src = resolvedSrc
      addClass(img, 'gui-block')
      const hasCropBox = get(child, 'x') !== null
        && get(child, 'y') !== null
        && get(child, 'w') !== null
        && get(child, 'h') !== null
      if (get(child, 'fit') === 'crop' && hasCropBox) {
        addClass(layer, 'gui-overflow-hidden')
        img.style.position = 'absolute'
        img.style.left = px(get(child, 'x') || '0')
        img.style.top = px(get(child, 'y') || '0')
        img.style.width = px(get(child, 'w') || 'fill')
        img.style.height = px(get(child, 'h') || 'fill')
        addClass(img, 'gui-fit-fill')
      } else {
        addClass(img, 'gui-w-full')
        addClass(img, 'gui-h-full')
        addClass(img, `gui-fit-${get(child, 'fit') || 'cover'}`)
      }
      if (radius) img.style.borderRadius = radius

      // Image fill filters
      const filterParts: string[] = []
      const exposure = get(child, 'filter-exposure')
      const contrast = get(child, 'filter-contrast')
      const saturation = get(child, 'filter-saturation')
      if (exposure !== null) {
        const ev = parseFloat(exposure)
        if (Number.isFinite(ev)) filterParts.push(`brightness(${1 + ev})`)
      }
      if (contrast !== null) {
        const cv = parseFloat(contrast)
        if (Number.isFinite(cv)) filterParts.push(`contrast(${1 + cv})`)
      }
      if (saturation !== null) {
        const sv = parseFloat(saturation)
        if (Number.isFinite(sv)) filterParts.push(`saturate(${1 + sv})`)
      }
      if (filterParts.length > 0) layer.style.filter = filterParts.join(' ')

      layer.appendChild(img)
    } else {
      if (!value) continue
      layer.style.background = col(value)
    }

    target.appendChild(layer)
  }
}

// ---------------------------------------------------------------------------
// RFC 032 — Grid helpers
// ---------------------------------------------------------------------------

/**
 * Convert a dotgui cols/rows string to a CSS grid-template-* value.
 *
 * "3"         → repeat(3, 1fr)
 * "240 1fr"   → 240px 1fr
 * "1fr 2fr"   → 1fr 2fr
 * "auto 1fr"  → auto 1fr
 * "fill 200"  → repeat(auto-fill, minmax(200px, 1fr))
 */
function parseTrackTemplate(val: string): string {
  const trimmed = val.trim()
  if (/^\d+$/.test(trimmed)) return `repeat(${trimmed}, 1fr)`
  if (trimmed.startsWith('fill ')) {
    const minSize = trimmed.slice(5).trim()
    const minPx = /^\d+$/.test(minSize) ? `${minSize}px` : minSize
    return `repeat(auto-fill, minmax(${minPx}, 1fr))`
  }
  // Mixed track list — bare integers become px, fr/auto/% pass through
  return trimmed.split(/\s+/).map(t => /^\d+$/.test(t) ? `${t}px` : t).join(' ')
}

/**
 * Convert an inclusive gc/gr range string to a CSS grid-column/row value.
 * "2/5" → "2 / 6" (end is inclusive, CSS end lines are exclusive so +1)
 * Negative end indices like "-1" are passed through as-is (CSS last-line semantics).
 */
function parseInclusiveRange(val: string): string {
  const slashIdx = val.indexOf('/')
  if (slashIdx === -1) return val
  const start = val.slice(0, slashIdx).trim()
  const end = val.slice(slashIdx + 1).trim()
  const endNum = parseInt(end, 10)
  if (isNaN(endNum) || endNum < 0) return `${start} / ${end}`
  return `${start} / ${endNum + 1}`
}

/**
 * Apply gc / gr / col-span / row-span placement to a rendered grid child.
 * Range end on gc/gr is inclusive ("2/5" = columns 2 through 5).
 * When gc carries a range and w is absent the child fills the column span.
 * When gr carries a range and h is absent the child fills the row span.
 * w and h are always pixels — no unit-count reinterpretation.
 */
function applyGridPlacement(childEl: HTMLElement, child: Element): void {
  const gcVal = child.getAttribute('gc')
  const grVal = child.getAttribute('gr')
  const colSpanVal = child.getAttribute('col-span')
  const rowSpanVal = child.getAttribute('row-span')
  const wVal = child.getAttribute('w')
  const hVal = child.getAttribute('h')

  if (gcVal !== null) {
    if (gcVal.includes('/')) {
      childEl.style.gridColumn = parseInclusiveRange(gcVal)
      // Fill width when range defined and no explicit w
      if (wVal === null) {
        childEl.style.width = '100%'
        childEl.setAttribute('data-w-mode', 'fill')
      }
    } else if (colSpanVal !== null) {
      const span = colSpanVal === 'all' ? '-1' : colSpanVal
      childEl.style.gridColumn = `${gcVal} / span ${span}`
    } else {
      childEl.style.gridColumn = gcVal
    }
  } else if (colSpanVal !== null) {
    childEl.style.gridColumn = colSpanVal === 'all' ? '1 / -1' : `span ${colSpanVal}`
  }

  if (grVal !== null) {
    if (grVal.includes('/')) {
      childEl.style.gridRow = parseInclusiveRange(grVal)
      // Fill height when range defined and no explicit h
      if (hVal === null) {
        childEl.style.height = '100%'
        childEl.setAttribute('data-h-mode', 'fill')
      }
    } else if (rowSpanVal !== null) {
      childEl.style.gridRow = `${grVal} / span ${rowSpanVal}`
    } else {
      childEl.style.gridRow = grVal
    }
  } else if (rowSpanVal !== null) {
    childEl.style.gridRow = `span ${rowSpanVal}`
  }
}

// --- node renderers ---

function renderFrame(el: Element, assets: Record<string, string>, ctx: Ctx, isStack: boolean): HTMLElement {
  // Determine semantic element tag
  const srcTag = el.tagName
  let htmlTag: string
  if (isStack) {
    if (srcTag === 'row') htmlTag = 'gui-row'
    else if (srcTag === 'col') htmlTag = 'gui-col'
    else if (srcTag === 'grid') htmlTag = 'gui-grid'
    else htmlTag = 'gui-stack'
  } else {
    htmlTag = 'gui-frame'
  }

  const div = document.createElement(htmlTag) as HTMLElement
  position(div, el, ctx)

  const explicitAppearance = hasAppearance(el)
  const appearanceOwnsFill = hasAppearanceFill(el)

  const fillStyleName = getRaw(el, 'fill-style')
  const resolvedFill = fillStyleName ? (activeFillStyles[fillStyleName] || null) : get(el, 'fill')
  if (resolvedFill && !appearanceOwnsFill) div.style.background = col(resolvedFill)

  const r = get(el, 'radius')
  const radius = r ? radii(r) : null
  if (radius) div.style.borderRadius = radius
  applyCornerSmoothing(div, el)

  // clip — copy attribute so CSS [clip="true"] selector fires
  const clipVal = getRaw(el, 'clip')
  if (clipVal !== null && clipVal !== 'false') div.setAttribute('clip', 'true')

  const sh = shadow(get(el, 'shadow'))
  if (sh) appendBoxShadow(div, sh)

  // clip-path
  const clipPath = get(el, 'clip-path')
  if (clipPath) div.style.clipPath = clipPath

  // overflow-x / overflow-y
  const overflowX = get(el, 'overflow-x')
  if (overflowX) div.style.overflowX = overflowX as CSSStyleDeclaration['overflowX']
  const overflowY = get(el, 'overflow-y')
  if (overflowY) div.style.overflowY = overflowY as CSSStyleDeclaration['overflowY']

  // border-image
  const borderImage = get(el, 'border-image')
  if (borderImage) div.style.borderImage = borderImage

  // outline
  const outlineVal = get(el, 'outline')
  if (outlineVal) {
    if (outlineVal.includes('px')) {
      div.style.outline = outlineVal
    } else {
      const parsed = parseBorder(outlineVal)
      if (parsed) div.style.outline = `${parsed.width}px ${parsed.style} ${col(parsed.color)}`
    }
  }
  const outlineOffset = get(el, 'outline-offset')
  if (outlineOffset) div.style.outlineOffset = `${outlineOffset}px`

  renderAppearance(el, div, assets, radius)

  const effectStyleName = getRaw(el, 'effect-style')
  if (effectStyleName) applyEffectStyle(div, effectStyleName)

  let stackDirection: 'horizontal' | 'vertical' | 'grid' | undefined
  let negativeGap: number | null = null
  let reverseZ = false
  if (isStack) {
    const dir = srcTag === 'row' ? 'horizontal' : srcTag === 'col' ? 'vertical' : srcTag === 'grid' ? 'grid' : (get(el, 'direction') || 'vertical')

    // Padding: p (new) or padding (old), plus per-side overrides
    const pVal = get(el, 'p') || get(el, 'padding')
    if (pVal) div.style.padding = pad(pVal)
    const ptVal = get(el, 'pt'); if (ptVal) div.style.paddingTop = `${ptVal}px`
    const prVal = get(el, 'pr'); if (prVal) div.style.paddingRight = `${prVal}px`
    const pbVal = get(el, 'pb'); if (pbVal) div.style.paddingBottom = `${pbVal}px`
    const plVal = get(el, 'pl'); if (plVal) div.style.paddingLeft = `${plVal}px`

    // Copy discrete attributes so CSS attribute selectors can fire
    if (htmlTag === 'gui-stack' && dir !== 'grid') div.setAttribute('direction', dir)
    const alignVal = getRaw(el, 'align')
    if (alignVal) div.setAttribute('align', alignVal)
    const gapRaw = getRaw(el, 'gap')
    if (gapRaw !== null) div.setAttribute('gap', gapRaw)
    const wrapVal = getRaw(el, 'wrap')
    if (wrapVal !== null && wrapVal !== 'false') div.setAttribute('wrap', 'true')

    if (dir === 'grid') {
      stackDirection = 'grid'
      const isGridTag = srcTag === 'grid'
      const gapRaw = isGridTag ? getRaw(el, 'gap') : null

      if (isGridTag) {
        const unitAttr = getRaw(el, 'unit')
        // cols: new attr name, falls back to legacy 'columns' alias
        const colsAttr = getRaw(el, 'cols') || getRaw(el, 'columns')
        const rowsAttr = getRaw(el, 'rows')

        if (unitAttr !== null) {
          // ── Unit grid mode (RFC 032) ─────────────────────────────────────
          const unitSize = parseFloat(unitAttr)
          const wPx = parseFloat(get(el, 'w') || '0')
          const hPx = parseFloat(get(el, 'h') || '0')
          if (unitSize > 0) {
            if (wPx > 0) div.style.gridTemplateColumns = `repeat(${Math.round(wPx / unitSize)}, ${unitSize}px)`
            if (hPx > 0) div.style.gridTemplateRows    = `repeat(${Math.round(hPx / unitSize)}, ${unitSize}px)`
          }
        } else if (colsAttr !== null || rowsAttr !== null) {
          // ── Track grid mode (RFC 032) ────────────────────────────────────
          if (colsAttr) div.style.gridTemplateColumns = parseTrackTemplate(colsAttr)
          if (rowsAttr) div.style.gridTemplateRows    = parseTrackTemplate(rowsAttr)
          if (gapRaw !== null) {
            const parts = (gapRaw || '0').trim().split(/\s+/)
            const colG = parts[0]; const rowG = parts[1] || parts[0]
            if (colG && colG !== 'auto') div.style.columnGap = `${colG}px`
            if (rowG && rowG !== 'auto') div.style.rowGap    = `${rowG}px`
          }
        } else {
          // ── Legacy auto-flow (columns="N") ──────────────────────────────
          const legacyCols = get(el, 'columns') || get(el, 'cols')
          if (legacyCols) div.style.gridTemplateColumns = `repeat(${legacyCols}, 1fr)`
          if (gapRaw) {
            const parts = gapRaw.trim().split(/\s+/)
            const fg = parts[0]; const sg = parts[1] || parts[0]
            if (fg === 'auto') div.style.columnGap = '0px'; else if (fg) div.style.columnGap = `${fg}px`
            if (sg === 'auto') div.style.rowGap = '0px';    else if (sg) div.style.rowGap    = `${sg}px`
          }
        }
      } else {
        // <stack direction="grid"> — legacy path, no RFC 032 placement
        const cols   = get(el, 'grid-columns')
        const rows   = get(el, 'grid-rows')
        const colGap = get(el, 'grid-col-gap')
        const rowGap = get(el, 'grid-row-gap')
        if (cols) div.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
        if (rows) div.style.gridTemplateRows    = `repeat(${rows}, 1fr)`
        if (colGap) div.style.columnGap = `${colGap}px`
        if (rowGap) div.style.rowGap    = `${rowGap}px`
      }
    } else {
      stackDirection = dir === 'horizontal' ? 'horizontal' : 'vertical'
      // reverse-z: boolean presence convention
      const rzVal = getRaw(el, 'reverse-z')
      reverseZ = rzVal !== null && rzVal !== 'false'
      // Numeric gap handled in JS; align handled by CSS attribute selectors
      negativeGap = applyGapLayout(div, stackDirection, gapRaw)
    }
  }

  // Apply mask-src (container mask from plugin extraction)
  applyContainerMask(div, el, assets)
  // Apply sibling mask child (mask="true" on a child node)
  const frameMaskChildEl = applyChildMask(div, el)

  const children = Array.from(el.children)

  function isAbsoluteChild(child: Element): boolean {
    const absVal = getRaw(child, 'abs')
    if (absVal !== null && absVal !== 'false') return true
    return getRaw(child, 'layout-position') === 'absolute'
  }

  const flowChildTotal = children.filter(child =>
    child.tagName !== 'appearance' && !(isStack && isAbsoluteChild(child))
  ).length
  // Mixed stack: a stack that holds both absolute and in-flow children. CSS paints
  // positioned (absolute) elements above static (in-flow) ones regardless of
  // document order, so an absolute child listed *before* a flow sibling (i.e. meant
  // to sit behind it, e.g. a full-bleed background rect) would wrongly cover it.
  // We fix this by giving every child a document-order z-index — but only when no
  // other branch below already owns stacking for this frame.
  const mixedStack = isStack &&
    flowChildTotal > 0 &&
    flowChildTotal < children.filter(c => c.tagName !== 'appearance').length
  const orderedStack = mixedStack && negativeGap === null && !reverseZ && !explicitAppearance
  let flowChildCount = 0
  let renderIndex = 0
  let prevFlowChild: Element | null = null
  for (const child of children) {
    if (child.tagName === 'appearance') continue
    const isAbsolute = !isStack || isAbsoluteChild(child)
    const childCtx: Ctx = {
      absolute: isAbsolute,
      parentDirection: isAbsolute ? undefined : stackDirection,
    }
    const childEl = renderNode(child, assets, childCtx)
    if (childEl) {
      // Hide mask child — it's been consumed into a CSS mask-image on the parent
      if (child === frameMaskChildEl) childEl.style.display = 'none'
      // Apply gc / gr / col-span / row-span grid placement (RFC 032)
      if (stackDirection === 'grid' && !isAbsolute) {
        applyGridPlacement(childEl, child)
      }
      if (!isAbsolute && negativeGap !== null) {
        // Later items sit on top in Figma — ensure stacking context with ascending z-index
        if (!childEl.classList.contains('gui-absolute')) addClass(childEl, 'gui-relative')
        childEl.style.zIndex = String(flowChildCount)
        if (flowChildCount > 0) {
          // Clamp: B can't go past the left/top edge of the previous sibling (Figma behaviour)
          const prevSize = prevFlowChild ? parseFloat(
            stackDirection === 'horizontal' ? (get(prevFlowChild, 'w') || '') : (get(prevFlowChild, 'h') || '')
          ) : NaN
          const clampedGap = !isNaN(prevSize) ? Math.max(negativeGap, -prevSize) : negativeGap
          if (stackDirection === 'horizontal') childEl.style.marginLeft = `${clampedGap}px`
          else if (stackDirection === 'vertical') childEl.style.marginTop = `${clampedGap}px`
        }
      }
      if (!isAbsolute && reverseZ) {
        if (!childEl.classList.contains('gui-absolute')) addClass(childEl, 'gui-relative')
        childEl.style.zIndex = String(flowChildTotal - flowChildCount - 1)
      }
      if (explicitAppearance) {
        // Absolute children are positioned via data-pos="absolute"; adding
        // gui-relative would clobber that position:absolute (collapsing the
        // shape to 0×0, since gui-shape defaults to display:inline) and let the
        // frame's own appearance fill paint over them. Only in-flow children
        // need gui-relative — same guard the orderedStack branch uses below.
        if (!isAbsolute && !childEl.classList.contains('gui-absolute')) addClass(childEl, 'gui-relative')
        if (!reverseZ || isAbsolute) childEl.style.zIndex = '1'
      }
      if (orderedStack) {
        // Promote in-flow children to positioned so they share the absolute
        // siblings' paint phase, then stack everything by document order.
        // Absolute children are positioned via data-pos="absolute"; only the
        // in-flow ones need gui-relative (and it must NOT override that absolute).
        if (!isAbsolute) addClass(childEl, 'gui-relative')
        childEl.style.zIndex = String(renderIndex)
      }
      div.appendChild(childEl)
      renderIndex++
      if (!isAbsolute) { flowChildCount++; prevFlowChild = child }
    }
  }

  const strokeWrapper = strokeStyle(div, el, radius)
  strokePerSideStyle(div, el, radius)

  return strokeWrapper || div
}

// Apply a CSS mask-image to a container div from a mask-src asset or a child mask node.
function applyContainerMask(div: HTMLElement, el: Element, assets: Record<string, string>): void {
  const maskSrc = get(el, 'mask-src')
  if (maskSrc && assets[maskSrc]) {
    const mx = get(el, 'mask-x') || '0'
    const my = get(el, 'mask-y') || '0'
    const mw = get(el, 'mask-width') || String(get(el, 'w') || '100%')
    const mh = get(el, 'mask-height') || String(get(el, 'h') || '100%')
    const url = assets[maskSrc]
    const mask = `url("${url}")`
    div.style.webkitMaskImage = mask
    div.style.maskImage = mask
    div.style.webkitMaskSize = `${mw}px ${mh}px`
    div.style.maskSize = `${mw}px ${mh}px`
    div.style.webkitMaskPosition = `${mx}px ${my}px`
    div.style.maskPosition = `${mx}px ${my}px`
    div.style.webkitMaskRepeat = 'no-repeat'
    div.style.maskRepeat = 'no-repeat'
    const maskMode = get(el, 'mask-mode')
    if (maskMode) {
      div.style.maskMode = maskMode
      ;(div.style as any).webkitMaskMode = maskMode
    }
    const maskComposite = get(el, 'mask-composite')
    if (maskComposite) div.style.maskComposite = maskComposite
  }
}

// Scan XML children for a node with mask="true", generate an inline SVG mask from its
// shape, apply it to the parent container, and return the mask child element so it can
// be hidden after rendering.
function applyChildMask(div: HTMLElement, el: Element): Element | null {
  const children = Array.from(el.children)
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (getRaw(child, 'mask') !== 'true' && getRaw(child, 'mask') !== '') continue

    const x = parseFloat(get(child, 'x') || '0')
    const y = parseFloat(get(child, 'y') || '0')
    const w = parseFloat(get(child, 'w') || '0')
    const h = parseFloat(get(child, 'h') || '0')
    if (!w || !h) continue

    // Build SVG mask shape based on node type
    let shape = ''
    if (child.tagName === 'ellipse') {
      const rx = w / 2
      const ry = h / 2
      shape = `<ellipse cx="${rx}" cy="${ry}" rx="${rx}" ry="${ry}" fill="white"/>`
    } else {
      // rect or any other node — use its bounding box with optional radius
      const rRaw = get(child, 'radius')
      const r = rRaw ? parseFloat(rRaw.split(' ')[0]) : 0
      shape = `<rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="white"/>`
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shape}</svg>`
    const encoded = 'data:image/svg+xml;base64,' + btoa(svg)
    const mask = `url("${encoded}")`
    div.style.webkitMaskImage = mask
    div.style.maskImage = mask
    div.style.webkitMaskSize = `${w}px ${h}px`
    div.style.maskSize = `${w}px ${h}px`
    div.style.webkitMaskPosition = `${x}px ${y}px`
    div.style.maskPosition = `${x}px ${y}px`
    div.style.webkitMaskRepeat = 'no-repeat'
    div.style.maskRepeat = 'no-repeat'
    return child
  }
  return null
}

function renderGroup(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement {
  const div = document.createElement('gui-group') as HTMLElement
  position(div, el, ctx)

  applyContainerMask(div, el, assets)

  // Find sibling-mask child (mask="true") and generate inline CSS mask
  const maskChildEl = applyChildMask(div, el)

  const childCtx: Ctx = { absolute: true }
  for (const child of Array.from(el.children)) {
    const childEl = renderNode(child, assets, childCtx)
    if (childEl) {
      if (child === maskChildEl) childEl.style.display = 'none'
      div.appendChild(childEl)
    }
  }
  return div
}

function applyTextStyle(el: HTMLElement, guiEl: Element): void {
  const styleName = getRaw(guiEl, 'text-style')
  const namedStyle = styleName ? activeStyles[styleName] : null

  function styledAttr(name: string): string | null {
    const direct = get(guiEl, name)
    if (direct !== null) return direct
    if (namedStyle && namedStyle[name] !== undefined) return resolveToken(namedStyle[name])
    return null
  }

  const ff = styledAttr('font-family')
  const fs = styledAttr('font-size')
  const fw = styledAttr('font-weight')
  const fst = styledAttr('font-style')
  const fv = styledAttr('font-variation')
  const ff2 = styledAttr('font-feature')
  const lh = styledAttr('line-height')
  const ls = styledAttr('letter-spacing')
  const bs = get(guiEl, 'baseline-shift')
  const fillStyleName = getRaw(guiEl, 'fill-style')
  const c = fillStyleName ? (activeFillStyles[fillStyleName] || null) : (get(guiEl, 'fill') || get(guiEl, 'color'))
  const deco = styledAttr('decoration')
  const decoColor = styledAttr('decoration-color')
  const decoStyle = styledAttr('decoration-style')
  const decoThick = styledAttr('decoration-thickness')
  const transform = styledAttr('text-case')

  if (ff) el.style.fontFamily = fontStack(ff)
  if (fs) el.style.fontSize = `${fs}px`
  if (fw) el.style.fontWeight = fw
  if (fst) el.style.fontStyle = fst
  if (fv) (el.style as any).fontVariationSettings = fv
  if (ff2) (el.style as any).fontFeatureSettings = ff2
  if (lh) el.style.lineHeight = lineHeight(lh)
  if (ls) el.style.letterSpacing = ls.includes('%') ? ls : `${ls}px`
  if (bs) el.style.verticalAlign = `${bs}px`
  if (c) el.style.color = col(c)

  if (deco === 'underline' || deco === 'strikethrough') {
    el.style.textDecoration = deco === 'underline' ? 'underline' : 'line-through'
    if (decoColor) el.style.textDecorationColor = col(decoColor)
    if (decoStyle) el.style.textDecorationStyle = decoStyle as any
    if (decoThick) el.style.textDecorationThickness = `${decoThick}px`
  }

  if (transform === 'small-caps' || transform === 'small-caps-forced') {
    el.style.fontVariant = 'small-caps'
  } else if (transform) {
    el.style.textTransform = transform as 'uppercase' | 'lowercase' | 'capitalize'
  }
}

function wrapHref(child: HTMLElement, href: string | null): HTMLElement {
  if (!href) return child
  const a = document.createElement('a')
  a.href = href
  a.style.color = 'inherit'
  a.style.textDecoration = 'inherit'
  a.appendChild(child)
  return a
}

/**
 * Render-only wrap tolerance for fixed-width text, as a fraction of the box width.
 *
 * The exported `w` is Figma's exact measured width and is never modified. But
 * browsers shape text ~0.5–0.7% *wider* than Figma's text engine (measured: a
 * line Figma fit in 555.81px renders at 559.25px in Chrome — no font-smoothing,
 * kerning, or text-rendering setting changes this). On a box sized to Figma's
 * tight wrap that surplus tips the last word onto a new line. We widen the
 * rendered box by this fraction so the browser reproduces Figma's wrapping.
 *
 * Proportional (not a fixed px) because the drift scales with line length. Kept
 * comfortably below a word's width, so it can never pull a new word onto a line —
 * it only absorbs sub-percent shaping drift.
 */
const TEXT_WRAP_TOLERANCE = 0.01

/**
 * Resolve a text attribute, preferring a direct attr and falling back to the
 * node's named text-style (mirrors applyTextStyle's styledAttr lookup). Used to
 * inspect line-height / font-size outside applyTextStyle.
 */
function resolveTextAttr(guiEl: Element, name: string): string | null {
  const direct = get(guiEl, name)
  if (direct !== null) return direct
  const styleName = getRaw(guiEl, 'text-style')
  const namedStyle = styleName ? activeStyles[styleName] : null
  if (namedStyle && namedStyle[name] !== undefined) return resolveToken(namedStyle[name])
  return null
}

/** Effective line-height in px from a dotgui line-height value + font-size. */
function lineHeightPx(lh: string, fontSizePx: number): number {
  const v = lh.trim()
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    // Bare number: ≤ 4 → unitless multiplier, > 4 → px (matches lineHeight())
    const n = parseFloat(v)
    return n > 0 && n <= 4 ? n * fontSizePx : n
  }
  if (v.endsWith('%')) return (parseFloat(v) / 100) * fontSizePx
  if (v.endsWith('px')) return parseFloat(v)
  return NaN
}

function renderText(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement {
  const div = document.createElement('gui-text') as HTMLElement
  position(div, el, ctx)

  const align = get(el, 'align')
  const va = get(el, 'vertical-align')
  const truncateVal = getRaw(el, 'truncate')
  const truncate = truncateVal !== null && truncateVal !== 'false'
  const maxLines = get(el, 'max-lines')
  const overflow = get(el, 'overflow')
  const leadingTrim = get(el, 'leading-trim')
  const listType = get(el, 'list')
  const listLevel = get(el, 'list-level')
  const listMarker = get(el, 'list-marker')
  const hasFixedHeight = get(el, 'h') !== null

  // Fixed-width text: widen by the wrap tolerance so browser shaping matches
  // Figma's wrap. Skipped for single-line ellipsis (nowrap — wrapping N/A).
  const wRaw = get(el, 'w')
  const wNum = wRaw === null ? NaN : parseFloat(wRaw)
  const isFixedWidth = !Number.isNaN(wNum) && wRaw !== 'hug' && wRaw !== 'fill'
  const isSingleLineEllipsis = overflow === 'ellipsis' && !truncate && !maxLines
  if (isFixedWidth && !isSingleLineEllipsis) {
    div.style.setProperty('--gui-w', `${wNum * (1 + TEXT_WRAP_TOLERANCE)}px`)
  }

  // Single-line heading guard: a fixed-height box whose height fits one line is
  // a heading Figma kept on one line. Browser shaping runs a few % wider than
  // Figma's engine (more so at heavy display weights), which can wrap it to a
  // 2nd line that then clips/overlaps inside the 1-line box. Force nowrap so the
  // small surplus spills into the parent gutter instead of colliding.
  let singleLineHeading = false
  if (hasFixedHeight && !truncate && !maxLines) {
    const hNum = parseFloat(get(el, 'h') || '')
    const fsRaw = resolveTextAttr(el, 'font-size')
    const lhRaw = resolveTextAttr(el, 'line-height')
    if (Number.isFinite(hNum) && fsRaw && lhRaw) {
      const lhPx = lineHeightPx(lhRaw, parseFloat(fsRaw))
      if (Number.isFinite(lhPx) && lhPx > 0) singleLineHeading = Math.round(hNum / lhPx) <= 1
    }
  }

  if (align) div.style.textAlign = align as CanvasTextAlign

  // overflow="ellipsis" forces single-line ellipsis when no max-lines/truncate set
  if (overflow === 'ellipsis' && !truncate && !maxLines) {
    div.style.overflow = 'hidden'
    div.style.textOverflow = 'ellipsis'
    div.style.whiteSpace = 'nowrap'
  } else if (overflow === 'clip') {
    div.style.overflow = 'hidden'
  }

  // List marker rendering: wrap content in a list item context
  if (listType && listType !== 'none') {
    const indent = listLevel ? parseInt(listLevel, 10) * 16 : 0
    div.style.display = 'list-item'
    div.style.listStyleType = listType === 'decimal' ? 'decimal' : 'disc'
    div.style.listStylePosition = 'inside'
    if (indent) div.style.paddingLeft = `${indent}px`
    if (listMarker) {
      // Custom marker via CSS content (uses a pseudo-element via inline style trick)
      div.setAttribute('data-list-marker', listMarker)
      div.style.listStyleType = 'none'
    }
  }

  if (leadingTrim && leadingTrim !== 'none') {
    ;(div.style as any).textBoxTrim = 'both'
    ;(div.style as any).textBoxEdge = 'cap alphabetic'
  }

  // New text properties
  const fontStretch = get(el, 'font-stretch')
  if (fontStretch) div.style.fontStretch = fontStretch

  const direction = get(el, 'direction')
  if (direction) div.style.direction = direction as CSSStyleDeclaration['direction']

  const writingMode = get(el, 'writing-mode')
  if (writingMode) div.style.writingMode = writingMode

  const whiteSpace = get(el, 'white-space')
  if (whiteSpace) div.style.whiteSpace = whiteSpace

  const wordBreak = get(el, 'word-break')
  if (wordBreak) div.style.wordBreak = wordBreak as CSSStyleDeclaration['wordBreak']

  const wordSpacing = get(el, 'word-spacing')
  if (wordSpacing) div.style.wordSpacing = `${wordSpacing}px`

  const textUnderlineOffset = get(el, 'text-underline-offset')
  if (textUnderlineOffset) div.style.textUnderlineOffset = `${textUnderlineOffset}px`

  const textDecorationSkipInk = get(el, 'text-decoration-skip-ink')
  if (textDecorationSkipInk !== null) {
    div.style.textDecorationSkipInk = textDecorationSkipInk === 'false' ? 'none' : 'auto'
  }

  const textWrap = get(el, 'text-wrap')
  if (textWrap) (div.style as any).textWrap = textWrap

  const fontOpticalSizing = get(el, 'font-optical-sizing')
  if (fontOpticalSizing) (div.style as any).fontOpticalSizing = fontOpticalSizing

  const fontSmoothing = get(el, 'font-smoothing')
  if (fontSmoothing) {
    if (fontSmoothing === 'antialiased') {
      ;(div.style as any).webkitFontSmoothing = 'antialiased'
      ;(div.style as any).mozOsxFontSmoothing = 'grayscale'
    } else if (fontSmoothing === 'subpixel-antialiased') {
      ;(div.style as any).webkitFontSmoothing = 'subpixel-antialiased'
    } else if (fontSmoothing === 'none') {
      ;(div.style as any).webkitFontSmoothing = 'none'
    }
  }

  const textRendering = get(el, 'text-rendering')
  if (textRendering) div.style.textRendering = textRendering as CSSStyleDeclaration['textRendering']

  const paragraphSpacing = get(el, 'paragraph-spacing')
  if (paragraphSpacing) div.style.marginBottom = `${paragraphSpacing}px`

  // Check for gradient fill in appearance — apply as background-clip:text
  const gradientFill = getAppearanceGradientFill(el)
  const hasGradientTextFill = !!gradientFill

  renderAppearance(el, div, assets, undefined, hasGradientTextFill)

  if (hasGradientTextFill) {
    div.style.backgroundImage = col(gradientFill)
    ;(div.style as any).webkitBackgroundClip = 'text'
    div.style.backgroundClip = 'text'
    ;(div.style as any).webkitTextFillColor = 'transparent'
    div.style.color = 'transparent'
  }

  // Check for <segment> children (mixed-style text)
  const segmentEls = Array.from(el.children).filter(c => c.tagName === 'segment')
  if (segmentEls.length > 0) {
    // Apply the parent <text> style to the container so segments inherit it;
    // each segment's own properties override via its inline span styles.
    applyTextStyle(div, el)
    if (va && va !== 'top') {
      div.style.display = 'flex'
      div.style.alignItems = va === 'center' ? 'center' : 'flex-end'
    }
    const wrap = document.createElement('span')
    // Don't add gui-pre-wrap (white-space: pre-wrap) when the parent div already
    // has white-space: nowrap set for overflow="ellipsis" — it would override it
    // and prevent text-overflow from firing.
    if (!(overflow === 'ellipsis' && !truncate && !maxLines)) {
      addClass(wrap, 'gui-pre-wrap')
    }
    for (const seg of segmentEls) {
      const span = document.createElement('span')
      span.textContent = get(seg, 'value') || ''
      applyTextStyle(span, seg)
      wrap.appendChild(wrapHref(span, get(seg, 'href')))
    }
    div.appendChild(wrap)
    return div
  }

  // Single-style text
  applyTextStyle(div, el)
  const text = get(el, 'value') || ''
  const href = get(el, 'href')

  const clamp = maxLines || (truncate ? '1' : null)
  if (singleLineHeading && !clamp) {
    // Keep the heading on one line; don't clip — let the shaping surplus spill
    // into the parent gutter rather than wrap to a colliding 2nd line.
    div.style.whiteSpace = 'nowrap'
  } else if (hasFixedHeight || clamp) {
    addClass(div, 'gui-overflow-hidden')
  }

  if (va && va !== 'top') {
    div.style.display = 'flex'
    div.style.alignItems = va === 'center' ? 'center' : 'flex-end'
    if (clamp) {
      const inner = document.createElement('span')
      inner.textContent = text
      inner.style.display = '-webkit-box'
      inner.style.webkitLineClamp = clamp
      ;(inner.style as any).WebkitBoxOrient = 'vertical'
      addClass(inner, 'gui-overflow-hidden')
      inner.style.width = '100%'
      div.appendChild(wrapHref(inner, href))
    } else {
      const span = document.createElement('span')
      span.textContent = text
      div.appendChild(wrapHref(span, href))
    }
  } else if (clamp) {
    div.textContent = text
    div.style.display = '-webkit-box'
    div.style.webkitLineClamp = clamp
    ;(div.style as any).WebkitBoxOrient = 'vertical'
    addClass(div, 'gui-overflow-hidden')
    if (href) {
      addClass(div, 'gui-block')
      div.textContent = ''
      const inner = document.createElement('span')
      inner.textContent = text
      inner.style.display = '-webkit-box'
      inner.style.webkitLineClamp = clamp
      ;(inner.style as any).WebkitBoxOrient = 'vertical'
      addClass(inner, 'gui-overflow-hidden')
      div.appendChild(wrapHref(inner, href))
    }
  } else if (href) {
    const span = document.createElement('span')
    span.textContent = text
    div.appendChild(wrapHref(span, href))
  } else {
    div.textContent = text
  }

  return div
}

function renderImg(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement {
  const wrap = document.createElement('gui-img') as HTMLElement
  position(wrap, el, ctx)

  // Copy fit attribute so CSS gui-img[fit="cover"] > img selector fires
  const fit = get(el, 'fit')
  if (fit) wrap.setAttribute('fit', fit)

  const img = document.createElement('img')
  addClass(img, 'gui-block')

  const src = get(el, 'src')
  const resolvedSrc = resolveSrc(src, assets)
  if (resolvedSrc) img.src = resolvedSrc

  const r = get(el, 'radius')
  const radius = r ? radii(r) : null
  if (radius) {
    wrap.style.borderRadius = radius
    img.style.borderRadius = radius
  }

  const objectPosition = get(el, 'object-position')
  if (objectPosition) img.style.objectPosition = objectPosition

  const imageRendering = get(el, 'image-rendering')
  if (imageRendering) img.style.imageRendering = imageRendering as CSSStyleDeclaration['imageRendering']

  wrap.appendChild(img)
  const imgStrokeWrapper = strokeStyle(wrap, el, radius)
  strokePerSideStyle(wrap, el, radius)

  return imgStrokeWrapper || wrap
}

function renderSvgAsset(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement {
  // Inline SVG (<svg> with no src) was superseded by RFC 0020 → RFC 0023.
  // All SVG is now <img src="assets/..."> — inline SVG blocks are no longer supported.
  const src = get(el, 'src')
  const svgImg = document.createElement('gui-svg') as HTMLElement
  position(svgImg, el, ctx)
  const inner = document.createElement('img')
  addClass(inner, 'gui-block')
  addClass(inner, 'gui-fit-fill')
  inner.style.width = '100%'
  inner.style.height = '100%'
  const resolved = resolveSrc(src, assets)
  if (resolved) inner.src = resolved
  svgImg.appendChild(inner)
  return svgImg
}

function renderEllipseArc(
  el: Element,
  ctx: Ctx,
  fill: string | null,
  stroke: string | null,
  strokeWidth: string | null,
): HTMLElement {
  const w = parseFloat(get(el, 'w') || '24')
  const h = parseFloat(get(el, 'h') || '24')
  const startDeg = parseFloat(get(el, 'arc-start') || '0')
  const endDeg = parseFloat(get(el, 'arc-end') || '360')
  const innerRatio = parseFloat(get(el, 'arc-inner') || '0')
  const sw = parseFloat(strokeWidth || '0')

  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  position(svg, el, ctx)
  addClass(svg, 'gui-block')
  addClass(svg, 'gui-overflow-visible')

  const cx = w / 2
  const cy = h / 2
  const rx = w / 2
  const ry = h / 2
  const startRad = startDeg * Math.PI / 180
  const endRad = endDeg * Math.PI / 180
  const spanDeg = ((endDeg - startDeg) + 360) % 360 || 360
  const large = spanDeg > 180 ? 1 : 0

  const ox = (x: number, r: number) => cx + r * Math.cos(x)
  const oy = (y: number, r: number) => cy + r * Math.sin(y)

  let d: string
  if (innerRatio > 0) {
    const irx = rx * innerRatio
    const iry = ry * innerRatio
    d = [
      `M ${ox(startRad, rx)} ${oy(startRad, ry)}`,
      `A ${rx} ${ry} 0 ${large} 1 ${ox(endRad, rx)} ${oy(endRad, ry)}`,
      `L ${ox(endRad, irx)} ${oy(endRad, iry)}`,
      `A ${irx} ${iry} 0 ${large} 0 ${ox(startRad, irx)} ${oy(startRad, iry)}`,
      'Z',
    ].join(' ')
  } else {
    d = [
      `M ${cx} ${cy}`,
      `L ${ox(startRad, rx)} ${oy(startRad, ry)}`,
      `A ${rx} ${ry} 0 ${large} 1 ${ox(endRad, rx)} ${oy(endRad, ry)}`,
      'Z',
    ].join(' ')
  }

  const path = document.createElementNS(ns, 'path') as SVGPathElement
  path.setAttribute('d', d)
  path.setAttribute('fill', fill ? colSolid(fill) : 'none')
  if (stroke && sw > 0) {
    path.setAttribute('stroke', colSolid(stroke))
    path.setAttribute('stroke-width', String(sw))
  }
  svg.appendChild(path)
  return svg as unknown as HTMLElement
}

function renderRect(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement {
  const div = document.createElement('gui-shape') as HTMLElement
  div.setAttribute('type', 'rect')
  position(div, el, ctx)
  const appearanceOwnsFill = hasAppearanceFill(el)
  const fillStyleName = getRaw(el, 'fill-style')
  const resolvedFill = fillStyleName ? (activeFillStyles[fillStyleName] || null) : get(el, 'fill')
  if (resolvedFill && !appearanceOwnsFill) div.style.background = col(resolvedFill)
  const r = get(el, 'radius')
  if (r) div.style.borderRadius = radii(r)
  const sh = shadow(get(el, 'shadow'))
  if (sh) appendBoxShadow(div, sh)
  renderAppearance(el, div, assets, div.style.borderRadius || null)
  const effectStyleName = getRaw(el, 'effect-style')
  if (effectStyleName) applyEffectStyle(div, effectStyleName)
  const shapeStrokeWrapper = strokeStyle(div, el, div.style.borderRadius || null)
  strokePerSideStyle(div, el, div.style.borderRadius || null)
  return shapeStrokeWrapper || div
}

function renderEllipse(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement {
  const div = document.createElement('gui-shape') as HTMLElement
  div.setAttribute('type', 'ellipse')
  position(div, el, ctx)
  const appearanceOwnsFill = hasAppearanceFill(el)
  const fillStyleName = getRaw(el, 'fill-style')
  const resolvedFill = fillStyleName ? (activeFillStyles[fillStyleName] || null) : get(el, 'fill')
  if (resolvedFill && !appearanceOwnsFill) div.style.background = col(resolvedFill)
  div.style.borderRadius = '50%'
  const sh = shadow(get(el, 'shadow'))
  if (sh) appendBoxShadow(div, sh)
  renderAppearance(el, div, assets, '50%')
  const effectStyleName = getRaw(el, 'effect-style')
  if (effectStyleName) applyEffectStyle(div, effectStyleName)
  const ellipseStrokeWrapper = strokeStyle(div, el, '50%')
  strokePerSideStyle(div, el, '50%')
  return ellipseStrokeWrapper || div
}

function renderLine(el: Element, ctx: Ctx): HTMLElement {
  const div = document.createElement('gui-shape') as HTMLElement
  div.setAttribute('type', 'line')
  position(div, el, ctx)
  const direction = get(el, 'direction') || 'horizontal'
  const thickness = get(el, 'thickness') || '1'
  const fillStyleName = getRaw(el, 'fill-style')
  const resolvedFill = fillStyleName ? (activeFillStyles[fillStyleName] || null) : get(el, 'fill')
  if (direction === 'vertical') {
    div.style.width = `${thickness}px`
    div.style.alignSelf = 'stretch'
  } else {
    div.style.height = `${thickness}px`
    div.style.alignSelf = 'stretch'
  }
  if (resolvedFill) div.style.background = col(resolvedFill)
  return div
}

function renderShape(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement {
  const type = get(el, 'type')

  if (type === 'path') return renderPath(el, ctx)

  if (type === 'ellipse') {
    const arcStart = get(el, 'arc-start')
    const arcEnd = get(el, 'arc-end')
    const arcInner = get(el, 'arc-inner')
    if (arcStart !== null || arcEnd !== null || arcInner !== null) {
      return renderEllipseArc(el, ctx, get(el, 'fill'), get(el, 'stroke'), get(el, 'stroke-width'))
    }
  }

  const div = document.createElement('gui-shape') as HTMLElement
  if (type) div.setAttribute('type', type)
  position(div, el, ctx)

  if (type === 'line') {
    const sw = get(el, 'stroke-width') || '1'
    const strokeCap = get(el, 'stroke-cap')
    const dashArray = get(el, 'dash-array')
    const dashOffset = get(el, 'dash-offset')

    // Use SVG for lines with any stroke-cap or dash patterns
    if (strokeCap || dashArray) {
      const ns2 = 'http://www.w3.org/2000/svg'
      const length = parseFloat(get(el, 'w') || '0')
      const swNum = parseFloat(sw)
      const isArrow = strokeCap === 'arrow-lines' || strokeCap === 'arrow-equilateral' || strokeCap === 'triangle' || strokeCap === 'triangle-filled'
      const arrowSize = swNum * 3
      const extraPad = isArrow ? arrowSize : swNum
      const svgEl = document.createElementNS(ns2, 'svg')
      svgEl.setAttribute('viewBox', (-extraPad) + ' ' + (-extraPad / 2) + ' ' + (length + extraPad * 2) + ' ' + (swNum + extraPad))
      position(svgEl, el, ctx)
      addClass(svgEl as unknown as HTMLElement, 'gui-block')
      svgEl.style.width = length + 'px'
      svgEl.style.height = swNum + 'px'
      svgEl.style.overflow = 'visible'

      const strokeColor = colSolid(get(el, 'stroke'))

      if (isArrow) {
        // Add SVG arrowhead markers
        const defs = document.createElementNS(ns2, 'defs')
        const markerId = 'gui-arrow-' + (++clipId)
        const marker = document.createElementNS(ns2, 'marker')
        marker.setAttribute('id', markerId)
        marker.setAttribute('markerWidth', '6')
        marker.setAttribute('markerHeight', '6')
        marker.setAttribute('refX', '6')
        marker.setAttribute('refY', '3')
        marker.setAttribute('orient', 'auto')
        const filled = strokeCap === 'triangle-filled'
        if (strokeCap === 'arrow-lines') {
          // Open arrowhead (two lines)
          const p = document.createElementNS(ns2, 'path')
          p.setAttribute('d', 'M 0 0 L 6 3 L 0 6')
          p.setAttribute('fill', 'none')
          p.setAttribute('stroke', strokeColor)
          p.setAttribute('stroke-width', '1')
          marker.appendChild(p)
        } else {
          // Filled triangle arrowhead
          const p = document.createElementNS(ns2, 'polygon')
          p.setAttribute('points', '0 0, 6 3, 0 6')
          p.setAttribute('fill', filled ? strokeColor : 'none')
          p.setAttribute('stroke', strokeColor)
          p.setAttribute('stroke-width', '0.5')
          marker.appendChild(p)
        }
        defs.appendChild(marker)
        svgEl.appendChild(defs)

        const line = document.createElementNS(ns2, 'line')
        line.setAttribute('x1', '0')
        line.setAttribute('y1', '0')
        line.setAttribute('x2', String(length - swNum))
        line.setAttribute('y2', '0')
        line.setAttribute('stroke', strokeColor)
        line.setAttribute('stroke-width', sw)
        line.setAttribute('stroke-linecap', 'butt')
        line.setAttribute('marker-end', 'url(#' + markerId + ')')
        svgEl.appendChild(line)
      } else {
        const line = document.createElementNS(ns2, 'line')
        line.setAttribute('x1', '0')
        line.setAttribute('y1', '0')
        line.setAttribute('x2', String(length))
        line.setAttribute('y2', '0')
        line.setAttribute('stroke', strokeColor)
        line.setAttribute('stroke-width', sw)
        if (strokeCap === 'round') line.setAttribute('stroke-linecap', 'round')
        else if (strokeCap === 'square') line.setAttribute('stroke-linecap', 'square')
        else line.setAttribute('stroke-linecap', 'butt')
        if (dashArray) line.setAttribute('stroke-dasharray', dashArray)
        if (dashOffset) line.setAttribute('stroke-dashoffset', dashOffset)
        svgEl.appendChild(line)
      }
      return svgEl as unknown as HTMLElement
    }

    const rotation = normalizedRightAngle(el)
    const length = get(el, 'w') || '0'

    if (rotation !== null) {
      div.style.transform = ''
      div.style.transformOrigin = ''
      if (rotation === 90 || rotation === 270) {
        div.style.width = `${sw}px`
        div.style.height = `${length}px`
      } else {
        div.style.width = `${length}px`
        div.style.height = `${sw}px`
      }
    } else {
      div.style.width = px(get(el, 'w'))
      div.style.height = `${sw}px`
    }

    div.style.background = col(get(el, 'stroke'))
    if (strokeCap === 'round') div.style.borderRadius = '9999px'
    return div
  }

  const explicitAppearance = hasAppearance(el)
  const appearanceOwnsFill = hasAppearanceFill(el)

  const fillStyleName = getRaw(el, 'fill-style')
  const resolvedFill = fillStyleName ? (activeFillStyles[fillStyleName] || null) : get(el, 'fill')
  if (resolvedFill && !appearanceOwnsFill) div.style.background = col(resolvedFill)

  const sh = shadow(get(el, 'shadow'))
  if (sh) appendBoxShadow(div, sh)

  if (type === 'ellipse') {
    div.style.borderRadius = '50%'
  } else if (type === 'rect') {
    const r = get(el, 'radius')
    if (r) div.style.borderRadius = radii(r)
    applyCornerSmoothing(div, el)
  }

  renderAppearance(el, div, assets, div.style.borderRadius || null)

  const effectStyleName = getRaw(el, 'effect-style')
  if (effectStyleName) applyEffectStyle(div, effectStyleName)

  const rectStrokeWrapper = strokeStyle(div, el, div.style.borderRadius || null)
  strokePerSideStyle(div, el, div.style.borderRadius || null)

  return rectStrokeWrapper || div
}

function renderPath(el: Element, ctx: Ctx): HTMLElement {
  const w = get(el, 'w') || '24'
  const h = get(el, 'h') || '24'
  const fill = get(el, 'fill')
  const s = get(el, 'stroke')
  const sw = get(el, 'stroke-width')
  const strokePos = get(el, 'stroke-position') || 'center'
  const fillRule = get(el, 'fill-rule')
  const dashArray = get(el, 'dash-array')
  const dashOffset = get(el, 'dash-offset')

  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  position(svg, el, ctx)
  addClass(svg, 'gui-block')

  // Support multiple <path> children (compound paths / boolean operations)
  const pathChildren = Array.from(el.querySelectorAll('path'))
  for (const pathEl of pathChildren) {
    const d = pathEl.getAttribute('d')
    if (!d) continue

    const fillColor = fill ? colSolid(fill) : 'none'
    const strokeColor = s ? colSolid(s) : null

    if (!strokeColor || !sw || strokePos === 'center') {
      const p = svgPath(ns, d, fillColor, strokeColor, sw)
      if (fillRule) p.setAttribute('fill-rule', fillRule)
      if (dashArray) p.setAttribute('stroke-dasharray', dashArray)
      if (dashOffset) p.setAttribute('stroke-dashoffset', dashOffset)
      svg.appendChild(p)
      continue
    }

    const strokeWidth = parseFloat(sw)
    if (!Number.isFinite(strokeWidth) || strokeWidth <= 0) {
      const p = svgPath(ns, d, fillColor, null, null)
      if (fillRule) p.setAttribute('fill-rule', fillRule)
      svg.appendChild(p)
      continue
    }

    if (strokePos === 'inside') {
      const id = `gui-clip-${++clipId}`
      const defs = document.createElementNS(ns, 'defs')
      const clip = document.createElementNS(ns, 'clipPath')
      const clipShape = svgPath(ns, d, 'black', null, null)
      clip.setAttribute('id', id)
      clip.appendChild(clipShape)
      defs.appendChild(clip)
      svg.appendChild(defs)

      const fillPath = svgPath(ns, d, fillColor, null, null)
      if (fillRule) fillPath.setAttribute('fill-rule', fillRule)
      const strokePath = svgPath(ns, d, 'none', strokeColor, String(strokeWidth * 2))
      strokePath.setAttribute('clip-path', `url(#${id})`)
      if (dashArray) strokePath.setAttribute('stroke-dasharray', dashArray)
      if (dashOffset) strokePath.setAttribute('stroke-dashoffset', dashOffset)
      svg.appendChild(fillPath)
      svg.appendChild(strokePath)
    } else {
      const strokePath = svgPath(ns, d, 'none', strokeColor, String(strokeWidth * 2))
      if (dashArray) strokePath.setAttribute('stroke-dasharray', dashArray)
      if (dashOffset) strokePath.setAttribute('stroke-dashoffset', dashOffset)
      const fillPath = svgPath(ns, d, fillColor, null, null)
      if (fillRule) fillPath.setAttribute('fill-rule', fillRule)
      svg.appendChild(strokePath)
      svg.appendChild(fillPath)
    }
  }

  return svg as unknown as HTMLElement
}

function svgPath(
  ns: string,
  d: string,
  fill: string,
  stroke: string | null,
  strokeWidth: string | null,
): SVGPathElement {
  const path = document.createElementNS(ns, 'path') as SVGPathElement
  path.setAttribute('d', d)
  path.setAttribute('fill', fill)
  if (stroke && strokeWidth) {
    path.setAttribute('stroke', stroke)
    path.setAttribute('stroke-width', strokeWidth)
  }
  return path
}

function parseComponents(gui: Element): Map<string, Element> {
  const map = new Map<string, Element>()
  for (const block of Array.from(gui.children)) {
    if (block.tagName !== 'components') continue
    for (const comp of Array.from(block.children)) {
      if (comp.tagName === 'component') {
        const id = comp.getAttribute('id')
        if (id) map.set(id, comp)
      } else if (comp.tagName === 'component-set') {
        for (const variant of Array.from(comp.children)) {
          if (variant.tagName === 'variant') {
            const id = variant.getAttribute('id')
            if (id) map.set(id, variant)
          }
        }
      }
    }
  }
  return map
}

function findById(root: Element, id: string): Element | null {
  if (root.getAttribute('id') === id) return root
  for (const child of Array.from(root.children)) {
    const found = findById(child, id)
    if (found) return found
  }
  return null
}

function firstTextDescendant(el: Element): Element | null {
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'text') return child
    const found = firstTextDescendant(child)
    if (found) return found
  }
  return null
}

const INSTANCE_POSITIONAL_ATTRS = new Set([
  'component', 'name', 'x', 'y', 'w', 'h',
  'constraint-h', 'constraint-v', 'abs', 'rotation', 'opacity', 'blend',
  'min-width', 'max-width', 'min-height', 'max-height',
])

function applyPropsToBody(body: Element, instance: Element, compEl: Element): void {
  // Build prop name → { type, targets[], bind } map from declared <props> block
  const propMeta: Record<string, { type: string; targets: string[]; bind: string | null }> = {}
  const propsEl = Array.from(compEl.children).find(c => c.tagName === 'props')
  if (propsEl) {
    for (const propEl of Array.from(propsEl.children)) {
      if (propEl.tagName !== 'prop') continue
      const propName = propEl.getAttribute('name')
      const propType = propEl.getAttribute('type')
      const propTarget = propEl.getAttribute('target')
      const propBind = propEl.getAttribute('bind')
      if (!propName || !propType || !propTarget) continue
      // target is a space-separated list of ids (RFC 0034 multi-target)
      const targets = propTarget.trim().split(/\s+/).filter(Boolean)
      propMeta[propName] = { type: propType, targets, bind: propBind }
      const overrideVal = instance.getAttribute(propName)
      if (overrideVal === null) continue
      // Apply to every target id in the list
      for (const targetId of targets) {
        const targetEl = findById(body, targetId)
        if (!targetEl) continue
        // For string/text props: if target is a container walk to first <text> descendant
        const isTextType = propType === 'string' || propType === 'text'
        const effectiveTarget = (isTextType && targetEl.tagName !== 'text')
          ? (firstTextDescendant(targetEl) || targetEl)
          : targetEl
        applyOverride(effectiveTarget, propType, overrideVal, propBind)
      }
    }
  }

  // Also apply any ad-hoc overrides — instance attrs that aren't positional/structural
  // and weren't already handled by a declared prop. Target = element with matching id.
  //
  // Style/stroke override attrs use a suffix convention to encode bind:
  //   label-2-text        → target id="label-2",  bind="text-style"
  //   label-2-fill        → target id="label-2",  bind="fill-style"
  //   label-2-effect      → target id="label-2",  bind="effect-style"
  //   label-2-stroke-style → target id="label-2", bind="stroke-style"
  //   label-2-stroke      → target id="label-2",  bind="stroke" (color)
  // We try the full attr name first (covers regular overrides); if not found we
  // strip the known suffix and retry — that covers the style/stroke cases.
  const STYLE_SUFFIXES: Array<{ suffix: string; type: string; bind: string }> = [
    { suffix: '-stroke-style', type: 'style',   bind: 'stroke-style' },
    { suffix: '-text',         type: 'style',   bind: 'text-style'   },
    { suffix: '-fill',         type: 'style',   bind: 'fill-style'   },
    { suffix: '-effect',       type: 'style',   bind: 'effect-style' },
    { suffix: '-stroke',       type: 'color',   bind: 'stroke'       },
    { suffix: '-radius',       type: 'number',  bind: 'radius'       },
    { suffix: '-opacity',      type: 'number',  bind: 'opacity'      },
  ]
  for (const attr of Array.from(instance.attributes)) {
    if (INSTANCE_POSITIONAL_ATTRS.has(attr.name)) continue
    if (propMeta[attr.name] !== undefined) continue  // already handled above

    // Try full attr name → target id first (regular overrides)
    let targetEl = findById(body, attr.name)
    let inferredType = ''
    let inferredBind: string | null = null

    if (targetEl) {
      // Regular override — infer type from element and value
      inferredType = targetEl.tagName === 'text' ? 'string'
        : attr.value === 'false' || attr.value === 'true' ? 'boolean'
        : targetEl.tagName === 'instance' ? 'component'
        : targetEl.getAttribute('src') !== null ? 'image'
        : 'string'
    } else {
      // Try stripping a known suffix to find the actual target element
      // Order matters: check -stroke-style before -stroke (longer match first)
      for (const s of STYLE_SUFFIXES) {
        if (!attr.name.endsWith(s.suffix)) continue
        const candidateId = attr.name.slice(0, attr.name.length - s.suffix.length)
        const candidateEl = findById(body, candidateId)
        if (!candidateEl) continue
        targetEl = candidateEl
        inferredType = s.type
        inferredBind = s.bind
        break
      }
      if (!targetEl) continue
    }

    const effectiveTarget = (inferredType === 'string' && targetEl.tagName !== 'text')
      ? (firstTextDescendant(targetEl) || targetEl)
      : targetEl
    applyOverride(effectiveTarget, inferredType, attr.value, inferredBind)
  }
}

function applyOverride(targetEl: Element, type: string, value: string, bind?: string | null): void {
  // New typed vocabulary (RFC 0034)
  if (type === 'string' || type === 'text') {
    // bind="align", bind="href" etc. override a specific string attr; default is value
    targetEl.setAttribute(bind || 'value', value)
  } else if ((type === 'boolean' || type === 'visible') && value === 'false') {
    targetEl.parentNode && targetEl.parentNode.removeChild(targetEl)
  } else if (type === 'color' || type === 'fill') {
    // bind="stroke" overrides stroke color; default is fill
    targetEl.setAttribute(bind || 'fill', value)
  } else if (type === 'image' || type === 'src') {
    targetEl.setAttribute('src', value)
  } else if (type === 'component') {
    targetEl.setAttribute('component', value)
  } else if (type === 'number' && bind) {
    // bind names the numeric property — required for number type
    targetEl.setAttribute(bind, value)
  } else if (type === 'style' && bind) {
    // bind names the style slot: text-style, fill-style, effect-style, stroke-style
    targetEl.setAttribute(bind, value)
    // When overriding text-style, clear any explicit individual typography attrs that
    // were set in the component body — otherwise styledAttr() returns them first and
    // the new style has no effect (direct attrs shadow the named style).
    if (bind === 'text-style') {
      const TYPO_ATTRS = ['font-size', 'font-weight', 'font-style', 'line-height',
        'letter-spacing', 'font-family', 'font-postscript', 'font-style-name',
        'font-stretch', 'font-variation', 'font-feature', 'text-case', 'decoration']
      for (let i = 0; i < TYPO_ATTRS.length; i++) targetEl.removeAttribute(TYPO_ATTRS[i])
    }
  }
}

function applyScaleConstraints(node: Element, scaleX: number, scaleY: number): void {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i] as Element
    const ch = child.getAttribute('constraint-h')
    const cv = child.getAttribute('constraint-v')
    const scaleH = ch === 'scale' || ch === 'left-right'
    const scaleV = cv === 'scale' || cv === 'top-bottom'
    if (scaleH || scaleV) {
      if (scaleH) {
        const x = parseFloat(child.getAttribute('x') || '0')
        const w = parseFloat(child.getAttribute('w') || '0')
        if (w > 0) child.setAttribute('w', String(Math.round(w * scaleX)))
        if (x !== 0) child.setAttribute('x', String(Math.round(x * scaleX)))
      }
      if (scaleV) {
        const y = parseFloat(child.getAttribute('y') || '0')
        const h = parseFloat(child.getAttribute('h') || '0')
        if (h > 0) child.setAttribute('h', String(Math.round(h * scaleY)))
        if (y !== 0) child.setAttribute('y', String(Math.round(y * scaleY)))
      }
    }
    if (child.children.length > 0) applyScaleConstraints(child, scaleX, scaleY)
  }
}

function renderInstance(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement | null {
  const compId = get(el, 'component')
  if (!compId) return null
  const compEl = activeComponents.get(compId)
  if (!compEl) return null

  const bodyEl = Array.from(compEl.children).find(c => c.tagName !== 'props')
  if (!bodyEl) return null

  const body = bodyEl.cloneNode(true) as Element

  applyPropsToBody(body, el, compEl)

  // Compute scale factors if instance overrides w/h vs component body dimensions
  const origW = parseFloat(bodyEl.getAttribute('w') || '0')
  const origH = parseFloat(bodyEl.getAttribute('h') || '0')
  const instW = parseFloat(el.getAttribute('w') || '0')
  const instH = parseFloat(el.getAttribute('h') || '0')
  const scaleX = origW > 0 && instW > 0 ? instW / origW : 1
  const scaleY = origH > 0 && instH > 0 ? instH / origH : 1

  // Override position/sizing/appearance from instance element onto body root
  for (const attr of [
    'x', 'y', 'w', 'h', 'constraint-h', 'constraint-v', 'abs', 'rotation',
    'opacity', 'blend', 'visible', 'min-width', 'max-width', 'min-height', 'max-height',
    'radius', 'fill', 'fill-style', 'shadow', 'clip', 'overflow-x', 'overflow-y',
  ]) {
    const val = el.getAttribute(attr)
    if (val !== null) body.setAttribute(attr, val)
  }

  // If instance sets radius, ensure the body clips its children so rounded corners show,
  // and propagate the radius to any scale-constrained children (they fill the parent).
  const instanceRadius = el.getAttribute('radius')
  if (instanceRadius !== null) {
    if (body.getAttribute('clip') === null) body.setAttribute('clip', 'true')
    for (let i = 0; i < body.children.length; i++) {
      const child = body.children[i] as Element
      if (child.getAttribute('constraint-h') === 'scale' && child.getAttribute('constraint-v') === 'scale') {
        child.setAttribute('radius', instanceRadius)
      }
    }
  }

  // Apply scale constraints to direct and nested children
  if (scaleX !== 1 || scaleY !== 1) applyScaleConstraints(body, scaleX, scaleY)

  return renderNode(body, assets, ctx)
}

function renderNode(el: Element, assets: Record<string, string>, ctx: Ctx): HTMLElement | null {
  // RFC-0037: set the active mode for this node + its subtree (mode-{axis}
  // attributes cascade), then restore the parent's mode once it is rendered.
  const prevMode = currentMode
  currentMode = computeMode(el, prevMode)
  try {
    switch (el.tagName) {
      case 'frame': return renderFrame(el, assets, ctx, false)
      case 'stack':
      case 'row':
      case 'col':
      case 'grid': return renderFrame(el, assets, ctx, true)
      case 'group': return renderGroup(el, assets, ctx)
      case 'text': return renderText(el, assets, ctx)
      case 'img': return renderImg(el, assets, ctx)
      case 'rect': return renderRect(el, assets, ctx)
      case 'ellipse': return renderEllipse(el, assets, ctx)
      case 'line': return renderLine(el, ctx)
      // legacy — kept for backward compat with pre-0.3 files
      case 'svg': return renderSvgAsset(el, assets, ctx)
      case 'shape': return renderShape(el, assets, ctx)
      case 'instance': return renderInstance(el, assets, ctx)
      default: return null
    }
  } finally {
    currentMode = prevMode
  }
}



function googleFamilyParam(font: Element): string | null {
  const family = font.getAttribute('family')
  if (!family) return null

  const weights = (font.getAttribute('weights') || '400')
    .split(/[\s,]+/)
    .filter(Boolean)
    .sort((a, b) => parseInt(a) - parseInt(b))
  const styles = (font.getAttribute('styles') || 'normal')
    .split(/[\s,]+/)
    .filter(Boolean)
  const variants = (font.getAttribute('variants') || '')
    .split(/[\s,]+/)
    .filter(Boolean)
  const variantSet = variants.reduce((set, variant) => {
    set[variant] = true
    return set
  }, {} as Record<string, boolean>)

  const familyName = encodeURIComponent(family).replace(/%20/g, '+')
  if (!weights.length) return familyName

  if (styles.indexOf('italic') !== -1) {
    const pairs: string[] = []
    for (const weight of weights) {
      if (!variants.length || variantSet[weight === '400' ? 'regular' : weight]) pairs.push(`0,${weight}`)
    }
    for (const weight of weights) {
      if (!variants.length || variantSet[weight === '400' ? 'italic' : `${weight}italic`]) pairs.push(`1,${weight}`)
    }
    if (!pairs.length) return familyName
    return `${familyName}:ital,wght@${pairs.join(';')}`
  }

  const validWeights = variants.length
    ? weights.filter(weight => variantSet[weight === '400' ? 'regular' : weight])
    : weights
  if (!validWeights.length) return familyName
  return `${familyName}:wght@${validWeights.join(';')}`
}

function injectFonts(fonts: Record<string, FontInfo>): void {
  const families: string[] = []
  for (const [family, info] of Object.entries(fonts)) {
    if (info.source !== 'google') continue
    // Reconstruct a fake Element-like object for googleFamilyParam reuse
    const el = document.createElement('span')
    el.setAttribute('family', family)
    if (info.weights) el.setAttribute('weights', info.weights)
    if (info.styles) el.setAttribute('styles', info.styles)
    if (info.variants) el.setAttribute('variants', info.variants)
    const param = googleFamilyParam(el)
    if (param && families.indexOf(param) === -1) families.push(param)
  }

  if (!families.length || typeof document === 'undefined') return

  if (!document.querySelector('link[data-gui-fonts-preconnect="google-fonts"]')) {
    const preconnect = document.createElement('link')
    preconnect.rel = 'preconnect'
    preconnect.href = 'https://fonts.gstatic.com'
    preconnect.crossOrigin = 'anonymous'
    preconnect.setAttribute('data-gui-fonts-preconnect', 'google-fonts')
    document.head.appendChild(preconnect)
  }

  const existingLinks = Array.from(document.querySelectorAll('link[data-gui-fonts]')) as HTMLLinkElement[]
  for (const family of families) {
    const href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`
    if (existingLinks.some(link => link.href === href || link.getAttribute('href') === href)) continue

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.setAttribute('data-gui-fonts', href)
    document.head.appendChild(link)
  }
}

export interface RenderOptions {
  /**
   * Wrap the output in an interactive pan/zoom canvas.
   * When `true`, users can drag to pan and scroll/pinch to zoom.
   * The returned setter controls zoom programmatically (`1` = fit-to-container).
   *
   * Defaults to `false` — the rendered element is placed directly in the
   * container at its native pixel size with no interactive wrapper.
   */
  zoom?: boolean

  /**
   * RFC-0037 render-time active mode: axis → value (e.g. `{ theme: 'dark' }`).
   * Seeds the active mode for the whole tree. Any `mode-{axis}` attribute in the
   * document overrides it for that subtree; axes left unset fall back to their
   * declared `default`. Use this to preview an unpinned file in another mode.
   */
  mode?: Record<string, string>

  /**
   * Initial pan/zoom state for the interactive canvas (only used with `zoom`).
   * Pass a value previously read from {@link ZoomControl.getView} to preserve the
   * viewport across re-renders instead of snapping back to fit. Ignored otherwise.
   */
  view?: ZoomView
}

export interface ZoomView {
  scale: number
  x: number
  y: number
  /** Raw CSS transform string captured at read time — used to avoid a re-render flash. */
  transform?: string
}

/** The zoom setter returned by {@link render}, augmented with a viewport reader. */
export type ZoomControl = ((factor: number, anchorX?: number, anchorY?: number) => void) & {
  getView: () => ZoomView | null
}

/**
 * Render a .gui document string into a container element.
 *
 * @param code      - Full .gui XML string
 * @param container - Host element to render into (cleared on each call)
 * @param assetMap  - Optional pre-built asset map `{ '$img-1': 'data:image/webp;base64,...' }`.
 *                    When provided the `<assets>` block in the XML is ignored, which avoids
 *                    re-parsing large base64 blobs and prevents parse failures on big files.
 * @param options   - Rendering options (see {@link RenderOptions})
 *
 * @returns A zoom setter `(factor, anchorX?, anchorY?) => void` where `1` = fit-to-container,
 *          or `null` if `zoom` is `false` (default) or the document failed to parse.
 *
 * @example
 *   // Plain render — no zoom wrapper (default)
 *   render(guiCode, el)
 *
 *   // Interactive preview canvas
 *   const setZoom = render(guiCode, el, undefined, { zoom: true })
 *   setZoom(2)   // 2× the fit scale
 *   setZoom(1)   // back to fit
 */
export function render(
  code: string,
  container: HTMLElement,
  assetMap?: Record<string, string>,
  options?: RenderOptions,
): ZoomControl | null {
  ensureRenderUtilities()
  container.innerHTML = ''

  // Use gui-parser for all metadata (tokens, fonts, styles, effects, assets)
  const parsed = parseXml(code, assetMap)
  if (!parsed) {
    container.innerHTML = '<div style="color:#888;padding:24px;font-size:12px">Invalid .gui</div>'
    return null
  }
  activeTokens = parsed.tokens
  activeModes = parsed.modes
  activeTokenDefs = parsed.tokenDefs
  activeFonts = parsed.fonts
  activeStyles = parsed.textStyles
  activeFillStyles = parsed.fillStyles
  activeEffectStyles = parsed.effectStyles
  injectFonts(parsed.fonts)
  const assets = parsed.assets

  // Still parse DOM for node walking — render functions operate on Elements
  let doc: Document
  try {
    const sanitized = normalizeBooleanAttrs(code).replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;')
    doc = new DOMParser().parseFromString(sanitized, 'text/xml')
    if (doc.querySelector('parsererror')) throw new Error()
  } catch {
    container.innerHTML = '<div style="color:#888;padding:24px;font-size:12px">Invalid .gui</div>'
    return null
  }

  const gui = doc.documentElement
  activeComponents = parseComponents(gui)
  const STACK_TAGS = new Set(['stack', 'row', 'col', 'grid'])
  let screenEl: Element | null = null
  for (const child of Array.from(gui.children)) {
    if (child.tagName === 'frame' || STACK_TAGS.has(child.tagName)) { screenEl = child; break }
  }
  if (!screenEl) return null

  // RFC-0037: seed the active mode from the render-time input, then layer the
  // root element's own mode-{axis} pins on top. Descendants re-layer in renderNode.
  currentMode = computeMode(screenEl, options && options.mode ? { ...options.mode } : {})

  // Canvas dimensions come from the root element's w/h — not a separate viewport attr.
  // w is always explicit on root. h is explicit for fixed artboards (<frame>), absent for
  // content-driven screens (<col>) where height is determined by content.
  const rootWAttr = screenEl.getAttribute('w')
  const rootHAttr = screenEl.getAttribute('h')
  const vw = (rootWAttr && rootWAttr !== 'fill') ? (parseInt(rootWAttr) || 390) : 390
  const fixedVh = (rootHAttr && rootHAttr !== 'fill') ? parseInt(rootHAttr) : null

  const screen = renderFrame(screenEl, assets, { absolute: false }, STACK_TAGS.has(screenEl.tagName))
  screen.style.width = `${vw}px`
  if (fixedVh !== null) screen.style.height = `${fixedVh}px`
  addClass(screen, 'gui-relative')
  screen.style.flexShrink = '0'
  screen.style.outline = '1px solid #0d99ff'

  // ── Bare mode (zoom: false, default) ────────────────────────────────────────
  // Attach the rendered element directly — no wrapper, no panzoom.
  if (!options?.zoom) {
    container.appendChild(screen)
    return null
  }

  // ── Zoom canvas mode (zoom: true) ────────────────────────────────────────────
  // Wrap in a pan/zoom canvas. Users can drag to pan and scroll/pinch to zoom.
  const stage = document.createElement('div')
  const stageH = fixedVh !== null ? `height:${fixedVh}px;` : ''
  stage.style.cssText = `position:absolute;left:0;top:0;width:${vw}px;${stageH}transform-origin:0 0;will-change:transform;`
  stage.appendChild(screen)

  const outer = document.createElement('div')
  outer.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;cursor:default;touch-action:none;user-select:none;'
  outer.appendChild(stage)
  container.appendChild(outer)

  const initView = options?.view

  // For dynamic-height roots, measure actual rendered height after DOM insertion.
  function getVh(): number {
    return fixedVh !== null ? fixedVh : (screen.offsetHeight || screen.scrollHeight || 844)
  }

  function fitZoom(): number {
    const vh = getVh()
    return Math.min((outer.clientWidth - 48) / vw, (outer.clientHeight - 48) / vh, 1)
  }

  // Centering formula for panzoom's coordinate system:
  // panzoom sets transform-origin to 50% 50% and applies scale(s) translate(x,y).
  // Visual center of stage lands at (vw/2 + s*x, vh/2 + s*y).
  // To center in outer: s*x = (W-vw)/2 → x = (W-vw)/(2*s).
  function centeredPan(currentScale: number): { x: number; y: number } {
    const vh = getVh()
    return {
      x: (outer.clientWidth - vw) / (2 * currentScale),
      y: (outer.clientHeight - vh) / (2 * currentScale),
    }
  }

  // Centering formula for direct matrix transform (origin 0 0, used before panzoom init).
  function centeredMatrix(currentScale: number): { x: number; y: number } {
    const vh = getVh()
    return {
      x: (outer.clientWidth - vw * currentScale) / 2,
      y: (outer.clientHeight - vh * currentScale) / 2,
    }
  }

  let baseZoom = fitZoom()
  let zoomFactor = 1
  let panzoom: PanzoomObject | null = null

  // Apply the prior viewport (if restoring) or a centered transform immediately
  // so there's no flash before panzoom initializes in requestAnimationFrame.
  if (initView?.transform) {
    stage.style.transform = initView.transform
  } else if (baseZoom > 0) {
    const { x, y } = centeredMatrix(baseZoom)
    stage.style.transform = `matrix(${baseZoom}, 0, 0, ${baseZoom}, ${x}, ${y})`
  }

  function applyCenteredZoom(nextFactor: number): void {
    const nextScale = baseZoom * nextFactor
    if (!panzoom) {
      const { x, y } = centeredMatrix(nextScale)
      stage.style.transform = `matrix(${nextScale}, 0, 0, ${nextScale}, ${x}, ${y})`
      return
    }
    const pan = centeredPan(nextScale)
    panzoom.zoom(nextScale, { animate: false, force: true })
    panzoom.pan(pan.x, pan.y, { animate: false, force: true })
  }

  function setZoom(factor: number, anchorX?: number, anchorY?: number): void {
    const nextFactor = Math.max(0.1, Math.min(factor, 16))
    const nextScale = baseZoom * nextFactor
    if (!nextScale) return

    if (anchorX === undefined || anchorY === undefined) {
      zoomFactor = nextFactor
      applyCenteredZoom(nextFactor)
      return
    }

    zoomFactor = nextFactor
    if (!panzoom) {
      applyCenteredZoom(nextFactor)
      return
    }

    const rect = outer.getBoundingClientRect()
    panzoom.zoomToPoint(nextScale, {
      clientX: rect.left + anchorX,
      clientY: rect.top + anchorY,
    }, { animate: false, force: true })
  }

  requestAnimationFrame(() => {
    // A newer render() may have cleared the container before this frame ran,
    // detaching our stage. Panzoom throws on detached elements, so bail out.
    if (!stage.isConnected) return
    baseZoom = fitZoom()
    const pan = centeredPan(baseZoom)
    panzoom = Panzoom(stage, {
      canvas: true,
      cursor: 'default',
      // Figma-style: panning is by scroll, not drag — leaves left-click for select.
      disablePan: true,
      maxScale: baseZoom * 16,
      minScale: baseZoom * 0.1,
      overflow: 'hidden',
      startScale: initView ? initView.scale : baseZoom,
      startX: initView ? initView.x : pan.x,
      startY: initView ? initView.y : pan.y,
      step: 0.18,
      touchAction: 'none',
    })
  })

  // Figma-style wheel: plain scroll (incl. trackpad two-finger) pans; ctrl/cmd+
  // scroll and trackpad pinch (which the browser reports as ctrlKey) zoom to the
  // cursor. The browser fires this with passive:false so preventDefault sticks.
  outer.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (!panzoom) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const cur = panzoom.getScale()
        const next = Math.min(Math.max(cur * Math.exp(-e.deltaY * 0.0125), baseZoom * 0.1), baseZoom * 16)
        panzoom.zoomToPoint(next, e, { animate: false, force: true })
        zoomFactor = next / baseZoom
      } else {
        const s = panzoom.getScale()
        const cur = panzoom.getPan()
        panzoom.pan(cur.x - e.deltaX / s, cur.y - e.deltaY / s, { animate: false, force: true })
      }
    },
    { passive: false },
  )

  const control = setZoom as ZoomControl
  control.getView = () =>
    panzoom
      ? { scale: panzoom.getScale(), x: panzoom.getPan().x, y: panzoom.getPan().y, transform: stage.style.transform }
      : null
  return control
}

/**
 * Render a .gui document to a standalone HTML string (browser only).
 *
 * Returns a complete `<!DOCTYPE html>` document with:
 *  - all CSS utilities inlined
 *  - Google Font `<link>` tags included
 *  - the rendered screen as its body content
 *
 * @param code     - Full .gui XML string
 * @param assetMap - Optional pre-built asset map `{ '$img-1': 'data:image/...;base64,...' }`
 * @returns Standalone HTML document string
 *
 * @example
 *   const html = renderToHTML(guiCode)
 *   document.getElementById('iframe').srcdoc = html
 */
export function renderToHTML(
  code: string,
  assetMap?: Record<string, string>,
  options?: RenderOptions,
): string {
  if (typeof document === 'undefined') {
    throw new Error('renderToHTML requires a browser DOM environment')
  }

  ensureRenderUtilities()

  // Off-screen host with a generous viewport so panzoom can fit any content
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:-99999px;top:-99999px;width:1280px;height:960px;visibility:hidden;pointer-events:none;'
  document.body.appendChild(host)

  render(code, host, assetMap, options)

  // render() tags the screen element with gui-relative
  const screen = host.querySelector('.gui-relative') as HTMLElement | null
  let screenHtml = ''
  if (screen) {
    const clone = screen.cloneNode(true) as HTMLElement
    // Strip debug chrome added by render()
    clone.style.outline = ''
    clone.style.flexShrink = ''
    screenHtml = clone.outerHTML
  }

  // Collect Google Font <link> tags injected by injectFonts()
  const fontLinks = [
    ...Array.from(document.querySelectorAll('link[data-gui-fonts-preconnect]')),
    ...Array.from(document.querySelectorAll('link[data-gui-fonts]')),
  ]
    .map(el => (el as HTMLElement).outerHTML)
    .join('\n  ')

  document.body.removeChild(host)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${fontLinks}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f0f0f0; display: flex; justify-content: center; align-items: flex-start; padding: 40px; min-height: 100vh; }
${RENDER_UTILITIES}
  </style>
</head>
<body>
  ${screenHtml}
</body>
</html>`
}
