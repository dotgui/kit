/**
 * @dotgui/kit/package — the .gui container, in memory.
 *
 * A .gui is a ZIP containing:
 *   design.guix    — the markup (XML, <gui> root)
 *   assets/        — images, SVGs (keyed by package path, e.g. "assets/hero.webp")
 *   preview.webp   — rendered thumbnail
 *
 * Everything here is pure and byte-based — unzip/zip happen in memory, nothing
 * touches disk. Read the markup, list/add/remove assets, swap the preview, all
 * without extracting a shadow folder. File-system glue (paths, temp, cache) is
 * the caller's concern, not the kit's.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { validate, type ValidationError } from '../schema/validate'

const GUIX_NAME = 'design.guix'
const PREVIEW_NAME = 'preview.webp'
const ASSET_PREFIX = 'assets/'

export interface GuiPackage {
  /** The .guix markup. */
  xml: string
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
  const guixKey = Object.keys(entries).find((k) => k.endsWith('.guix'))
  if (!guixKey) throw new Error('no .guix entry inside the .gui package')

  const pkg: GuiPackage = { xml: strFromU8(entries[guixKey]), assets: {} }
  for (const [name, data] of Object.entries(entries)) {
    if (name === guixKey) continue
    if (name === PREVIEW_NAME) { pkg.preview = data; continue }
    if (name.startsWith(ASSET_PREFIX)) pkg.assets[name] = data
  }
  return pkg
}

/** Zip the package model back into .gui bytes. */
export function pack(pkg: GuiPackage): Uint8Array {
  const entries: Record<string, Uint8Array> = { [GUIX_NAME]: strToU8(pkg.xml) }
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

export function info(pkg: GuiPackage): GuiInfo {
  const open = pkg.xml.match(/<gui\b[^>]*>/i)?.[0] ?? ''
  const attr = (k: string) => open.match(new RegExp(`${k}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]
  return {
    name: attr('name'),
    platform: attr('platform'),
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
  const result = validate(xml)
  if (!result.valid) throw new InvalidMarkupError(result.errors)
  return { ...pkg, xml }
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
