# `@dotgui/kit/validate` + `@dotgui/kit` (types)

The schema layer: the canonical format **types** (exported from the package root)
and **`validate`**, the only required step in a `.gui` file's life.

## API

```ts
import { validate } from '@dotgui/kit/validate'

validate(guiXml: string): ValidationResult
```

```ts
interface ValidationResult {
  valid: boolean
  version: string | null
  errors: ValidationError[]
  warnings: ValidationError[]
}
interface ValidationError {
  code: string
  message: string
  path: string        // e.g. "gui > stack[0] > text[2]"
}
```

Types (from `@dotgui/kit`): `ColorValue`, `FillValue`, `GradientValue`, `TokenRef`,
`DimensionValue`, `BlendMode`, `LayoutDirection`, `EffectType`, `ShapeType`,
`BorderStyle`, `ImageFormat`, and the rest of the format vocabulary.

## Examples

```ts
import { validate } from '@dotgui/kit/validate'

const result = validate('<gui platform="web-desktop"><frame/></gui>')
if (!result.valid) {
  for (const e of result.errors) console.error(e)
}
```

Gate a write — refuse to save broken markup:

```ts
import { validate } from '@dotgui/kit/validate'
import { pack } from '@dotgui/kit/package'

function save(xml: string) {
  const { valid, errors } = validate(xml)
  if (!valid) throw new Error('invalid .gui: ' + JSON.stringify(errors))
  return pack({ xml, assets: {} })
}
```

## Use cases

- **The required gate** before writing/packing a `.gui`.
- **Editor diagnostics** — surface schema errors inline as the user types.
- **CI** — fail a build on malformed markup.

> `validate` answers *"is this broken?"* — not *"is this good?"*. Quality is
> [`/score`](../score/README.md), which is advisory and never blocks.
