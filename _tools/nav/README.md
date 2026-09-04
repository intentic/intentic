# nav

Measures what this codebase costs an **agent** to work in — tokens burned locating and reading a symbol — as
opposed to what it costs the CPU.

Built to reproduce the measurement half of [NousResearch/hermes-agent#102117](https://github.com/NousResearch/hermes-agent/pull/102117),
whose own eval README makes the point this harness is designed around: *"report both numbers, not the
flattering one."* Everything here is offline and deterministic, and makes no model calls. The
`simplify-campaign` skill drives it; you can also just run it.

## Key files

- [`run.mjs`](./run.mjs) — the CLI: `measure`, `targets`, `compare`, `calibrate`. Start here.
- [`bench.mjs`](./bench.mjs) — the headline number: what an agent pays to open a symbol's defining file, over
  every first-party import in the test suite.
- [`lookup.mjs`](./lookup.mjs) — the check on that number: what a *skilled* agent pays when it greps first.
- [`metrics.mjs`](./metrics.mjs) — shape of the tree, including the counter-movers a split makes worse.
- [`gate.mjs`](./gate.mjs) — proves a refactor removed no public export and moved no frozen contract file.
- [`lib/resolve.mjs`](./lib/resolve.mjs) — follows an imported name through re-exports to the file that
  actually defines it, which is what makes the bench measure anything real.

## Usage

```bash
node _tools/nav/run.mjs calibrate                     # is the token estimator sane?
node _tools/nav/run.mjs measure --label baseline      # → _tools/nav/baselines/baseline.json
node _tools/nav/run.mjs targets --top 20              # what a decomposition round should attack
node _tools/nav/run.mjs measure --label round1
node _tools/nav/run.mjs compare _tools/nav/baselines/baseline.json _tools/nav/baselines/round1.json

node _tools/nav/gate.mjs snapshot                     # before the refactor
node _tools/nav/gate.mjs check _tools/nav/baselines/surface.json   # after each slice
```

`--ref <git-ref>` measures any ref without checking it out, so a baseline can be captured while you keep
working in the tree. A full run over this repository takes about a minute.

## Reading the results honestly

**The two lookup numbers are supposed to disagree.** `bench` charges the naive cost — open the defining file,
read it — and it collapses when a god file is split. `lookup` charges the skilled cost — grep, read a 60-line
window, page forward only while the definition continues — and barely moves on a file split, because grep
already dodged file size. What moves the skilled number is definitions getting *shorter* and code getting less
dense. A round that improves `bench` 60% and `lookup` 2% rearranged files; a round that improves both
simplified code. Both are worth doing. They are not the same claim.

**Stripping comments cuts lines and raises cost per line.** Fewer lines, each denser, so a fixed read window
returns more tokens. `compare` prints what share of any line reduction was comments and blanks rather than
code, because the difference between "we removed 34% of the lines" and "we removed 31% of the code and 43% of
the reduction was comments" is the difference between a result and a headline.

**Splitting makes some numbers worse, by design.** Module count, import edges and the largest dependency cycle
all grow when intra-file coupling becomes inter-module coupling. They are in the same table as the wins and
`compare` prints them whichever way they moved.

**`over128k` is the number that is not a percentage.** A lookup whose defining file cannot fit a context
window is not expensive, it is a failure. Driving that count to zero beats any improvement in a median.

## What the token counts are, exactly

There is no tokenizer in this repository's dependency graph and this harness is not worth adding one for, so
`lib/tokens.mjs` estimates: it splits text the way a code BPE roughly does — identifiers at camelCase
boundaries, punctuation digraphs glued, indentation runs merged — rather than dividing bytes by a constant,
which is bad at code and blind to the density shift above.

Nobody has diffed it against `o200k_base` on this tree. What `calibrate` asserts is that the whole-tree
characters-per-token ratio lands in the 3.2–4.2 band real code BPE occupies (this repo: **3.47**). Treat an
absolute figure as the right order of magnitude and a *delta* as real — a systematic bias applies to both sides
of a comparison and cancels.

For exact counts: install `gpt-tokenizer` where Node can resolve it and set `NAV_TOKENIZER=real`. Every output
file records which counter produced it, and `compare` refuses to diff two runs that used different ones.

## What it deliberately does not do

- **No type checker.** `ts.createSourceFile` per file, no `ts.Program`. A full program needs every tsconfig to
  resolve and every dependency installed, takes minutes, and dies on a tree that does not currently build —
  which is the tree you most want to measure, halfway through a refactor.
- **No guessing.** A name the resolver cannot follow is counted as `unresolved` and excluded, never attributed
  to a plausible file. Attribution by name proximity is how the original campaign pointed `kanban_db.connect`
  at a different database.
- **No typecheck, lint or tests in `gate.mjs`.** `pnpm verify:turn` already does those over the affected
  closure. The gate covers only what a green suite structurally cannot see: an export nothing in-tree calls,
  and a frozen contract file that moved.
