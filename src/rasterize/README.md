# `@dotgui/kit/rasterize`

Turns a `.gui` into a bitmap — most importantly the `preview.webp` embedded when
packing, but also PNG/JPEG for `gui render`.

## How it works

```
.gui → @dotgui/render (Rust, compiled to WebAssembly) → png / webp / jpeg
```

The kit draws with the dotgui renderer — the same Rust code as the native
renderer, run as WebAssembly in Node or Bun. There is no browser: no Chromium to
find or download, and the same pixels on every machine. Installed system fonts
are read from disk; Google fonts and remote images are fetched over the network
(pass `network: false` to stay offline).

```ts
import { rasterize, renderPreview } from '@dotgui/kit/rasterize'

const { image, reason } = await rasterize(pkg, { format: 'png', scale: 2 })
const { webp, placeholder } = await renderPreview(pkg)   // for packing
```

- **`rasterize(pkg, { format, scale, mode, network })`** — fails soft: returns
  image bytes or a `reason` (`no-renderer`, `render-failed`, with an `error`).
  A package draws its primary document against its library and assets.
- **`renderPreview(pkg)`** — always returns usable `preview.webp` bytes: the
  render, or a 1×1 placeholder with a console warning, so packing never fails.

WebP is lossless. JPEG is drawn on white, since it has no transparency.

## Migrating from the headless-browser rasterizer

Up to kit 0.4.0 this module drove a Chromium with `puppeteer`. The `engine`
option, `hasBrowser()`, `DOTGUI_PUPPETEER` and `DOTGUI_RENDER_BUNDLE` are kept
so callers keep compiling, and do nothing: there is one renderer now (core
GOVERNANCE, *One renderer*). `puppeteer-core` is no longer a dependency.
