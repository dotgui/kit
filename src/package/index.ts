/**
 * @dotgui/kit/package — the .gui container, in memory.
 *
 * A .gui is a ZIP containing:
 *   design.guix    — the markup (XML, <gui> root)
 *   assets/        — images, SVGs (keyed by package path, e.g. "assets/hero.webp")
 *   preview.webp   — rendered thumbnail
 *
 * From spec 0.3 a package may hold several documents — any `*.guix` at the
 * root — plus an optional `library.guix` whose declarations every document
 * shares (RFC-0042). `xml` is then the first document in filename order, so a
 * consumer that only knows one screen keeps working; `documents` holds them
 * all, and `pack` writes every one back.
 *
 * A package may also be a directory named *.gui holding the same entries
 * (RFC-0054). `fromEntries` and `toEntries` are the one step both forms pass
 * through: a caller that walks a directory hands its files to `fromEntries`,
 * and `unpack` hands it a ZIP's.
 *
 * Everything here is pure and byte-based — unzip/zip happen in memory, nothing
 * touches disk. Read the markup, list/add/remove assets, swap the preview, all
 * without extracting a shadow folder. File-system glue (paths, temp, cache) is
 * the caller's concern, not the kit's.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { validate, type ValidationError, type ValidationResult } from '../schema/validate'
import { LIBRARY_DIRECTORY, LIBRARY_NAME, checkComponentIdsAcross, flattenWith, joinLibraryFiles, libraryErrors, validateInPackage } from './library'

export { LIBRARY_DIRECTORY, LIBRARY_NAME } from './library'

const GUIX_NAME = 'design.guix'
const PREVIEW_NAME = 'preview.webp'
const ASSET_PREFIX = 'assets/'

export interface GuiPackage {
  /** The .guix markup — the primary document (the first, in filename order). */
  xml: string
  /**
   * Every document at the package root by filename, `library.guix` excluded.
   * Absent for a raw .guix or a package built by hand; `pack` then writes
   * `xml` as `design.guix`.
   */
  documents?: Record<string, string>
  /** The filename `xml` was read from, when `documents` is present. */
  primary?: string
  /** `library.guix`, the package's shared declarations, if present. */
  library?: string
  /**
   * The library split across `library/` (RFC-0055): library files by package
   * path, e.g. "library/components/button.guix". Never beside `library`.
   */
  libraryFiles?: Record<string, string>
  /**
   * Read from bare markup rather than a ZIP: a standalone document (RFC-0043),
   * whose asset references must be absolute URLs. Packing it promotes it to a
   * package, after which local assets are allowed.
   */
  standalone?: boolean
  /** Asset entries keyed by package path, e.g. "assets/hero.webp". */
  assets: Record<string, Uint8Array>
  /** preview.webp bytes, if present. */
  preview?: Uint8Array
  /**
   * Entries read but not part of the package — dotfiles, stray files, a
   * `.guix` below the root — in path order (RFC-0054). Never written back.
   */
  ignored?: string[]
}

export interface GuiInfo {
  /** <gui name="…">, if set. */
  name?: string
  /** <gui platform="…">, if set. */
  platform?: string
  /** <gui source="…">: the tool that exported the file, if set (RFC-0036). */
  source?: string
  /** Document filenames in order; one entry for a single-document package. */
  documents: string[]
  /** Whether the package carries a library — library.guix or library/. */
  hasLibrary: boolean
  /** The library files under library/, in path order (RFC-0055). */
  libraryFiles: string[]
  /** Documents marked `<gui template>`: starting points to copy (RFC-0057). */
  templates: string[]
  /** Asset package paths. */
  assets: string[]
  /** Whether a preview.webp is present. */
  hasPreview: boolean
  /** Entries that were read but are not part of the package (RFC-0054). */
  ignored: string[]
}

/**
 * Thrown when a package's entries cannot be one package (RFC-0054): a path
 * that leaves the package, or two paths that differ only in case or Unicode
 * normalization. `paths` names the entries at fault.
 */
export class PackageEntryError extends Error {
  constructor(public paths: string[], message: string) {
    super(message)
    this.name = 'PackageEntryError'
  }
}

/** True if the bytes are a ZIP (PK header) rather than a raw .guix. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

/** Normalize an asset name to its package path under assets/. */
function assetKey(name: string): string {
  return name.startsWith(ASSET_PREFIX) ? name : ASSET_PREFIX + name
}

// ─── container ────────────────────────────────────────────────────────────────

/** Read a .gui (ZIP) or a raw .guix into the in-memory package model. */
export function unpack(bytes: Uint8Array): GuiPackage {
  // Raw .guix (not a zip) — the whole file is the markup, no assets/preview.
  if (!isZip(bytes)) {
    return { xml: strFromU8(bytes), assets: {}, standalone: true }
  }
  return fromEntries(unzipSync(bytes))
}

/** What an entry is to the package, or null when it is not part of it. */
function entryKind(path: string): 'document' | 'library' | 'library-file' | 'preview' | 'asset' | null {
  // A dotfile is a tool's state, at any depth — never part of the package.
  if (path.split('/').some((segment) => segment.startsWith('.'))) return null
  // Under library/, only .guix files are part of the package (RFC-0055).
  if (path.startsWith(LIBRARY_DIRECTORY)) return path.endsWith('.guix') ? 'library-file' : null
  if (!path.includes('/')) {
    if (path === LIBRARY_NAME) return 'library'
    if (path.endsWith('.guix')) return 'document'
    if (path === PREVIEW_NAME) return 'preview'
    return null
  }
  return path.startsWith(ASSET_PREFIX) ? 'asset' : null
}

/**
 * Build a package from its entries: relative paths to bytes, from a ZIP or a
 * walked `.gui` directory (RFC-0054). Entries that are not part of the
 * package are ignored and listed in `ignored`. A path that leaves the package,
 * or two paths that differ only in case or Unicode normalization, throw
 * `PackageEntryError`. Symbolic links are the caller's to refuse, since only
 * the caller touches the file system.
 */
export function fromEntries(input: Record<string, Uint8Array>): GuiPackage {
  const entries: Record<string, Uint8Array> = {}
  const seen = new Map<string, string>()
  for (const [raw, data] of Object.entries(input)) {
    if (raw.endsWith('/')) continue // a ZIP's directory entry
    const path = raw.normalize('NFC')
    if (/^([/\\]|[A-Za-z]:)/.test(path) || path.split(/[/\\]/).includes('..')) {
      throw new PackageEntryError([raw], `entry "${raw}" resolves outside the package`)
    }
    const key = path.toLowerCase()
    const other = seen.get(key)
    if (other !== undefined) {
      throw new PackageEntryError([other, raw], `entries "${other}" and "${raw}" differ only in case or Unicode normalization, which a file system cannot hold apart`)
    }
    seen.set(key, raw)
    entries[path] = data
  }

  const paths = Object.keys(entries).sort()
  const names = paths.filter((p) => entryKind(p) === 'document')
  if (names.length === 0) throw new Error('no .guix document inside the .gui package')

  const documents: Record<string, string> = {}
  for (const name of names) documents[name] = strFromU8(entries[name])

  const pkg: GuiPackage = { xml: documents[names[0]], documents, primary: names[0], assets: {} }
  const ignored: string[] = []
  for (const path of paths) {
    const kind = entryKind(path)
    if (kind === 'library') pkg.library = strFromU8(entries[path])
    else if (kind === 'library-file') (pkg.libraryFiles ??= {})[path] = strFromU8(entries[path])
    else if (kind === 'preview') pkg.preview = entries[path]
    else if (kind === 'asset') pkg.assets[path] = entries[path]
    else if (kind === null) ignored.push(path)
  }
  if (ignored.length) pkg.ignored = ignored
  if (pkg.library !== undefined && pkg.libraryFiles) {
    throw new PackageEntryError([LIBRARY_NAME, LIBRARY_DIRECTORY], `the package has both ${LIBRARY_NAME} and ${LIBRARY_DIRECTORY}; a library is stored one way or the other, never both`)
  }
  return pkg
}

/**
 * The package's entries, in lexical path order, with names in NFC — what a
 * ZIP holds and what a `.gui` directory holds, path for path (RFC-0054).
 * Ignored entries are never written.
 */
export function toEntries(pkg: GuiPackage): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {}
  if (pkg.documents && pkg.primary) {
    for (const [name, xml] of Object.entries(pkg.documents)) entries[name] = strToU8(xml)
    // `xml` is the live copy of the primary document; an edit through
    // setMarkup lands there.
    entries[pkg.primary] = strToU8(pkg.xml)
  } else {
    entries[GUIX_NAME] = strToU8(pkg.xml)
  }
  if (pkg.library !== undefined) entries[LIBRARY_NAME] = strToU8(pkg.library)
  for (const [path, xml] of Object.entries(pkg.libraryFiles || {})) entries[path] = strToU8(xml)
  if (pkg.preview) entries[PREVIEW_NAME] = pkg.preview
  for (const [name, data] of Object.entries(pkg.assets)) entries[assetKey(name)] = data
  const ordered: Record<string, Uint8Array> = {}
  for (const name of Object.keys(entries).sort()) ordered[name.normalize('NFC')] = entries[name]
  return ordered
}

/** Zip the package model back into .gui bytes, entries in lexical order. */
export function pack(pkg: GuiPackage): Uint8Array {
  return zipSync(toEntries(pkg))
}

// ─── read ───────────────────────────────────────────────────────────────────

export function getMarkup(pkg: GuiPackage): string {
  return pkg.xml
}

export function getAsset(pkg: GuiPackage, name: string): Uint8Array | undefined {
  return pkg.assets[name] ?? pkg.assets[assetKey(name)]
}

export function listAssets(pkg: GuiPackage): string[] {
  return Object.keys(pkg.assets)
}

export function getPreview(pkg: GuiPackage): Uint8Array | undefined {
  return pkg.preview
}

/** Document filenames, in order. A package with no `documents` has one. */
export function listDocuments(pkg: GuiPackage): string[] {
  if (!pkg.documents || !pkg.primary) return [GUIX_NAME]
  return Object.keys(pkg.documents).sort()
}

/** One document's markup by filename, as written (library not inlined). */
export function getDocument(pkg: GuiPackage, name: string): string | undefined {
  if (!pkg.documents || !pkg.primary) return name === GUIX_NAME ? pkg.xml : undefined
  if (name === pkg.primary) return pkg.xml
  return pkg.documents[name]
}

/**
 * The package library as one markup string: library.guix, or the library
 * files under library/ joined into one (RFC-0055).
 */
export function getLibrary(pkg: GuiPackage): string | undefined {
  return pkg.library ?? (pkg.libraryFiles ? joinLibraryFiles(pkg.libraryFiles) : undefined)
}

/** Whether a document's root says `template` (RFC-0057). */
function isTemplate(xml: string | undefined): boolean {
  const open = xml ? xml.match(/<gui\b[^>]*>/i) : null
  return !!open && /\stemplate(\s|=|\/?>|$)/i.test(open[0])
}

/** `template` on the library: its declarations are no starting point (RFC-0057). */
function templateErrors(pkg: GuiPackage): ValidationError[] {
  const files: Record<string, string> = { ...pkg.libraryFiles }
  if (pkg.library !== undefined) files[LIBRARY_NAME] = pkg.library
  return Object.keys(files).sort().filter((name) => isTemplate(files[name])).map((name) => ({
    code: 'TEMPLATE_IN_LIBRARY',
    message: `${name} is marked template, but the library is declarations, not a starting point to copy`,
    path: 'package',
  }))
}

/** The library files under library/, in path order (RFC-0055). */
export function listLibraryFiles(pkg: GuiPackage): string[] {
  return Object.keys(pkg.libraryFiles || {}).sort()
}

/** True when the package holds several documents or a library. */
export function isMultiDocument(pkg: GuiPackage): boolean {
  return listDocuments(pkg).length > 1 || getLibrary(pkg) !== undefined
}

/**
 * One document with the library's declarations inlined — an ordinary
 * single-document markup string that renders and validates on its own, the
 * same as the document does inside its package. Without a library, the
 * document unchanged. Defaults to the primary document.
 */
export function flatten(pkg: GuiPackage, name?: string): string {
  const xml = name === undefined ? pkg.xml : getDocument(pkg, name)
  if (xml === undefined) throw new Error(`no document named ${name} in the package`)
  const library = getLibrary(pkg)
  return library === undefined ? xml : flattenWith(library, xml)
}

/**
 * Validate one document as it stands in its package: the multi-document rules
 * (every document declares 0.3 or higher; a library name is never redeclared)
 * and the ordinary checks over the document with the library inlined, so a
 * name that resolves nowhere is an error. Defaults to the primary document.
 */
export function validateDocument(pkg: GuiPackage, name?: string): ValidationResult {
  // A library file, by its path, validates against the rest of the library
  // (RFC-0055): its names resolve across every other library file.
  const libraryFile = name !== undefined && pkg.libraryFiles ? pkg.libraryFiles[name] : undefined
  const xml = libraryFile ?? (name === undefined ? pkg.xml : getDocument(pkg, name))
  if (xml === undefined) throw new Error(`no document named ${name} in the package`)
  let library = getLibrary(pkg)
  if (libraryFile !== undefined) {
    const rest = { ...pkg.libraryFiles }
    delete rest[name!]
    library = joinLibraryFiles(rest)
  }
  const result = libraryFile !== undefined
    ? (() => {
        const r = validateInPackage(xml, library, true, pkg.standalone)
        // A library file may be declarations only.
        const errors = r.errors.filter((e) => e.code !== 'NO_ROOT_NODE')
        return { ...r, valid: errors.length === 0, errors }
      })()
    : validateInPackage(xml, library, isMultiDocument(pkg), pkg.standalone)
  const self = name ?? pkg.primary ?? GUIX_NAME
  const others = listDocuments(pkg)
    .filter((d) => d !== self)
    .map((d) => getDocument(pkg, d))
    .filter((x): x is string => x !== undefined)
  const across = checkComponentIdsAcross(xml, others)
  const documents: Record<string, string> = {}
  for (const d of listDocuments(pkg)) { const x = getDocument(pkg, d); if (x !== undefined) documents[d] = x }
  const split = pkg.libraryFiles ? libraryErrors(pkg.libraryFiles, documents) : []
  const errors = [...result.errors, ...across.errors, ...split, ...templateErrors(pkg)]
  // Ignoring is not hiding (RFC-0054): every ignored entry is named.
  const ignored = (pkg.ignored || []).map((path) => ({
    code: 'IGNORED_ENTRY',
    message: `"${path}" is not part of the package and is ignored`,
    path: 'package',
  }))
  return { ...result, valid: errors.length === 0, errors, warnings: [...result.warnings, ...across.warnings, ...ignored] }
}

export function info(pkg: GuiPackage): GuiInfo {
  const open = pkg.xml.match(/<gui\b[^>]*>/i)?.[0] ?? ''
  const attr = (k: string) => open.match(new RegExp(`${k}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]
  return {
    name: attr('name'),
    platform: attr('platform'),
    source: attr('source'),
    documents: listDocuments(pkg),
    hasLibrary: getLibrary(pkg) !== undefined,
    libraryFiles: listLibraryFiles(pkg),
    templates: listDocuments(pkg).filter((d) => isTemplate(getDocument(pkg, d))),
    assets: listAssets(pkg),
    hasPreview: pkg.preview !== undefined,
    ignored: pkg.ignored || [],
  }
}

// ─── edit (pure — return an updated package) ──────────────────────────────────

/** Thrown by `setMarkup` when the new markup fails validation. */
export class InvalidMarkupError extends Error {
  constructor(public errors: ValidationError[]) {
    super('invalid .gui markup:\n' + errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'))
    this.name = 'InvalidMarkupError'
  }
}

/**
 * Replace the markup. Validated first — invalid markup never enters the package
 * model, so a broken edit throws here instead of silently reaching `pack`/save.
 */
export function setMarkup(pkg: GuiPackage, xml: string): GuiPackage {
  // In a package with a library, the primary resolves names against it too.
  const result = validateInPackage(xml, getLibrary(pkg), isMultiDocument(pkg), pkg.standalone)
  if (!result.valid) throw new InvalidMarkupError(result.errors)
  return { ...pkg, xml }
}

/**
 * Replace one document by filename (validated in its package first). Adds the
 * document when the name is new. The primary document is `setMarkup`'s.
 */
export function setDocument(pkg: GuiPackage, name: string, xml: string): GuiPackage {
  if (name === LIBRARY_NAME) throw new Error(`${LIBRARY_NAME} is the library, not a document; use setLibrary`)
  // A second screen is the other promotion trigger: it needs a package.
  const base: GuiPackage = pkg.documents && pkg.primary
    ? pkg
    : { ...pkg, standalone: undefined, documents: { [GUIX_NAME]: pkg.xml }, primary: GUIX_NAME }
  const next: GuiPackage = { ...base, documents: { ...base.documents, [name]: xml } }
  if (name === base.primary) next.xml = xml
  const result = validateInPackage(xml, getLibrary(next), isMultiDocument(next))
  if (!result.valid) throw new InvalidMarkupError(result.errors)
  return next
}

/** Replace (or add) library.guix. Validated on its own: a library depends on nothing. */
export function setLibrary(pkg: GuiPackage, xml: string): GuiPackage {
  if (pkg.libraryFiles) throw new Error(`the library is split across ${LIBRARY_DIRECTORY}; use setLibraryFile`)
  // A library may be declarations only: no layout root is not an error here.
  const errors = validate(xml).errors.filter((e) => e.code !== 'NO_ROOT_NODE')
  if (errors.length > 0) throw new InvalidMarkupError(errors)
  return { ...pkg, library: xml }
}

/**
 * Replace (or add) one library file under library/ (RFC-0055), validated
 * against the rest of the library. A package with library.guix cannot take
 * one: a library is stored one way or the other.
 */
export function setLibraryFile(pkg: GuiPackage, path: string, xml: string): GuiPackage {
  if (!path.startsWith(LIBRARY_DIRECTORY) || !path.endsWith('.guix')) throw new Error(`a library file is a .guix under ${LIBRARY_DIRECTORY}, got ${path}`)
  if (pkg.library !== undefined) throw new Error(`the package has ${LIBRARY_NAME}; a library is stored one way or the other, never both`)
  const next: GuiPackage = { ...pkg, libraryFiles: { ...pkg.libraryFiles, [path]: xml } }
  const result = validateDocument(next, path)
  if (!result.valid) throw new InvalidMarkupError(result.errors)
  return next
}

export function addAsset(pkg: GuiPackage, name: string, bytes: Uint8Array): GuiPackage {
  // A local asset is one of the two triggers that promote a standalone
  // document to a package (RFC-0043).
  return { ...pkg, standalone: undefined, assets: { ...pkg.assets, [assetKey(name)]: bytes } }
}

export function removeAsset(pkg: GuiPackage, name: string): GuiPackage {
  const assets = { ...pkg.assets }
  delete assets[name]
  delete assets[assetKey(name)]
  return { ...pkg, assets }
}

export function setPreview(pkg: GuiPackage, bytes: Uint8Array): GuiPackage {
  return { ...pkg, preview: bytes }
}
