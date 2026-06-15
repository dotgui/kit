# `@dotgui/kit/autofix`

Deterministic auto-repair for dotgui markup. Models make the same mechanical
mistakes (CSS habits, invented attributes, `boolean="false"`, bad color formats);
each is an unambiguous string rewrite, so `autofix` fixes them in place instead of
bouncing back to the author.

## API

```ts
import { autofixMarkup } from '@dotgui/kit/autofix'

autofixMarkup(xml: string): AutofixResult
```

```ts
interface AutofixResult {
  xml: string        // rewritten markup (unchanged if nothing to fix)
  fixes: string[]    // human-readable description of each applied fix
  error?: string     // set only if the markup couldn't be parsed
}
```

## What it repairs (only unambiguous fixes)

- **CSS-habit renames** — `width→w`, `height→h`, `spacing→gap`.
- **Padding shorthands** — `py→pt/pb`, `px→pl/pr`.
- **Drops no-op attrs** — `margin`, `mt/mb/ml/mr`, `justify`, `align-items`, `flex`.
- **Booleans** — removes `attr="false"` (presence-based).
- **Alignment** — `text-align→align`; remaps invented `align` values to the nearest
  valid 9-point / text value.
- **Stroke** — legacy `stroke`/`stroke-width` → `border` shorthand.
- **Colors** — expands `#abc`→`#aabbcc`, converts `rgb()/rgba()`→hex.
- **Content** — replaces em-dashes in copy with hyphens.

Anything needing **design judgment** (missing sizes, undefined tokens, empty
spacers) is deliberately *not* fixed — it stays a [lint](../lint/README.md) error.

## Examples

```ts
import { autofixMarkup } from '@dotgui/kit/autofix'

const { xml, fixes } = autofixMarkup(markup)
for (const f of fixes) console.log('·', f)
// xml is the cleaned markup — write it back
```

Typical `lint --fix` flow: `autofixMarkup` → re-`lintMarkup` the result → report
what's left for a human.

## Use cases

- **`gui lint --fix`** in the CLI.
- **gui-app** — repair on paste/save.
- Any agent pipeline that wants mechanical mistakes fixed without a round-trip.

> Pairs with [lint](../lint/README.md): lint *finds*, autofix *fixes the
> unambiguous subset*. Single source of truth — replaces the gui-app and skill
> copies.
