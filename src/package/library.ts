/**
 * Multi-document packages and the shared library (RFC-0042, spec 0.3.2).
 *
 * A document is a library part — declarations above its layout root — followed
 * by a screen part. `library.guix` shares its library part with every document
 * in the package; its own screen part, if any, is local to it.
 *
 * Resolution is implicit: a name a document does not declare is the
 * library's. Redeclaring a library name is an error, not an override, which is
 * what makes `flatten` a plain concatenation: there is never a collision to
 * merge.
 */
import { parseTree, validate, type El, type ValidationError, type ValidationResult } from '../schema/validate'

export const LIBRARY_NAME = 'library.guix'

/** Tags that can be a document's layout root. Everything above one is declaration. */
const LAYOUT_TAGS = new Set(['frame', 'stack', 'row', 'col', 'grid', 'group'])

/** The spec version multi-document structure arrived in. */
const MULTI_DOCUMENT_VERSION: [number, number] = [0, 3]

interface Span {
  tag: string
  /** Offsets of the whole element, `<tag …>` through its close. */
  start: number
  end: number
  /** Offsets of its content; equal for a self-closing element. */
  innerStart: number
  innerEnd: number
  selfClosing: boolean
}

interface Outline {
  /** Offset just after `<gui …>`. */
  bodyStart: number
  /** Top-level elements above the layout root. */
  declarations: Span[]
}

/** End offset of the tag that opens at `from` (the `>`), honouring quotes. */
function tagEnd(xml: string, from: number): number {
  let quote = ''
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    }
  }
  throw new SyntaxError(`unterminated tag at position ${from}`)
}

/** Skip a comment, processing instruction or CDATA starting at `i`; -1 if none. */
function skipMarkup(xml: string, i: number): number {
  if (xml.startsWith('<!--', i)) return xml.indexOf('-->', i) + 3
  if (xml.startsWith('<![CDATA[', i)) return xml.indexOf(']]>', i) + 3
  if (xml.startsWith('<?', i) || xml.startsWith('<!', i)) return xml.indexOf('>', i) + 1
  return -1
}

function tagName(xml: string, i: number): string {
  const m = /^<\/?\s*([^\s/>]+)/.exec(xml.slice(i, i + 200))
  return m ? m[1] : ''
}

/** Find the `<gui>` body and the declaration blocks above its layout root. */
function outline(xml: string): Outline {
  let i = 0
  let bodyStart = -1
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    const skipped = skipMarkup(xml, lt)
    if (skipped > 0) { i = skipped; continue }
    if (tagName(xml, lt) !== 'gui') throw new SyntaxError('expected <gui> as the document root')
    const end = tagEnd(xml, lt)
    if (xml[end - 1] === '/') return { bodyStart: end + 1, declarations: [] }
    bodyStart = end + 1
    break
  }
  if (bodyStart === -1) throw new SyntaxError('expected <gui> as the document root')

  const declarations: Span[] = []
  let depth = 0
  let open: { tag: string; start: number; innerStart: number } | null = null
  i = bodyStart
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    const skipped = skipMarkup(xml, lt)
    if (skipped > 0) { i = skipped; continue }
    const end = tagEnd(xml, lt)
    const closing = xml[lt + 1] === '/'
    const selfClosing = !closing && xml[end - 1] === '/'
    const tag = tagName(xml, lt)

    if (closing) {
      if (depth === 0) break // </gui>
      depth--
      if (depth === 0 && open) {
        declarations.push({ tag: open.tag, start: open.start, end: end + 1, innerStart: open.innerStart, innerEnd: lt, selfClosing: false })
        open = null
      }
    } else if (depth === 0) {
      if (LAYOUT_TAGS.has(tag)) break
      if (selfClosing) {
        declarations.push({ tag, start: lt, end: end + 1, innerStart: end + 1, innerEnd: end + 1, selfClosing: true })
      } else {
        open = { tag, start: lt, innerStart: end + 1 }
        depth = 1
      }
    } else if (!selfClosing) {
      depth++
    }
    i = end + 1
  }
  return { bodyStart, declarations }
}

/**
 * The document with the library's declarations inlined: an ordinary
 * single-document file that renders and validates exactly as the document does
 * inside its package. Each library block is merged into the document's block
 * of the same tag, or added when the document has none.
 *
 * The whole library part is inlined, not only the names the document uses.
 */
export function flattenWith(libraryXml: string, documentXml: string): string {
  const library = outline(libraryXml)
  const doc = outline(documentXml)
  const edits: { at: number; remove: number; text: string }[] = []
  const prepend: string[] = []

  for (const block of library.declarations) {
    const inner = libraryXml.slice(block.innerStart, block.innerEnd)
    const target = doc.declarations.find((d) => d.tag === block.tag)
    if (!target) {
      prepend.push(libraryXml.slice(block.start, block.end))
    } else if (target.selfClosing) {
      edits.push({ at: target.start, remove: target.end - target.start, text: libraryXml.slice(block.start, block.end) })
    } else if (!block.selfClosing) {
      edits.push({ at: target.innerStart, remove: 0, text: inner })
    }
  }
  if (prepend.length) edits.push({ at: doc.bodyStart, remove: 0, text: '\n' + prepend.join('\n') })

  let out = documentXml
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.remove)
  }
  return out
}

/** Every name a document's declarations introduce, as `kind name` pairs. */
function declaredNames(xml: string): { kind: string; name: string }[] {
  const root = parseTree(xml)
  const names: { kind: string; name: string }[] = []
  for (const block of root.children) {
    if (LAYOUT_TAGS.has(block.tag)) break
    for (const child of block.children) {
      if (block.tag === 'tokens' && child.attrs.name) names.push({ kind: 'token', name: '$' + child.attrs.name })
      else if (block.tag === 'fonts' && child.attrs.family) names.push({ kind: 'font', name: child.attrs.family })
      else if (block.tag === 'styles' && child.attrs.name) names.push({ kind: child.tag.replace('-', ' '), name: child.attrs.name })
      else if (block.tag === 'components' && child.attrs.id) names.push({ kind: 'component', name: child.attrs.id })
    }
  }
  return names
}

function versionOf(root: El): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec((root.attrs.version || '').trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}

function below(v: [number, number], floor: [number, number]): boolean {
  return v[0] < floor[0] || (v[0] === floor[0] && v[1] < floor[1])
}

/**
 * Validate one document as it stands in its package: the RFC-0042 package
 * rules, then the ordinary validator over the document with the library
 * inlined, so a name that resolves in neither place is reported.
 *
 * `inPackage` is true when the package has a library or several documents;
 * `standalone` when the markup was served on its own (RFC-0043).
 */
export function validateInPackage(
  documentXml: string,
  libraryXml: string | undefined,
  inPackage: boolean,
  standalone = false,
): ValidationResult {
  const errors: ValidationError[] = []

  let root: El
  try {
    root = parseTree(documentXml)
  } catch (e) {
    return { valid: false, version: null, errors: [{ code: 'PARSE_ERROR', message: String(e), path: 'gui' }], warnings: [] }
  }

  const version = versionOf(root)
  if (inPackage && (!version || below(version, MULTI_DOCUMENT_VERSION))) {
    errors.push({
      code: 'VERSION_BELOW_PACKAGE',
      message: `the document declares version ${root.attrs.version ?? '(none)'}, but a document in a package with a library or several documents must declare 0.3 or higher`,
      path: 'gui',
    })
  }

  let markup = documentXml
  if (libraryXml !== undefined) {
    try {
      const libraryNames = new Set(declaredNames(libraryXml).map((n) => `${n.kind} ${n.name}`))
      for (const { kind, name } of declaredNames(documentXml)) {
        if (libraryNames.has(`${kind} ${name}`)) {
          errors.push({
            code: 'LIBRARY_REDECLARED',
            message: `${kind} '${name}' is already declared by ${LIBRARY_NAME}; change it there instead of redeclaring it`,
            path: 'gui',
          })
        }
      }
      markup = flattenWith(libraryXml, documentXml)
    } catch (e) {
      errors.push({ code: 'LIBRARY_INVALID', message: `${LIBRARY_NAME} is invalid: ${e}`, path: 'gui' })
    }
  }

  const result = validate(markup, { standalone })
  const all = [...errors, ...result.errors]
  return { ...result, valid: all.length === 0, errors: all }
}
