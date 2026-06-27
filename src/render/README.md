# `@dotgui/kit/render`

The format's **reference output** — render `.gui` markup to HTML. Browser-clean:
no heavy dependencies, no browser engine bundled.

## API

```ts
import { render, renderToHTML, normalizeBooleanAttrs } from '@dotgui/kit/render'

// into a live DOM element (browser); returns a zoom controller if zoom is on
render(
  code: string,
  container: HTMLElement,
  assetMap?: Record<string, string>,
  options?: RenderOptions,
): ZoomControl | null

// resolved markup → HTML string (needs a DOM environment)
renderToHTML(
  code: string,
  assetMap?: Record<string, string>,
  options?: RenderOptions,
): string

normalizeBooleanAttrs(code: string): string
```

```ts
interface RenderOptions {
  zoom?: boolean                       // wrap in an interactive pan/zoom canvas
  mode?: Record<string, string>        // active mode, e.g. { theme: 'dark' }
  view?: ZoomView                      // restore a saved viewport (with zoom)
}
// types: RenderOptions, ZoomView, ZoomControl
```

## Examples

Render into a page (browser):

```ts
import { render } from '@dotgui/kit/render'

const zoom = render(markup, document.getElementById('stage')!, assetMap, { zoom: true })
zoom?.(1)   // fit-to-container
```

Render to a string and preview another mode:

```ts
import { renderToHTML } from '@dotgui/kit/render'

const darkHtml = renderToHTML(markup, assetMap, { mode: { theme: 'dark' } })
```

## Text wrapping fidelity

A fixed-width text box exported from Figma carries Figma's **exact** measured
width (e.g. `w="556"`), and the export is accurate. But the preview can still
wrap a word early — 3 lines where Figma shows 2 — because browsers *shape* text
slightly wider than Figma's text engine does.

Measured: a line Figma fits in 555.81px renders at 559.25px in Chrome — about
**0.6% wider**. No CSS lever closes this (font-smoothing, `font-kerning`,
`text-rendering`, `font-optical-sizing`, and ligature toggles all leave the width
unchanged). It's an inherent difference between two layout engines.

So `render` widens **fixed-width text boxes only** by a small proportional
tolerance (`TEXT_WRAP_TOLERANCE`, currently `1%`) at draw time. This is enough to
absorb the sub-percent shaping drift while staying far below a word's width, so
it can never pull a new word onto a line. It's render-only — the `.gui` width is
never modified, so the export data stays accurate. Skipped for single-line
ellipsis text (where wrapping doesn't apply).

`render` also defaults `gui-text` to grayscale antialiasing
(`-webkit-font-smoothing: antialiased`) to match Figma's text *appearance* (Figma
renders grayscale; browsers default to heavier subpixel). This is cosmetic — it
does not affect wrapping — and an explicit `font-smoothing` attribute overrides it.

For guaranteed pixel-identical wrapping regardless of engine, bake explicit line
breaks into the text at export time instead.

## Use cases

- **Live preview** in an app, the landing site, or a Figma plugin.
- **The reference output** every other format derives from (PNG/PDF/SVG exporters
  build on this).
- **Feeding a rasterizer** — render to HTML, then an injected browser turns it
  into `preview.webp` at pack time.

> Rendering to a bitmap (`preview.webp`, PNG…) is **not** here — it's
> [`/rasterize`](../rasterize/README.md), which drives a Chromium browser
> (`puppeteer-core` by default). `/render` only produces HTML.
