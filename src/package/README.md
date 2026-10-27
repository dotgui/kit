# `@dotgui/kit/package`

The `.gui` container, in memory. A `.gui` is a ZIP of:

```
design.guix    — the markup (<gui> root)
assets/        — images, SVGs  (keyed "assets/<name>")
preview.webp   — rendered thumbnail
```

From spec 0.3 a package may also hold **several documents** — any `*.guix` at
the root, in filename order — and an optional **`library.guix`** whose
declarations (tokens, fonts, styles, components) every document shares
([RFC-0042](https://github.com/dotgui/core/blob/main/rfcs/0042-multi-document-packages.md)).
See *Multi-document packages* below.

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
info(pkg): { name?, platform?, documents, hasLibrary, assets, hasPreview }

// documents (spec 0.3)
listDocuments(pkg): string[]                 // filenames, in order
getDocument(pkg, name): string | undefined   // as written
getLibrary(pkg): string | undefined          // library.guix
isMultiDocument(pkg): boolean                // several documents, or a library
flatten(pkg, name?): string                  // the document with the library inlined
validateDocument(pkg, name?): ValidationResult

// edit — pure, return an updated package
setMarkup(pkg, xml): GuiPackage    // validates — throws InvalidMarkupError on bad markup
addAsset(pkg, name, bytes): GuiPackage
removeAsset(pkg, name): GuiPackage
setPreview(pkg, bytes): GuiPackage
setDocument(pkg, name, xml): GuiPackage   // validated in its package
setLibrary(pkg, xml): GuiPackage          // validated on its own
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
  xml: string                            // the primary (first) document
  documents?: Record<string, string>     // every document, by filename
  primary?: string                       // which one `xml` is
  library?: string                       // library.guix
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

## Multi-document packages

`unpack` reads every `*.guix` at the package root (one inside a directory is not
a document) and `library.guix` separately. `xml` is the first document in
filename order, so code that only knows one screen keeps working; `pack` writes
every document and the library back.

A document uses the library's names without importing them. To render or check
one, inline the library first:

```ts
import { unpack, listDocuments, flatten, validateDocument } from '@dotgui/kit/package'

const pkg = unpack(bytes)
for (const name of listDocuments(pkg)) {
  const result = validateDocument(pkg, name)   // package rules + ordinary checks
  const markup = flatten(pkg, name)            // a standalone single document
  render(markup)
}
```

`validateDocument` adds the package rules to the ordinary checks: every
document in a package with a library or several documents declares `0.3` or
higher (`VERSION_BELOW_PACKAGE`), and redeclaring a name the library declares is
an error, not an override (`LIBRARY_REDECLARED`). A name that resolves in
neither place is reported by the ordinary checks (`UNRESOLVED_TOKEN`, …).

`flatten` inlines the whole library part, not only the names a document uses.

## Standalone documents

Bare markup (not a ZIP) unpacks as a **standalone document** (`pkg.standalone`,
[RFC-0043](https://github.com/dotgui/core/blob/main/rfcs/0043-standalone-guix.md)):
the served, readable form. Its asset references must be absolute URLs —
`validateDocument` reports a local path as `LOCAL_ASSET_IN_STANDALONE`. Adding a
local asset (`addAsset`) or a second screen (`setDocument`) promotes it to a
package, the two triggers the RFC names.

Everywhere, from 0.3, an asset reference is never a `data:` URI (`DATA_URI`).
Both rules are errors in a document declaring 0.3 or higher and warnings in one
written before them. `validate(xml, { standalone: true })` applies them to bare
markup directly.

## Use cases

- **The CLI** — `read` / `info` / `add` / `rm` / `set-preview` / `pack` / `unpack`
  become thin wrappers: read file → op → write file.
- **gui-app** — open, edit assets, and save `.gui` files in the browser, no server.
- **`score`** — uses `unpack` to read packaged markup + asset paths (one source of
  truth, no duplicated unzip).
- **Any tool** — inspect or rewrite a `.gui` programmatically.

> Pure and in-memory: pass `readFileSync(path)` bytes in, write `pack(pkg)` bytes
> out. The kit never reads or writes files itself.
