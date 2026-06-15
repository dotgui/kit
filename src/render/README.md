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

## Use cases

- **Live preview** in an app, the landing site, or a Figma plugin.
- **The reference output** every other format derives from (PNG/PDF/SVG exporters
  build on this).
- **Feeding a rasterizer** — render to HTML, then an injected browser turns it
  into `preview.webp` at pack time.

> Rendering to a bitmap (`preview.webp`, PNG…) is **not** here — it's
> [`/rasterize`](../rasterize/README.md), which drives a Chromium browser
> (`puppeteer-core` by default). `/render` only produces HTML.
