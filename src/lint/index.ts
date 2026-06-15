/**
 * The dotgui linter — the kit's canonical idiom + content checker. Beyond schema
 * legality (that's `validate`), this flags non-idiomatic markup (empty spacers,
 * invented attributes, bad color formats, undefined tokens) and content "AI
 * tells". Parses markup into a DOM (happy-dom) and runs the checks in order.
 *
 * This is the single source of truth: the CLI, gui-app, and the skill linter all
 * consume it instead of keeping their own ports (build_gui.py / gui-app validator
 * are retired onto this). Keep in sync with references/spec.md.
 */
import { parseGui, walk, BOOLEAN_ATTRS, type El } from '../dom'

export interface LintIssue {
  level: 'error' | 'warn'
  where: string
  message: string
}

export interface LintResult {
  issues: LintIssue[]
  errors: LintIssue[]
  ok: boolean
  ran: boolean
}

// ── Spec surface (mirror references/spec.md) ─────────────────────────────────
const KNOWN_TAGS = new Set([
  'gui', 'mode', 'modes', 'tokens', 'color', 'number', 'string',
  'styles', 'text-style', 'fonts', 'font',
  'components', 'component', 'component-set', 'variant', 'props', 'prop', 'instance',
  'frame', 'col', 'row', 'grid', 'stack', 'group',
  'text', 'segment', 'img', 'rect', 'ellipse', 'line',
  'appearance', 'fill', 'effect', 'border',
])
const LAYOUT_CONTAINERS = new Set(['col', 'row', 'grid', 'stack', 'frame', 'group'])
const REQUIRE_WH = new Set(['frame', 'rect', 'ellipse', 'img', 'group'])
const NINE_POINT_ALIGN = new Set([
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
  'stretch', 'baseline',
])
const TEXT_ALIGN_VALUES = new Set(['left', 'center', 'right', 'justified'])
const NON_REF_ATTRS = new Set(['value', 'name', 'id'])
const CSS_COLOR_KEYWORDS = new Set([
  'red', 'blue', 'green', 'black', 'white', 'gray', 'grey', 'transparent',
  'orange', 'yellow', 'purple', 'pink', 'cyan', 'magenta', 'brown',
])
const HEX_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const TOKEN_REF_RE = /\$[A-Za-z][A-Za-z0-9_-]*/g

const INVENTED_ATTRS: Record<string, string> = {
  py: 'use pt= and pb=, or CSS-shorthand p="V H"',
  px: 'use pl= and pr=, or CSS-shorthand p="V H"',
  margin: "dotgui has no margins — space siblings with the parent's gap= or padding",
  mt: "dotgui has no margins — space siblings with the parent's gap= or padding",
  mb: "dotgui has no margins — space siblings with the parent's gap= or padding",
  ml: "dotgui has no margins — space siblings with the parent's gap= or padding",
  mr: "dotgui has no margins — space siblings with the parent's gap= or padding",
  spacing: 'use gap=',
  justify: 'use the 9-point align= (e.g. align="middle-center")',
  'justify-content': 'use the 9-point align= (e.g. align="middle-center")',
  'align-items': 'use the 9-point align= (e.g. align="middle-center")',
  flex: 'use w="fill" / h="fill" to grow',
}

const CONTENT_TELLS: [RegExp, string][] = [
  [/[—–]/, "em/en-dash in copy — the strongest AI 'tell'. Use a hyphen, comma, or split the sentence."],
  [/\blorem ipsum\b/i, 'lorem ipsum placeholder — write real, plausible content.'],
  [/\b(john|jane)\s+doe\b/i, 'generic placeholder name — use a real, specific name.'],
  [/\buser\s*name\b/i, "'User Name' placeholder — write a real name."],
  [/\b[\w.+-]+@(example|email|domain|test)\.(com|org)\b/i, 'placeholder email (user@example.com) — use a plausible address.'],
  [/welcome back/i, "'Welcome back' header — a tired AI default; say something specific."],
  [/all rights reserved/i, "'All rights reserved' boilerplate footer — real footers say more."],
  [/\b(acme|nexus|smartflow|cloudly|innovatech)\b/i, 'startup-slop brand name — invent a specific, real-sounding name.'],
  [/\b(elevate|seamless|unleash|next-gen|revolutionize|supercharge)\b/i, 'filler marketing verb — write concrete copy instead.'],
  [/[\u{1F300}-\u{1FAFF}☀-➿]/u, "emoji in UI copy (e.g. 'Welcome back 👋') — usually an AI tell; drop it unless the design genuinely calls for it."],
]

// ── DOM helpers ──────────────────────────────────────────────────────────────
function parentMap(root: El): Map<El, El> {
  const m = new Map<El, El>()
  const visit = (el: El) => { for (const c of Array.from(el.children) as El[]) { m.set(c, el); visit(c) } }
  visit(root)
  return m
}
function attrs(el: El): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  for (let i = 0; i < el.attributes.length; i++) out.push({ name: el.attributes[i].name, value: el.attributes[i].value })
  return out
}
function label(el: El): string {
  const name = el.getAttribute('name') || el.getAttribute('value')
  return name ? `<${el.tagName} "${name.slice(0, 24)}">` : `<${el.tagName}>`
}
function hasElementChildren(el: El): boolean { return el.children.length > 0 }
function isVisibleBlock(el: El): boolean {
  if (['fill', 'border', 'stroke'].some((a) => el.hasAttribute(a))) return true
  return (Array.from(el.children) as El[]).some((c) => c.tagName === 'appearance' || c.tagName === 'fill')
}
function resolvesHeight(el: El): boolean {
  if (el.tagName === 'frame') return true
  const h = el.getAttribute('h') ?? ''
  return h === 'fill' || /^\d+(\.\d+)?$/.test(h)
}
function hasRange(el: El): boolean {
  return ['gc', 'gr'].some((a) => (el.getAttribute(a) ?? '').includes('/'))
}

// ── Lint ─────────────────────────────────────────────────────────────────────
export function lintMarkup(xml: string): LintResult {
  const { root, error } = parseGui(xml)
  if (error || !root) {
    const issues: LintIssue[] = [{ level: 'error', where: '', message: error ?? 'parse failed' }]
    return { issues, errors: issues, ok: false, ran: true }
  }

  const issues: LintIssue[] = []
  const push = (level: 'error' | 'warn', message: string, where = '') => issues.push({ level, where, message })

  const tokenNames = new Set<string>()
  const tokens = (Array.from(root.children) as El[]).find((c) => c.tagName === 'tokens')
  if (tokens) for (const t of Array.from(tokens.children) as El[]) if (t.getAttribute('name')) tokenNames.add(t.getAttribute('name'))

  const nodes = walk(root)
  const parents = parentMap(root)

  for (const el of nodes) {
    const tag: string = el.tagName
    const lbl = label(el)

    // 1. Unknown tags.
    if (!KNOWN_TAGS.has(tag)) {
      push('error', `unknown tag ${lbl} — not in the dotgui spec. See references/spec.md for the allowed tag set.`, tag)
      continue
    }

    // 2. Empty spacer nodes.
    if (LAYOUT_CONTAINERS.has(tag) && !hasElementChildren(el)) {
      if (isVisibleBlock(el)) push('warn', `${lbl} is an empty filled box — use <rect> for a decorative block instead of an empty ${tag}.`, tag)
      else push('error', `${lbl} is an empty spacer node. Do NOT use empty col/row/frame to create space. Use gap=, padding (p/pt/pr/pb/pl), or gap="auto" on the parent instead.`, tag)
    }

    // 3. Required w/h.
    if (REQUIRE_WH.has(tag) && !hasRange(el)) {
      if (!el.hasAttribute('w')) push('error', `${lbl} is missing required w=`, tag)
      if (!el.hasAttribute('h')) push('error', `${lbl} is missing required h=`, tag)
    }

    // 3b. w="fill" child needs a width-defined parent.
    if (['col', 'row', 'stack'].includes(tag) && !el.hasAttribute('w') && !hasRange(el)) {
      const fillKids = (Array.from(el.children) as El[]).some((c) => c.getAttribute('w') === 'fill')
      if (fillKids) push('error', `${lbl} has w="fill" children but no width of its own. A fill child needs a sized parent to fill into — give ${lbl} w="fill" (or a fixed w=), otherwise it hugs its content and overflows the canvas.`, tag)
    }

    // 3c. A text prop can only override value=, never an <img> src.
    if (tag === 'prop' && el.getAttribute('type') === 'text') {
      const target = nodes.find((n) => n.getAttribute('id') === el.getAttribute('target'))
      if (target && target.tagName === 'img') {
        push('error', `prop "${el.getAttribute('name') ?? '?'}" has type="text" but its target is an <img>. A text prop overrides value=, not an image src=, so every instance keeps the same picture. There is no image prop in v0.2 — author cards with differing images INLINE (not as instances of one component), or vary them via a fill/token.`, tag)
      }
    }

    // 3d. abs bottom-pin needs a sized ancestor.
    if (el.hasAttribute('abs') && (el.hasAttribute('b') || el.getAttribute('y') === 'auto')) {
      let anc = parents.get(el)
      let grounded = false
      while (anc) { if (resolvesHeight(anc)) { grounded = true; break } anc = parents.get(anc) }
      if (!grounded) push('error', `${lbl} is bottom-anchored (b=/y="auto") but no ancestor has a height to anchor to, so it renders at the TOP and overlaps content. A floating bottom bar needs a fixed-size <frame w h> root (or a sized ancestor), not a hugging <col>.`, tag)
    }

    // 4. Text node shape.
    if (tag === 'text') {
      const hasValue = el.hasAttribute('value')
      const hasSegments = (Array.from(el.children) as El[]).some((c) => c.tagName === 'segment')
      if (hasValue && hasSegments) push('error', `${lbl} has both value= and <segment> children. Use one.`, tag)
      if (!hasValue && !hasSegments) push('error', `${lbl} has neither value= nor <segment> children.`, tag)
      if (!['color', 'fill', 'text-style'].some((a) => el.hasAttribute(a)) && !hasSegments) push('warn', `${lbl} has no color/fill/text-style — text should never inherit color in .gui.`, tag)
      if (el.hasAttribute('text-align')) push('error', `${lbl} uses text-align= — the renderer ignores it. The text alignment attribute is align="left|center|right".`, tag)
    }

    // 5. Legacy stroke.
    if (el.hasAttribute('stroke') || el.hasAttribute('stroke-width')) {
      push('warn', `${lbl} uses legacy stroke=/stroke-width=. The current API is border="<width> <color> [style] [align]" (e.g. border="1 $border").`, tag)
    }

    // 5a. align values.
    const alignVal = el.getAttribute('align')
    if (alignVal !== null) {
      if (tag === 'text' || tag === 'segment') {
        if (!TEXT_ALIGN_VALUES.has(alignVal)) push('error', `${lbl} align="${alignVal}" is invalid on text. Use left, center, right, or justified.`, tag)
      } else if (!NINE_POINT_ALIGN.has(alignVal)) {
        push('error', `${lbl} align="${alignVal}" is not a 9-point value. Use e.g. middle-center, top-left, bottom-right (not "center" alone, and no invented combinations).`, tag)
      }
    }

    // 5a2. boolean="false".
    for (const b of BOOLEAN_ATTRS) if (el.getAttribute(b) === 'false') push('error', `${lbl} ${b}="false" is wrong — booleans are presence-based; omit the attribute instead.`, tag)

    // 5b. Invented attributes.
    for (const [bad, fix] of Object.entries(INVENTED_ATTRS)) if (el.hasAttribute(bad)) push('error', `${lbl} uses ${bad}= — not a dotgui attribute, the renderer ignores it and the layout breaks silently. Instead: ${fix}.`, tag)

    // 6. gap="auto" needs a fill dimension.
    const gap = el.getAttribute('gap')
    if (gap === 'auto' || gap === '') {
      if ((tag === 'row' || tag === 'stack') && el.getAttribute('w') !== 'fill') push('warn', `${lbl} has gap="auto" but no w="fill"; space-between collapses when the row hugs content.`, tag)
      if (tag === 'col' && el.getAttribute('h') !== 'fill') push('warn', `${lbl} has gap="auto" but no h="fill"; space-between collapses when the column hugs content.`, tag)
    }

    // 7. Color formats on color-bearing attributes.
    for (const attr of ['fill', 'color', 'border-color']) {
      if (!el.hasAttribute(attr)) continue
      const val = (el.getAttribute(attr) ?? '').trim()
      if (!val || val === 'none' || val.startsWith('$') || val.includes('gradient(')) continue
      if (val.startsWith('#')) {
        if (!HEX_RE.test(val)) push('error', `${lbl} ${attr}="${val}" is not a 6- or 8-digit hex.`, tag)
      } else if (CSS_COLOR_KEYWORDS.has(val.toLowerCase()) || val.toLowerCase().startsWith('rgb')) {
        push('error', `${lbl} ${attr}="${val}" uses a CSS color keyword/rgb(). Use hex (with alpha byte) or a $token.`, tag)
      }
    }
  }

  // 8. Undefined token references.
  const referenced = new Set<string>()
  for (const el of nodes) for (const { name, value } of attrs(el)) {
    if (NON_REF_ATTRS.has(name)) continue
    for (const m of value.match(TOKEN_REF_RE) ?? []) referenced.add(m.slice(1))
  }
  for (const name of [...referenced].filter((n) => !tokenNames.has(n)).sort()) {
    push('error', `$${name} is referenced but not declared in <tokens>.`, 'tokens')
  }

  // 9. No <assets> block.
  if ((Array.from(root.children) as El[]).some((c) => c.tagName === 'assets') || nodes.some((n) => n.tagName === 'assets')) {
    push('error', 'Found an <assets> block — not valid in v0.2. Reference images inline with <img src="assets/..."> or a URL.', 'assets')
  }

  // 10. No <svg> tags.
  if (nodes.some((n) => n.tagName === 'svg')) push('error', 'Found a <svg> tag — pack SVGs as assets and reference them with <img src="assets/...">.', 'svg')

  // 11. Content "AI tells".
  const seen = new Set<string>()
  for (const el of nodes) {
    const texts: string[] = []
    if ((el.tagName === 'text' || el.tagName === 'segment') && el.hasAttribute('value')) texts.push(el.getAttribute('value'))
    if (el.tagName === 'segment' && el.textContent) texts.push(el.textContent)
    for (const s of texts) for (const [pat, msg] of CONTENT_TELLS) {
      if (pat.test(s) && !seen.has(msg)) { seen.add(msg); push('warn', msg, 'content') }
    }
  }

  const errors = issues.filter((i) => i.level === 'error')
  return { issues, errors, ok: errors.length === 0, ran: true }
}
