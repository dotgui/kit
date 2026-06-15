# `@dotgui/kit/package`

The `.gui` container, in memory. A `.gui` is a ZIP of:

```
design.guix    — the markup (<gui> root)
assets/        — images, SVGs  (keyed "assets/<name>")
preview.webp   — rendered thumbnail
```

Everything here is **pure and byte-based** — unzip/zip happen in memory, nothing
touches disk. Read the markup, list/add/remove assets, swap the preview, without
extracting a shadow folder. File-system glue (paths, temp, cache) is the caller's
concern.

## API

```ts
import {
  isZip, unpack, pack,
  getMarkup, getAsset, listAssets, getPreview, info,
  setMarkup, addAsset, removeAsset, setPreview,
} from '@dotgui/kit/package'

// container
isZip(bytes: Uint8Array): boolean
unpack(bytes: Uint8Array): GuiPackage     // .gui ZIP or raw .guix → model
pack(pkg: GuiPackage): Uint8Array         // model → .gui bytes

// read
getMarkup(pkg): string
getAsset(pkg, name): Uint8Array | undefined
listAssets(pkg): string[]
getPreview(pkg): Uint8Array | undefined
info(pkg): { name?, platform?, assets, hasPreview }

// edit — pure, return an updated package
setMarkup(pkg, xml): GuiPackage    // validates — throws InvalidMarkupError on bad markup
addAsset(pkg, name, bytes): GuiPackage
removeAsset(pkg, name): GuiPackage
setPreview(pkg, bytes): GuiPackage
```

**`setMarkup` is guarded.** It runs `validate` first; invalid markup never enters
the package model, so a broken edit throws immediately instead of silently
reaching `pack`/save:

```ts
import { setMarkup, InvalidMarkupError } from '@dotgui/kit/package'

try {
  pkg = setMarkup(pkg, editedXml)   // saved only if valid
} catch (e) {
  if (e instanceof InvalidMarkupError) showErrors(e.errors)  // ValidationError[]
}
```

(`unpack` and `pack` stay unguarded — you can still read or repack an existing
file that's imperfect; the gate is on *new* edits.)

```ts
interface GuiPackage {
  xml: string
  assets: Record<string, Uint8Array>     // keyed "assets/<name>"
  preview?: Uint8Array
}
```

Asset names are normalized — `addAsset(pkg, 'logo.png', …)` stores
`assets/logo.png`; `getAsset`/`removeAsset` accept either form.

## Examples

Read a `.gui` without touching disk:

```ts
import { unpack, getMarkup, listAssets } from '@dotgui/kit/package'

const pkg = unpack(bytes)
console.log(getMarkup(pkg))
console.log(listAssets(pkg))   // ["assets/hero.webp", ...]
```

Edit and repack (pure, chainable):

```ts
import { unpack, addAsset, removeAsset, setPreview, pack } from '@dotgui/kit/package'

let pkg = unpack(bytes)
pkg = addAsset(pkg, 'logo.png', logoBytes)
pkg = removeAsset(pkg, 'old.png')
pkg = setPreview(pkg, previewBytes)
const out = pack(pkg)          // new .gui bytes
```

## Use cases

- **The CLI** — `read` / `info` / `add` / `rm` / `set-preview` / `pack` / `unpack`
  become thin wrappers: read file → op → write file.
- **gui-app** — open, edit assets, and save `.gui` files in the browser, no server.
- **`score`** — uses `unpack` to read packaged markup + asset paths (one source of
  truth, no duplicated unzip).
- **Any tool** — inspect or rewrite a `.gui` programmatically.

> Pure and in-memory: pass `readFileSync(path)` bytes in, write `pack(pkg)` bytes
> out. The kit never reads or writes files itself.
