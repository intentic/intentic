# @intentic/iq-engine

The search engine behind the [`iq`](../../_apps/iq) CLI: a disk index (`node:sqlite`) fused across
**lexical** (ripgrep), **structural** (ast-grep), **semantic** (local embed + rerank), and **git** engines,
with rank fusion and a token-budget renderer. This is the heavy lib of the iq cluster.

Two engines answer "orient me" rather than "find X", and read the index rather than searching it:
[engines/map.ts](src/engines/map.ts) PageRanks files over the import graph — specifiers captured by
[indexer/imports.ts](src/indexer/imports.ts) at index time, resolved against the indexed file set at query
time — and [engines/hotspots.ts](src/engines/hotspots.ts) multiplies git churn by the per-file branch count
that [indexer/complexity.ts](src/indexer/complexity.ts) stores alongside symbols.
[engines/health.ts](src/engines/health.ts) is those two rankings as NUMBERS rather than rendered lines, for a
host that plots them: the daemon serves it at `/workspace/health` and the browser draws one repo's
codebase-health panel from it. One ranking, two presentations — the verbs keep printing text for the agent.

**Part of the iq dependency island.** The CLI (`@intentic/iq`) and the benchmark harness are its only
*search-shaped* consumers; the daemon holds ONE long-lived `createResidentEngine` (see the app's
`composition.ts`) and calls `run` / `health` in-process for `/workspace/search` and `/workspace/health`, which
is the only reason app code imports this package at all. Nothing else should: every other path to these
results is the `sandbox-contract` wire shape (`WorkspaceSearch*`, `WorkspaceHealth*`), never an import.
