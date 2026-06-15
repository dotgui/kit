/**
 * @dotgui/kit/rasterize — turn a `.gui` into an image via a headless Chromium.
 * Loads the built render bundle in a headless page so output is pixel-faithful,
 * then screenshots the rendered root.
 *
 *   rasterize(pkg, { format })   general primitive → image bytes (or a reason)
 *   renderPreview(pkg)           the packing helper → preview.webp, with a
 *                                placeholder + console warning when no browser
 *
 * Engines (see README):
 *   - default `puppeteer-core` — drives a Chromium already on the machine
 *   - opt-in  `puppeteer`      — DOTGUI_PUPPETEER=full, uses its bundled Chromium
 */
import puppeteer from 'puppeteer-core'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { GuiPackage } from '../package'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export type Engine = 'puppeteer-core' | 'puppeteer'
export type ImageFormat = 'webp' | 'png' | 'jpeg'

/** A minimal valid 1×1 WebP, embedded so the placeholder needs no encoder. */
const PLACEHOLDER_WEBP = new Uint8Array(
  Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'),
)

function chosenEngine(opt?: Engine): Engine {
  if (opt) return opt
  return process.env.DOTGUI_PUPPETEER === 'full' ? 'puppeteer' : 'puppeteer-core'
}

/** Locate a Chromium executable for the chosen engine. */
async function findExecutable(engine: Engine): Promise<string | null> {
  // Full puppeteer: use the Chromium it downloaded.
  if (engine === 'puppeteer') {
    try {
      const pptr: any = await import('puppeteer')
      const p: string | undefined = (pptr.executablePath ?? pptr.default?.executablePath)?.()
      if (p && existsSync(p)) return p
    } catch {
      /* puppeteer not installed — fall through to a system browser */
    }
  }
  // Default / fallback: a system Chromium-based browser.
  const env = process.env.PUPPETEER_EXECUTABLE_PATH
  if (env && existsSync(env)) return env
  const byPlatform: Record<string, string[]> = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  }
  return (byPlatform[process.platform] ?? []).find(existsSync) ?? null
}

/** Is a usable browser available for the chosen engine? */
export async function hasBrowser(engine?: Engine): Promise<boolean> {
  return (await findExecutable(chosenEngine(engine))) !== null
}

/** Locate the built render bundle (`dist/render.js`). */
function resolveRenderBundle(): string | null {
  const env = process.env.DOTGUI_RENDER_BUNDLE
  if (env && existsSync(env)) return env
  let dir = HERE
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'dist', 'render.js')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'png') return 'image/png'
  return 'image/webp'
}

export type RasterizeReason = 'no-browser' | 'no-renderer' | 'render-failed'

export interface RasterizeOptions {
  format?: ImageFormat   // default 'webp'
  scale?: number         // deviceScaleFactor, default 2
  engine?: Engine
}

export interface RasterizeResult {
  /** Image bytes, or undefined when `reason` is set. */
  image?: Uint8Array
  reason?: RasterizeReason
}

/**
 * Rasterize a `.gui` package to image bytes. Fails soft — returns a `reason`
 * (never throws, never a placeholder). Use `renderPreview` for the packing
 * thumbnail with placeholder behaviour.
 */
export async function rasterize(pkg: GuiPackage, opts: RasterizeOptions = {}): Promise<RasterizeResult> {
  const exe = await findExecutable(chosenEngine(opts.engine))
  if (!exe) return { reason: 'no-browser' }
  const bundle = resolveRenderBundle()
  if (!bundle) return { reason: 'no-renderer' }

  const format = opts.format ?? 'webp'
  const scale = opts.scale ?? 2

  // Assets → data URLs keyed by their package path (what the markup references).
  const assetMap: Record<string, string> = {}
  for (const [name, data] of Object.entries(pkg.assets)) {
    assetMap[name] = `data:${mimeFor(name)};base64,${Buffer.from(data).toString('base64')}`
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gui-rasterize-'))
  const harness = path.join(tmp, 'harness.html')
  writeFileSync(harness, `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}#root{display:inline-block}</style></head>
<body><div id="root"></div>
<script type="module">
  import { render } from ${JSON.stringify(pathToFileURL(bundle).href)}
  window.__render = (xml, assets) => { render(xml, document.getElementById('root'), assets) }
  window.__ready = true
</script></body></html>`)

  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--allow-file-access-from-files'],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 2400, deviceScaleFactor: scale })
    await page.goto(pathToFileURL(harness).href, { waitUntil: 'load' })
    await page.waitForFunction('window.__ready === true', { timeout: 5000 })
    await page.evaluate((xml: string, assets: Record<string, string>) => (window as any).__render(xml, assets), pkg.xml, assetMap)
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 5000 }).catch(() => {})
    const target = (await page.$('#root > *')) ?? (await page.$('#root'))
    if (!target) return { reason: 'render-failed' }
    const shot = (await target.screenshot({ type: format, omitBackground: format !== 'jpeg' })) as Uint8Array
    return { image: new Uint8Array(shot) }
  } catch {
    return { reason: 'render-failed' }
  } finally {
    await browser?.close().catch(() => {})
    rmSync(tmp, { recursive: true, force: true })
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
  engine?: Engine
  scale?: number
  /** Suppress the console warning emitted on fallback. */
  silent?: boolean
}

const ADVICE: Record<RasterizeReason, string> = {
  'no-browser':
    'no Chromium-based browser found — embedded a placeholder preview.webp.\n' +
    '   Fix one of:\n' +
    '     • install a Chromium/Chrome browser on this machine (used by puppeteer-core), or\n' +
    '     • run `npm i puppeteer` and set DOTGUI_PUPPETEER=full to bundle one.',
  'no-renderer':
    'render bundle not found (dist/render.js) — embedded a placeholder preview.webp.\n' +
    '     • run the kit build (`bun run build:render`), or set DOTGUI_RENDER_BUNDLE.',
  'render-failed':
    'render failed in the headless browser — embedded a placeholder preview.webp.',
}

/**
 * The packing helper: render a `.gui` to `preview.webp` bytes. Always resolves to
 * usable bytes — the embedded placeholder (with a console warning) when no
 * browser/renderer is available, so packing never hard-fails.
 */
export async function renderPreview(pkg: GuiPackage, opts: PreviewOptions = {}): Promise<PreviewResult> {
  const { image, reason } = await rasterize(pkg, { format: 'webp', scale: opts.scale, engine: opts.engine })
  if (image) return { webp: image, placeholder: false }
  if (!opts.silent) console.warn(`⚠  dotgui: ${ADVICE[reason!]}`)
  return { webp: PLACEHOLDER_WEBP, placeholder: true, reason }
}
