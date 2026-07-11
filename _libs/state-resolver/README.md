# @intentic/state-resolver

The **state resolver**: turns an `IntentSet` into the desired state — a `DesiredStateGraph`. It assigns each need its catalog option and compiles the emitted nodes into one graph. Depends on [`@intentic/graph`](../graph), [`@intentic/need-resolver`](../need-resolver) (needs), and [`@intentic/resources`](../resources) (the vocabulary it emits); consumed by [`@intentic/sdk`](../sdk).

## Responsibilities

- Resolve needs to concrete catalog options (Forgejo for git+registry, Komodo for control, Cloudflare for domain, GitHub/GHCR as the alternative stack).
- Emit the `ResolvedNode`s for each assignment and `compile` them into a single dependency-ordered graph (`resolveState`).
- Derive the control-plane platform and the application-plane support stack (repos, CI, deployments, tunnel, routes, workspace sandbox).
- It does **not** talk to infra or reconcile — it only produces the serializable artifact.

## Key files

- [src/state.ts](src/state.ts) — `resolveState`: intent → `DesiredStateGraph`.
- [src/catalog.ts](src/catalog.ts) — `defaultCatalog`, `Catalog`/`Option` (what satisfies each capability).
- [src/emit.ts](src/emit.ts) — `emit` + `Assignment` (build the nodes for one assignment); `emit-github.ts` for the GitHub stack.
- [src/platform.ts](src/platform.ts) / [src/app.ts](src/app.ts) / [src/route.ts](src/route.ts) / [src/workspace.ts](src/workspace.ts) — per-area node derivation (control plane, app plane, DNS routes, dev workspace sandbox).
- [src/ids.ts](src/ids.ts) / [src/identity.ts](src/identity.ts) — id helpers, `adminUsername`.

## How it fits

Stage 2 of the pipeline: `need-resolver` produces `Need`s, this maps each to an `Option` and emits `@intentic/resources` nodes, then `graph.compile` orders them. The `sdk`'s `defineStack` runs this end-to-end; `cli resolve` writes the result to `desired-state.json`.

## Conventions & gotchas

- Adding a resource kind means emitting it here **and** registering its type/outputs in `resources` and a provider in `providers`.
- Emitter changes are snapshot-tested ([src/emit.test.ts](src/emit.test.ts), [src/state.test.ts](src/state.test.ts)) — update fixtures deliberately. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
