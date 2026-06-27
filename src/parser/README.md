# `@dotgui/kit/parser`

Turns `.gui` markup into a **resolved model** — tokens, styles, and modes already
resolved — ready for rendering, scoring, or analysis.

## API

```ts
import { parse, parseXml, resolveTokenValue, flattenTokens } from '@dotgui/kit/parser'

parse(bytes: Uint8Array): ParsedGUI | null
parseXml(xml: string, assetMap?: Record<string, string>): ParsedGUI | null

resolveTokenValue(def: TokenDef, modes, activeMode): string | undefined
flattenTokens(tokenDefs, modes, activeMode): Record<string, string>
```

Types: `ParsedGUI`, `ParsedNode`, `ParsedFill`, `ParsedAppearance`, `ParsedEffect`,
`ParsedBorder`, `ParsedComponent`, `ParsedProp`, `TokenDef`, `ModeAxis`, `FontInfo`.

> **Runs anywhere:** `parseXml` is DOM-free. It uses the platform's native
> `DOMParser` when present (browser, Figma UI) and falls back to `@xmldom/xmldom`
> (pure JS) everywhere else — node, edge, the Figma sandbox. No DOM shim needed.

## Examples

```ts
import { parseXml } from '@dotgui/kit/parser'

const model = parseXml('<gui name="demo" platform="web-desktop"><frame name="root"/></gui>')
console.log(model?.platform)   // "web-desktop"
console.log(model?.root)       // ParsedNode tree
```

Resolve tokens for a specific mode (e.g. dark theme):

```ts
import { flattenTokens } from '@dotgui/kit/parser'

const values = flattenTokens(model.tokens, model.modes, { theme: 'dark' })
// { "color.bg": "#000", "color.fg": "#fff", ... }
```

## Use cases

- **Feed the renderer** — `parseXml` → model → `renderToHTML`.
- **Static analysis** — walk `ParsedNode` for linting, metrics, accessibility.
- **Token/theme resolution** — compute concrete values for any active mode.
- **Round-trip tooling** — Figma import/export reads the resolved model.
