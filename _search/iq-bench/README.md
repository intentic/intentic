# iq-bench

The benchmark harness for `iq`: it scores retrieval configurations against golden query sets and runs paired agent tasks with and without `iq` to show whether a change helps.

```mermaid
flowchart LR
    datasets["datasets/<br/>golden queries · pinned repos"] --> bench(["iq-bench"])
    tasks["tasks/<br/>locate · fix"] --> bench
    bench -- "tier 1: configs in-process" --> engine["iq-engine"]
    bench -- "tier 2: arm a vs arm b" --> agents["Agent CLIs<br/>claude · codex"]
    engine --> results["results/<br/>jsonl + summary.md"]
    agents --> results
```

- Tier 1 (`retrieval`) runs every configuration in `CONFIGS` (all stages on, then each stage off) in-process and scores recall@1/5/10, MRR and nDCG against expected anchors. `impact` checks the change-impact predictor against what past commits touched.
- Tier 2 (`agents`) gives the same task to an agent CLI twice: arm `a` gets a baseline instruction file, arm `b` the teaching from [iq](../iq)'s shipped plugin, so only the content differs. Tasks are graded by expected anchors, or by a test command after a bug-introducing patch.
- Tier 2 spends real tokens: it runs only under `IQ_BENCH_AGENTS=1`, which the `bench:agents` script sets, or with `--dry`.
- The corpora are this monorepo plus external repos pinned by commit in `datasets/repos.lock.json`, cloned into `.cache`. Semantic configs need the models, fetched once with iq-engine's script; without them those configs report as skipped.
- Reports compare each configuration with `full` case by case and apply a sign test to the wins and losses.
- Cases carry `slices` naming what they test beyond the average: `identifier-in-prose`, `paraphrase`, `near-duplicate`, `deprecated`, `no-answer`, `ui-copy` (a screenshot's text, the component that renders it expected) and `route` (an address, its declaration and view expected), several at once or none (`general`). The report scores every slice on its own, recall@1 · recall@5 per config beside the slice's case count, and flags a slice every config scores 100% on as saturated: it can no longer show a change. SurfSense's retrieval eval (MODSetter/SurfSense, `docs/architecture/search.md`) is the precedent: its same-language slices sat at 100% for every model and weight, so they could not see the regression an embedder swap caused.
- A `no-answer` case has no anchors, because nothing in the corpus answers it. It scores by whether iq called its answer weak, and the "Weak answers" section reads those cases against the answerable ones to calibrate iq-engine's `WEAK_FLOOR`.
- `IQ_BENCH_CACHE` moves the clones and indexes out of `.cache`, so two runs in one checkout never rebuild each other's index or share a vector cache written by another embedder.
- `IQ_BENCH_MONOREPO` points the `intentic` corpus at another checkout of this repository. The live one moves under a before/after pair (other agents land work in it, and the change being measured edits `_search/iq-engine`, which most intentic cases expect), so compare on a clone frozen at one commit: `git clone --no-hardlinks <repo> <dir>`, then run both arms with `IQ_BENCH_MONOREPO=<dir>`. The engine is then the only difference.
- Each row records the verdict word, what it was read off (`basis`: the cross-encoder, or a literal, route or identifier match), and the top and runner-up files' `[rerank]` scores, so a verdict rule can be recalibrated from `retrieval.jsonl` without rerunning. The "Verdicts" section reads each word against whether the top answer was right, and sweeps the confident rule's thresholds.

## Key files

- [src/cli.ts](src/cli.ts) — the `retrieval`, `impact`, `agents` and `analyze` entry points.
- [src/configs.ts](src/configs.ts) — the named pipeline configurations tier 1 compares.
- [src/score.ts](src/score.ts) — how an `iq` answer becomes ranked anchors and scores.
- [src/slices.ts](src/slices.ts) — the per-slice table and the weak-floor calibration.
- [src/verdicts.ts](src/verdicts.ts) — each verdict word against whether its top answer was right, and the confident rule's threshold sweep.
- [src/agents/run.ts](src/agents/run.ts) — tier 2: arms, vendors, spend cap, transcripts.
- [src/schema.ts](src/schema.ts) — the dataset, task and result row formats, and what each slice means.

## Commands

```sh
pnpm --filter @intentic/iq-bench build
pnpm --filter @intentic/iq-bench bench:retrieval
pnpm --filter @intentic/iq-bench bench:agents -- --task hono-body-limit --vendor claude
```

## Verdicts

The answer line's word is worth printing only if it predicts whether the top answer is right. `confident` needs the top file's best passage at `CONFIDENT_FLOOR` and a lead of `CONFIDENCE_MARGIN` over the runner-up file's ([iq-engine's verdict.ts](../iq-engine/src/verbs/verdict.ts)); an exact answer (literal text, a route, a defined identifier) is judged by its match instead.

- 2026-10-06, before and after on `full` (click, hono and intentic, the intentic corpus a clone frozen at `a696a23ee`), cases whose answer line printed each word:

  | verdict | before: cases · top answer right | after: cases · top answer right | no-answer cases drawing it, before → after |
  |---|---:|---:|---:|
  | confident | 40 · 67% (26/39) | 28 · 93% (26/28) | 1 → 0 |
  | ambiguous | 41 · 49% (17/35) | 55 · 59% (30/51) | 6 → 4 |
  | weak | 7 · 50% (1/2), 6 of 7 with nothing to find | 11 · 67% (2/3), 9 of 11 with nothing to find | 5 → 8 |

  After, 14 of the 28 confident answers were read off the cross-encoder (13 right), 7 off a literal match, 4 off a route and 3 off a single definition. The thresholds came from the before run's rows: over its 67 reranked answerable cases (the ui-copy and route cases left out, since they no longer reach this rule), the old rule (a lead of 0.05, no floor) called 33 confident at 76%; a floor of 0.9 with a lead of 0.1 called 15 at 93%, 0.8/0.1 20 at 85%, 0.9/0.05 18 at 89%. Each report prints that sweep under "The confident rule, swept".
- The sample is small: 67 judged cases and 12 no-answer ones. As a check on real queries, 402 bare `iq "…"` queries from 249 agent sessions (2026-09-20 on) were replayed through both builds: the old rule said confident on 38%, ambiguous on 62%, weak on none; the new one says confident on 16%, weak on 2%. Which file a session later opened is too loose a label to score either rule by (the top file was opened after 22% of confident answers and 18% of ambiguous ones under the old rule), but none of the 9 sessions the new floor calls weak opened the file iq answered with.

## The weak floor

iq calls an answer `weak` when no passage the cross-encoder reranked reaches `WEAK_FLOOR` ([iq-engine's verdict.ts](../iq-engine/src/verbs/verdict.ts)).

- 2026-10-06: `WEAK_FLOOR` is 0.05. On the run above it calls 8 of 12 no-answer cases weak instead of 5, and 3 of 67 reranked answerable cases instead of 2; the third is click's help-columns (0.010), found at rank 1. Between 0.005 and 0.05 sit three no-answer cases (0.019, 0.038, and 0.0498, a hair under the floor, so it is not a margin to lean on) and that one answerable case; the next answerable one is at 0.11.
- 2026-09-29: `WEAK_FLOOR` was 0.005. Over all three corpora it calls 2 of 67 reranked answerable cases weak (3%) and 5 of 12 no-answer cases (42%). One of the two false alarms is a paraphrase iq did not find anyway. Per corpus it holds 1 in 23 on click and hono and 0 in 21 on intentic. 0.02 adds a false alarm and catches nothing more; 0.1 catches 9 of 12 but calls 5 answerable cases weak (7%), 4 of them on click (17%).
- The floor is low because this cross-encoder (ms-marco-MiniLM, trained on web passages) scores some real code answers near zero: the answerable tail runs 0.0001, 0.0007, 0.010, 0.027, 0.055, and no-answer cases whose best passage is a neighbouring feature score high (click's password encryption against `hide_input` 0.90, YAML config against `default_map` 0.87, hono's SMTP 0.46). A reranker trained on code is the change most likely to pull the two populations apart; the calibration table measures it.
- The score is the cross-encoder's alone, so it does not depend on the embedder, but which passages reach the cross-encoder does. The numbers above ran with CLS pooling; a `full` rerun of click and hono under mean pooling classified every case the same at 0.005.
- Rejected: a floor on the semantic cosine. On click, under CLS pooling, the no-answer cases scored 0.74 to 0.79 and the answerable ones 0.70 to 0.86, the overlap SurfSense reports for the same embedder, whose cosine over unrelated text bottoms out near 0.62 (its ADR 0033). The bm25 tag is clamped at 1 for nearly every answer, and the margin and the fused ranks are relative to the best hit by construction.
