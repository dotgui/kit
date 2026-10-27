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
 * Everything here is pure and byte-based — unzip/zip happen in memory, nothing
 * touches disk. Read the markup, list/add/remove assets, swap the preview, all
 * without extracting a shadow folder. File-system glue (paths, temp, cache) is
 * the caller's concern, not the kit's.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { validate, type ValidationError, type ValidationResult } from '../schema/validate'
import { LIBRARY_NAME, flattenWith, validateInPackage } from './library'

export { LIBRARY_NAME } from './library'

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
  /** Asset entries keyed by package path, e.g. "assets/hero.webp". */
  assets: Record<string, Uint8Array>
  /** preview.webp bytes, if present. */
  preview?: Uint8Array
}

export interface GuiInfo {
  /** <gui name="…">, if set. */
  name?: string
  /** <gui platform="…">, if set. */
  platform?: string
  /** Document filenames in order; one entry for a single-document package. */
  documents: string[]
  /** Whether the package carries a library.guix. */
  hasLibrary: boolean
  /** Asset package paths. */
  assets: string[]
  /** Whether a preview.webp is present. */
  hasPreview: boolean
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
    return { xml: strFromU8(bytes), assets: {} }
  }

  const entries = unzipSync(bytes)
  // Documents sit at the root; a .guix inside a directory is not one.
  const names = Object.keys(entries)
    .filter((k) => k.endsWith('.guix') && !k.includes('/') && k !== LIBRARY_NAME)
    .sort()
  if (names.length === 0) throw new Error('no .guix document inside the .gui package')

  const documents: Record<string, string> = {}
  for (const name of names) documents[name] = strFromU8(entries[name])

  const pkg: GuiPackage = { xml: documents[names[0]], documents, primary: names[0], assets: {} }
  if (entries[LIBRARY_NAME]) pkg.library = strFromU8(entries[LIBRARY_NAME])
  for (const [name, data] of Object.entries(entries)) {
    if (name === PREVIEW_NAME) { pkg.preview = data; continue }
    if (name.startsWith(ASSET_PREFIX)) pkg.assets[name] = data
  }
  return pkg
}

/** Zip the package model back into .gui bytes. */
export function pack(pkg: GuiPackage): Uint8Array {
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
  if (pkg.preview) entries[PREVIEW_NAME] = pkg.preview
  for (const [name, data] of Object.entries(pkg.assets)) entries[assetKey(name)] = data
  return zipSync(entries)
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

export function getLibrary(pkg: GuiPackage): string | undefined {
  return pkg.library
}

/** True when the package holds several documents or a library. */
export function isMultiDocument(pkg: GuiPackage): boolean {
  return listDocuments(pkg).length > 1 || pkg.library !== undefined
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
  return pkg.library === undefined ? xml : flattenWith(pkg.library, xml)
}

/**
 * Validate one document as it stands in its package: the multi-document rules
 * (every document declares 0.3 or higher; a library name is never redeclared)
 * and the ordinary checks over the document with the library inlined, so a
 * name that resolves nowhere is an error. Defaults to the primary document.
 */
export function validateDocument(pkg: GuiPackage, name?: string): ValidationResult {
  const xml = name === undefined ? pkg.xml : getDocument(pkg, name)
  if (xml === undefined) throw new Error(`no document named ${name} in the package`)
  return validateInPackage(xml, pkg.library, isMultiDocument(pkg))
}

export function info(pkg: GuiPackage): GuiInfo {
  const open = pkg.xml.match(/<gui\b[^>]*>/i)?.[0] ?? ''
  const attr = (k: string) => open.match(new RegExp(`${k}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]
  return {
    name: attr('name'),
    platform: attr('platform'),
    documents: listDocuments(pkg),
    hasLibrary: pkg.library !== undefined,
    assets: listAssets(pkg),
    hasPreview: pkg.preview !== undefined,
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
  const result = validateInPackage(xml, pkg.library, isMultiDocument(pkg))
  if (!result.valid) throw new InvalidMarkupError(result.errors)
  return { ...pkg, xml }
}

/**
 * Replace one document by filename (validated in its package first). Adds the
 * document when the name is new. The primary document is `setMarkup`'s.
 */
export function setDocument(pkg: GuiPackage, name: string, xml: string): GuiPackage {
  if (name === LIBRARY_NAME) throw new Error(`${LIBRARY_NAME} is the library, not a document; use setLibrary`)
  const base = pkg.documents && pkg.primary ? pkg : { ...pkg, documents: { [GUIX_NAME]: pkg.xml }, primary: GUIX_NAME }
  const next: GuiPackage = { ...base, documents: { ...base.documents, [name]: xml } }
  if (name === base.primary) next.xml = xml
  const result = validateInPackage(xml, next.library, isMultiDocument(next))
  if (!result.valid) throw new InvalidMarkupError(result.errors)
  return next
}

/** Replace (or add) library.guix. Validated on its own: a library depends on nothing. */
export function setLibrary(pkg: GuiPackage, xml: string): GuiPackage {
  // A library may be declarations only: no layout root is not an error here.
  const errors = validate(xml).errors.filter((e) => e.code !== 'NO_ROOT_NODE')
  if (errors.length > 0) throw new InvalidMarkupError(errors)
  return { ...pkg, library: xml }
}

export function addAsset(pkg: GuiPackage, name: string, bytes: Uint8Array): GuiPackage {
  return { ...pkg, assets: { ...pkg.assets, [assetKey(name)]: bytes } }
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
