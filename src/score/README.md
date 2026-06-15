# `@dotgui/kit/score`

The CCACT quality model — a **read-only, advisory** quality report. The kit
produces a number and **takes no action**; what you do with it is your policy.

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
  optimize?: Optimize          // injected; powers Clean's diff signal
}
type Optimize = (xml: string) => OptimizeResult
// types: ScoreOutput, ScoreReport, GateFailure, LevelResult, NaLevel,
//        Audit, Severity, GateDetail, OptimizeResult, OptimizeStats
```

A passing file returns a **ScoreReport**: `clean`, `consistent`, `accessible`
(scored locally) plus `conventional` and `trend` (NA until the gui.farm corpus
exists). An invalid/broken file returns a **GateFailure** — it is rejected, not
scored.

## Examples

Basic — Clean is NA unless you inject the optimizer:

```ts
import { score } from '@dotgui/kit/score'

const out = score(markup)               // clean: NA (no optimizer)
```

Full scoring — inject the optional optimizer:

```ts
import { score } from '@dotgui/kit/score'
import { optimize } from 'gui-optimizer'

const out = score(markup, { optimize })
if (!('error' in out) && 'score' in out.clean) console.log(out.clean.score)
```

Consumer-defined policy (the kit never decides this):

```ts
const out = scorePackage(bytes, { optimize })
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
