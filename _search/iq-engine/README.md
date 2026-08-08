# @intentic/iq-engine

The search engine behind the [`iq`](../../_search/iq) CLI, and the heavy lib of the iq cluster.

A disk index (`node:sqlite`) fused across **lexical** (ripgrep), **structural** (ast-grep), **semantic** (local
embed + rerank) and **git** engines, with rank fusion and a token-budget renderer.

The rebuildable index lives at `.intentic/cache/iq/`. Fresh databases use SQLite incremental auto-vacuum; a
completed writer pass compacts when at least 25% of the file is freelist pages, so delete-heavy reindexes do not
leave a gigabyte-scale sparse cache behind.

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

## Two engines, and why the resident one has threads

`createEngine` is one query and exit — the CLI. It does everything on its own thread because nothing else is
there to disturb.

`createResidentEngine` is the daemon's, and the daemon's thread is also serving every agent stream, the routes
and the browser. Both of the expensive halves of search are moved off it. Keeping the index current is one
thread ([indexer/index-worker.ts](src/indexer/index-worker.ts)); answering the model stages of a query is the
other ([query/query-worker.ts](src/query/query-worker.ts)) — measured against a real workspace index, scoring
every embedded chunk costs ~300ms and the cross-encoder another ~400ms, and neither yields while it runs.

```dag
{ "title": "One index, three threads", "direction": "LR",
  "nodes": [{ "id": "host", "label": "Host thread", "note": "BM25, rg, fusion, render", "accent": "4" },
            { "id": "index", "label": "Index worker", "note": "the only writer", "accent": "4" },
            { "id": "query", "label": "Query worker", "note": "vectors + cross-encoder", "accent": "4" },
            { "id": "db", "label": "index.db", "note": "SQLite, WAL", "accent": "neutral" }],
  "edges": [{ "from": "host", "to": "db" }, { "from": "query", "to": "db" }, { "from": "index", "to": "db" },
            { "from": "host", "to": "index", "dashed": true }, { "from": "host", "to": "query", "dashed": true }] }
```

Write-ahead logging is what makes that safe: one writer, two readers, no waiting. The dashed edges are
messages — a change notification out to the indexer, a query out to the scorer and its ranked answer back.

## Key files

- [src/verbs](src/verbs) — one file per search verb; the surface `iq` dispatches into.
- [src/engines](src/engines) — the four searches: lexical, structural, semantic, git.
- [src/plan](src/plan) — intent detection and rank fusion; how four answers become one.
- [src/query](src/query) — the two model stages behind an interface, and the thread the daemon runs them on.
- [src/indexer](src/indexer) — building and updating the disk index.
- [src/render](src/render) — fitting results into a token budget.
- [src/store](src/store) — the `node:sqlite` index itself.
