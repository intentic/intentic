# @intentic/iq-engine

The search engine behind the [`iq`](../../_search/iq) CLI, and the heavy lib of the iq cluster.

A disk index (`node:sqlite`) fused across **lexical** (ripgrep), **structural** (ast-grep), **semantic** (local
embed + rerank) and **git** engines, with rank fusion and a token-budget renderer.

The rebuildable index lives at `.intentic/local/cache/iq/`. Fresh databases use SQLite incremental auto-vacuum; a
completed writer pass compacts when at least 25% of the file is freelist pages, so delete-heavy reindexes do not
leave a gigabyte-scale sparse cache behind.

The agent plane is out of search scope BY DEFAULT: [workspace/floor.ts](src/workspace/floor.ts) allows only the
state table's own authored slice of `.intentic` (`SEARCHABLE_STATE_PATHS` from `@intentic/sandbox-contract`:
reviewable config plus drafts, staged docs, workspace extensions) and denies every ledger, cache, profile and
checkout, including ones added later, without this package changing.

Chunk embeddings live in a `sqlite-vec` table beside the chunks, one signed byte per dimension, and the nearest
ones to a query are found inside SQLite rather than by handing every vector to JavaScript. On this workspace:
4,039 files, 67k embedded chunks: that is the difference between 286ms and 31ms a query, 451MB and 79MB of peak
memory, and a 212MB index and an 85MB one. What the quantizing costs is measured rather than assumed: against
the float scorer over 30 natural-language queries, the top hit is identical every time, 97.4% of the top 24 are,
and no displayed score moves by more than the 0.01 it is rounded to. A vector is also a pure function of chunk
text, so nothing here is precious: [embed/vector-cache.ts](src/embed/vector-cache.ts) keeps full-precision
copies in a sidecar the index dir's own deletion never touches.

Three engines answer "orient me" rather than "find X", and read the index rather than searching it:
[engines/map.ts](src/engines/map.ts) PageRanks files over the import graph: specifiers captured by
[indexer/imports.ts](src/indexer/imports.ts) at index time, resolved against the indexed file set at query
time: and [engines/hotspots.ts](src/engines/hotspots.ts) multiplies git churn by the per-file branch count
that [indexer/complexity.ts](src/indexer/complexity.ts) stores alongside symbols.
[engines/impact.ts](src/engines/impact.ts) walks the same import edges backwards *and* forwards from a set of
changed files to answer "what does this reach, and which tests reach it". It stops at ONE hop, which is the
benchmark's answer rather than a hedge: `iq-bench impact` grades strategies against what past commits actually
changed together, and there two hops lost to one outright: precision collapses long before the extra recall
arrives. The resolution both it and the map depend on now lives once, in
[engines/import-graph.ts](src/engines/import-graph.ts), which builds the edges in both directions together
because reversing them on demand costs a second pass over every edge.
[engines/health.ts](src/engines/health.ts) is those two rankings as NUMBERS rather than rendered lines, for a
host that plots them: the daemon serves it at `/workspace/health` and the browser draws one repo's
codebase-health panel from it. One ranking, two presentations: the verbs keep printing text for the agent.

**Part of the iq dependency island.** The CLI (`@intentic/iq`) and the benchmark harness are its only
*search-shaped* consumers; the daemon holds ONE long-lived engine: as a `createEngineClient` handle, see below
- and calls `run` / `health` on it for `/workspace/search` and `/workspace/health`, which is the only reason
app code imports this package at all. Nothing else should: every other path to these results is the
`sandbox-contract` wire shape (`WorkspaceSearch*`, `WorkspaceHealth*`), never an import.

## Two engines, and why the resident one has threads

`createEngine` is one query and exit: the CLI. It does everything on its own thread because nothing else is
there to disturb.

`createResidentEngine` is the daemon's, and the daemon's thread is also serving every agent stream, the routes
and the browser. Both of the expensive halves of search are moved off it. Keeping the index current is one
thread ([indexer/index-worker.ts](src/indexer/index-worker.ts)); answering the model stages of a query is the
other ([query/query-worker.ts](src/query/query-worker.ts)). The cross-encoder is what still earns that thread:
a few hundred milliseconds per query, tokenized in JS, yielding at no point. Scoring used to cost about as much
again and no longer does: since the vector table took over the ranking it is tens of milliseconds, and it is the
reranker alone that would otherwise stall every agent stream the daemon is serving.

## And why the whole thing is a separate process

Threads moved the CPU off the daemon's loop. They could not move the MEMORY: a worker thread shares its
process's address space, so the two models, the index cache and the workspace sweep were all resident in the
daemon. Measured there: about 2 GB of resident memory against 360 MB of JavaScript heap. On a box under memory
pressure most of a gigabyte of the *control plane*: the thing every browser request, every agent turn and
every git poll goes through: was paged out to serve a search nobody had asked for yet. It showed up as tens of
milliseconds of baseline event-loop delay and multi-second stalls with no I/O to blame.

So [host/client.ts](src/host/client.ts) is a `ResidentEngine` by interface and a proxy by implementation: it
forks [host/child.ts](src/host/child.ts), which builds the real engine over there and answers over an IPC
channel. The daemon keeps a small hot set and pays one round trip plus a structured clone per query, which
against a search that runs BM25, a vector scan and a cross-encoder is noise.

Two consequences worth knowing. `metrics()` is **synchronous** and a process boundary is not, so the child
*pushes* a snapshot whenever the numbers move and the client answers from the last one: with the sweep's
timestamp rather than its age, so an idle engine's figures keep aging instead of freezing at the last push. And
an `AbortSignal` does not cross a boundary at all: the client forwards the abort as a message, and the child
raises it on a controller of its own so it still reaches the ripgrep child it was always meant to kill.

```dag
{ "title": "One index, its own process, three threads", "direction": "LR",
  "nodes": [{ "id": "daemon", "label": "Sandbox daemon", "note": "keeps none of this", "accent": "2" },
            { "id": "host", "label": "Engine main thread", "note": "BM25, rg, fusion, render", "accent": "4" },
            { "id": "index", "label": "Index worker", "note": "the only writer", "accent": "4" },
            { "id": "query", "label": "Query worker", "note": "vectors + cross-encoder", "accent": "4" },
            { "id": "db", "label": "index.db", "note": "SQLite, WAL", "accent": "neutral" }],
  "edges": [{ "from": "daemon", "to": "host", "dashed": true },
            { "from": "host", "to": "db" }, { "from": "query", "to": "db" }, { "from": "index", "to": "db" },
            { "from": "host", "to": "index", "dashed": true }, { "from": "host", "to": "query", "dashed": true }] }
```

Write-ahead logging is what makes the three-thread part safe: one writer, two readers, no waiting. Every dashed
edge is messages: the daemon's query and its answer, a change notification out to the indexer, a query out to
the scorer. Notice that nothing but the engine's own main thread ever holds the daemon's, and that the box
around the right-hand four is a process the daemon can lose: a child that dies fails the calls it was holding,
says so through the host's `onQueryError`, and the next search brings up a fresh one.

The engine's `metrics()` reports its cached file count, dirty/applied sequence lag, generation, and query-worker
liveness/backlog without walking the sweep; the sandbox folds those numbers into its durable resource time
series so a growing host heap can be compared with the state this engine actually retains.

## Key files

- [src/verbs](src/verbs): one file per search verb; the surface `iq` dispatches into.
- [src/engines](src/engines), the four searches: lexical, structural, semantic, git.
- [src/plan](src/plan): intent detection and rank fusion; how four answers become one.
- [src/query](src/query): the two model stages behind an interface, and the thread they run on.
- [src/host](src/host): the client/child pair that puts the resident engine in its own process.
- [src/indexer](src/indexer): building and updating the disk index.
- [src/render](src/render): fitting results into a token budget.
- [src/store](src/store): the `node:sqlite` index itself.
