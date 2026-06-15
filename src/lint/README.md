# `@dotgui/kit/lint`

The dotgui **linter** — idiom, best-practice, and content checks on top of schema
legality. Where [`/validate`](../schema/README.md) answers *"is this legal?"*,
`lint` answers *"is this good, idiomatic dotgui?"*.

## API

```ts
import { lintMarkup } from '@dotgui/kit/lint'

lintMarkup(xml: string): LintResult
```

```ts
interface LintResult {
  issues: LintIssue[]   // all findings
  errors: LintIssue[]   // issues with level === 'error'
  ok: boolean           // no errors
  ran: boolean          // false only if markup couldn't be parsed
}
interface LintIssue {
  level: 'error' | 'warn'
  where: string         // tag or section
  message: string
}
```

## What it checks

- **Structure** — unknown tags, empty spacer nodes, required `w`/`h`, `w="fill"`
  children needing a sized parent, abs bottom-pin needing a sized ancestor.
- **Attributes** — invented attrs (`margin`, `py`, `flex`, …), `boolean="false"`,
  `text-align` on text, invalid 9-point/text `align`, legacy `stroke`.
- **Values** — color formats (hex/`$token` only, no CSS keywords/`rgb()`),
  `gap="auto"` without a fill dimension, undefined `$token` references.
- **Content "AI tells"** — em/en-dashes, lorem ipsum, placeholder names/emails,
  emoji in copy, filler marketing verbs, slop brand names.

## Examples

```ts
import { lintMarkup } from '@dotgui/kit/lint'

const { ok, errors, issues } = lintMarkup(markup)
if (!ok) for (const e of errors) console.error(`[${e.where}] ${e.message}`)
```

## Use cases

- **`gui lint`** in the CLI.
- **gui-app** authoring diagnostics.
- **The skill linter** — one rule set, not a re-port.

> `lint` is the single source of truth for idiom rules. It replaces the old
> per-consumer copies (CLI port, gui-app validator, `build_gui.py`). Deterministic
> fixes for these issues live in [autofix](../autofix/README.md).
