/**
 * @dotgui/kit/rasterize — turn a `.gui` into an image with the dotgui renderer.
 *
 *   rasterize(pkg, { format })   general primitive → image bytes (or a reason)
 *   renderPreview(pkg)           the packing helper → preview.webp, with a
 *                                placeholder + console warning when it fails
 *
 * Draws with `@dotgui/render` — the Rust renderer compiled to WebAssembly — so
 * no browser is involved: installed fonts are read from disk, Google fonts and
 * remote images are fetched, and the result is the same pixels on every
 * machine (core GOVERNANCE, *One renderer*).
 */
import { pack, type GuiPackage } from '../package'

/**
 * Accepted for compatibility with the headless-browser rasterizer this
 * replaced. Ignored: there is one renderer now.
 * @deprecated
 */
export type Engine = 'puppeteer-core' | 'puppeteer'
export type ImageFormat = 'webp' | 'png' | 'jpeg'

/** A minimal valid 1×1 WebP, embedded so the placeholder needs no encoder. */
const PLACEHOLDER_WEBP = new Uint8Array(
  Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'),
)

/**
 * Always true: rasterizing no longer needs a browser.
 * @deprecated
 */
export async function hasBrowser(_engine?: Engine): Promise<boolean> {
  return true
}

/**
 * Why a rasterize failed. `no-renderer`: `@dotgui/render` could not be loaded.
 * `render-failed`: the document did not draw. `no-browser` is kept for
 * compatibility and is never returned.
 */
export type RasterizeReason = 'no-browser' | 'no-renderer' | 'render-failed'

export interface RasterizeOptions {
  format?: ImageFormat   // default 'webp'
  scale?: number         // device pixels per document pixel, default 2
  /** @deprecated ignored */
  engine?: Engine
  /** Active mode per axis, e.g. `{ theme: 'dark' }` (RFC-0037). */
  mode?: Record<string, string>
  /** Fetch Google fonts and remote images. Default true. */
  network?: boolean
}

export interface RasterizeResult {
  /** Image bytes, or undefined when `reason` is set. */
  image?: Uint8Array
  reason?: RasterizeReason
  /** Why, when `reason` is `render-failed`. */
  error?: string
}

type Screenshot = typeof import('@dotgui/render/node').screenshot
let loaded: Promise<Screenshot | null> | undefined
/** The renderer, loaded once; null when it cannot be. */
function renderer(): Promise<Screenshot | null> {
  loaded ??= import('@dotgui/render/node').then((m) => m.screenshot).catch(() => null)
  return loaded
}

/**
 * Rasterize a `.gui` package to image bytes — its primary document, as a
 * package's preview shows it. Fails soft — returns a `reason` (never throws,
 * never a placeholder). Use `renderPreview` for the packing thumbnail with
 * placeholder behaviour.
 */
export async function rasterize(pkg: GuiPackage, opts: RasterizeOptions = {}): Promise<RasterizeResult> {
  const screenshot = await renderer()
  if (!screenshot) return { reason: 'no-renderer' }
  // A standalone document draws as itself; a package draws its primary
  // document against its library and assets.
  const input = pkg.standalone ? pkg.xml : pack(pkg)
  try {
    const { image } = await screenshot(input, {
      format: opts.format ?? 'webp',
      scale: opts.scale ?? 2,
      page: pkg.standalone ? undefined : pkg.primary,
      mode: opts.mode,
      network: opts.network,
    })
    return { image }
  } catch (error) {
    return { reason: 'render-failed', error: String((error as Error)?.message ?? error) }
  }
}

export interface PreviewResult {
  /** Real webp bytes, or the embedded placeholder on failure. */
  webp: Uint8Array
  /** True when `webp` is the placeholder rather than a real render. */
  placeholder: boolean
  reason?: RasterizeReason
}

export interface PreviewOptions {
  /** @deprecated ignored */
  engine?: Engine
  scale?: number
  /** Suppress the console warning emitted on fallback. */
  silent?: boolean
}

const ADVICE: Record<RasterizeReason, string> = {
  'no-browser': 'rasterizing failed — embedded a placeholder preview.webp.',
  'no-renderer':
    '@dotgui/render could not be loaded — embedded a placeholder preview.webp.\n' +
    '     • install it (`npm i @dotgui/render`); it is a dependency of the kit.',
  'render-failed': 'the document did not render — embedded a placeholder preview.webp.',
}

/**
 * The packing helper: render a `.gui` to `preview.webp` bytes. Always resolves to
 * usable bytes — the embedded placeholder (with a console warning) when the
 * document cannot be drawn, so packing never hard-fails.
 */
export async function renderPreview(pkg: GuiPackage, opts: PreviewOptions = {}): Promise<PreviewResult> {
  const { image, reason, error } = await rasterize(pkg, { format: 'webp', scale: opts.scale })
  if (image) return { webp: image, placeholder: false }
  if (!opts.silent) console.warn(`⚠  dotgui: ${ADVICE[reason!]}${error ? `\n     ${error}` : ''}`)
  return { webp: PLACEHOLDER_WEBP, placeholder: true, reason }
}
