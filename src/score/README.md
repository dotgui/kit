# `@dotgui/kit/score`

The CCAC quality model — a **read-only, advisory** quality report. The kit
produces a number and **takes no action**; what you do with it is your policy.

It measures **how good the *file* is, not how good the *design* is** — like an
HTML validator, not a design critic. All four levels are **local, deterministic
and zero-AI**: no service, no corpus, no gui.farm. See `core/spec/QUALITY.md`.

## API

```ts
import { score, scorePackage, isGateFailure } from '@dotgui/kit/score'

score(xml: string, ctx?: ScoreContext): ScoreOutput
scorePackage(bytes: Uint8Array, ctx?: ScoreContext): ScoreOutput   // .gui or raw .guix
isGateFailure(out: ScoreOutput): out is GateFailure
```

```ts
interface ScoreContext {
  assetPaths?: Set<string>     // enables asset-intact checks
  optimize?: Optimize          // @deprecated — accepted and ignored (see Clean)
}
// types: ScoreOutput, ScoreReport, GateFailure, LevelResult, NaLevel,
//        Audit, Severity, GateDetail
```

A passing file returns a **ScoreReport**: `clean`, `consistent`, `accessible`
(all scored locally on the parsed tree) plus `comprehensible` — how AI-ready the
file is as semantics, scored by **reach-coverage**: each declared `role=`
documents its subtree as far as its catalog `reach` (`full`/`2`/`1`, see
`roleReach.ts`), and the score is the fraction of nodes documented. Audits are a
plain `{ role, path }` inventory. An invalid/broken file returns a **GateFailure**
— it is rejected, not scored.

## Clean

Clean measures structure that **costs without contributing to the render, and that
can be safely removed or replaced.** Like the rest of the report it is read-only
and advisory; it analyses the parsed tree and, since this revision, does **not**
depend on the optimizer. (The optimizer is the separate tool that can later apply
the fixes Clean marks safe.)

A node counts as **dead weight** only if it passes a **two-gate** test:

1. **Renders nothing** — no paint, or `visible=false` / `opacity=0` / zero-size /
   empty text.
2. **Removal is safe** — it breaks no contract (instance/component/mask) **and**
   does not move its siblings.

Gate #2 is **parent-aware**. Under an auto-layout parent an invisible node can be
load-bearing: `opacity=0` is `visibility:hidden` — it still holds its slot, so
removing it collapses the layout. Such a node is **not** dead weight; it is
reclassified as a **spacer hack** (use `gap`/padding) and never deleted. The same
node under a regular frame *is* removable. Buckets scored: **A** dead weight ·
**B** redundant wrappers · **C** hard-way layout (absolute positioning + spacer
hacks). Duplication is Consistent's concern; pure value-formatting (rgb→hex, float
rounding) has no render impact and is not scored.

## Examples

Clean (and Consistent, Accessible) score locally — no injection needed:

```ts
import { score } from '@dotgui/kit/score'

const out = score(markup)
if (!('error' in out) && 'score' in out.clean) console.log(out.clean.score)
```

Consumer-defined policy (the kit never decides this):

```ts
const out = scorePackage(bytes)
if (isGateFailure(out)) throw new Error('broken file')
// e.g. fail CI below a bar — your call, not the kit's
if (!('status' in out.accessible) && out.accessible.score < 70) process.exit(1)
```

## Use cases

- **CI quality gate** — your threshold, your decision to fail.
- **Warning badge** in an app on known-bad output.
- **Batch triage** — flag/auto-discard low-scoring generated files.

> Score never blocks packing and never loops back to authoring. A low score is
> still a perfectly valid file — like bad-but-valid HTML.
