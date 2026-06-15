# `@dotgui/kit/rasterize`

Turns a `.gui` into a bitmap — most importantly the `preview.webp` embedded when
packing, but also PNG/JPEG for `gui render`. Rasterizing needs a Chromium-based
browser; this module owns *how* the kit finds and drives one. It renders the `.gui`
with the built render bundle in a headless page, then screenshots the result.

## How it works

```
markup → render → HTML → [Chromium screenshot] → preview.webp
```

The kit ships a **default** rasterizer built on `puppeteer-core`, and lets an
implementation opt into full `puppeteer` for portability. If neither can find a
browser, packing still succeeds with a **placeholder preview** and a clear error.

## Two engines

### Default — `puppeteer-core` (assumed if you do nothing)

`puppeteer-core` is a **lightweight install**: it bundles *no* Chromium. It drives
a Chromium/Chrome **already present on the machine**. This is the kit default and
what the CLI uses — zero configuration.

- ✅ tiny dependency, fast install
- ⚠️ requires a Chromium-based browser to already exist on the host

### Opt-in — full `puppeteer` (stable everywhere)

When you need it to "just work" across machines/CI without depending on a
system browser, opt into full `puppeteer`. The implementation installs it
(`puppeteer` downloads its own known-good Chromium) and the kit uses that.

- ✅ self-contained, consistent rendering across environments
- ⚠️ heavier install (downloads ~Chromium, hundreds of MB)

```bash
# opt in: install full puppeteer in your app, then flip the setting
npm i puppeteer
```

## Configuration

The engine is chosen by a setting; **absent the setting, `puppeteer-core` is
assumed.**

```bash
# environment
DOTGUI_PUPPETEER=full     # use the installed full `puppeteer` + its Chromium
# (unset / anything else)  → puppeteer-core (default)
```

```ts
// or programmatically
rasterize(html, { engine: 'puppeteer' })   // 'puppeteer-core' (default) | 'puppeteer'
```

## No browser found → placeholder + error (never a hard failure)

Packing must not break just because the host has no Chromium. So when the chosen
engine can't locate a browser:

1. the kit embeds a **bundled dummy `preview.webp`** so the `.gui` is still valid
   and complete, and
2. it prints a **clear console error** telling the user what happened and how to
   fix it:

```
⚠  dotgui: no Chromium-based browser found — embedded a placeholder preview.webp.
   Fix one of:
     • install a Chromium/Chrome browser on this machine (used by puppeteer-core), or
     • run `npm i puppeteer` and set DOTGUI_PUPPETEER=full to bundle one.
```

The packaged file is real and usable; only the thumbnail is a stand-in until a
browser is available.

## Limitations of `puppeteer-core` (read before relying on the default)

- **Needs a system Chromium** — it will not download one. No browser → placeholder
  preview.
- **Renders with whatever browser is installed** — version/feature drift means the
  thumbnail can vary slightly machine to machine. Use full `puppeteer` for
  reproducible output.
- **Common CI/containers have no browser** — minimal images won't have Chrome;
  expect the placeholder unless you install one or opt into full `puppeteer`.
- **Node-only** — it launches a headless OS process. It cannot run in a browser
  (gui-app) or the Figma sandbox; those provide their own rasterization.
- **Runtime cost** — launching headless Chromium uses memory and startup time;
  it's the most expensive step in packing.

## API

```ts
import { rasterize, renderPreview, hasBrowser } from '@dotgui/kit/rasterize'

// general primitive — image bytes for any format, fails soft with a reason
rasterize(pkg: GuiPackage, opts?: RasterizeOptions): Promise<RasterizeResult>

// the packing helper — preview.webp, with placeholder + console warning on failure
renderPreview(pkg: GuiPackage, opts?: PreviewOptions): Promise<PreviewResult>

hasBrowser(engine?: Engine): Promise<boolean>
```

```ts
type Engine = 'puppeteer-core' | 'puppeteer'        // default via DOTGUI_PUPPETEER
type ImageFormat = 'webp' | 'png' | 'jpeg'
type RasterizeReason = 'no-browser' | 'no-renderer' | 'render-failed'

interface RasterizeOptions { format?: ImageFormat; scale?: number; engine?: Engine }  // format default 'webp'
interface RasterizeResult { image?: Uint8Array; reason?: RasterizeReason }            // image XOR reason

interface PreviewOptions { engine?: Engine; scale?: number; silent?: boolean }
interface PreviewResult { webp: Uint8Array; placeholder: boolean; reason?: RasterizeReason }
```

- **`rasterize`** is the primitive — returns image bytes or a `reason`, never a
  placeholder, never throws. `gui render` uses it (png/jpeg/webp).
- **`renderPreview`** is the packing helper — always returns usable `webp` bytes,
  falling back to the embedded placeholder (and a console warning) when no
  browser/renderer is found.

## Examples

```ts
// export any format
const { image, reason } = await rasterize(pkg, { format: 'png' })
if (image) writeFileSync('out.png', image)

// preview for packing — never fails
const { webp, placeholder } = await renderPreview(pkg)
pkg.preview = webp
```

## Consumers

- **CLI** — uses the default (`puppeteer-core`), no config. `gui render` →
  `rasterize`; write/pack preview → `renderPreview`/`rasterize`.
- **gui-app** — runs in a browser; can provide its own rasterization, bypassing
  both engines.
