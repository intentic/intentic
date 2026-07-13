# @intentic/iq-engine

The search engine behind the [`iq`](../../_apps/iq) CLI: a disk index (`node:sqlite`) fused across
**lexical** (ripgrep), **structural** (ast-grep), **semantic** (local embed + rerank), and **git** engines,
with rank fusion and a token-budget renderer. This is the heavy lib of the iq cluster.

**Part of the iq dependency island** — imported only by `@intentic/iq` and `@intentic/iq-bench`. iq is
invoked as a subprocess (the daemon's `/workspace/search` route shells `iq --json`; the agent runs it as a
CLI), so **no app or daemon code imports this package**, and none should. Its `Iq*`-shaped results reach the
web only through the `sandbox-contract` `WorkspaceSearch*` schemas, never by import.
