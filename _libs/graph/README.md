# @intentic/graph

The product-agnostic **desired-state IR** and its compiler — the data structure every other package is built around. A node's `type` is an opaque string here; the closed vocabulary lives in [`@intentic/resources`](../resources). This is the base of the dependency graph (depended on by every other package, depends on nothing internal).

## Responsibilities

- Define the serializable graph types: `DesiredStateGraph`, `RawNode`/`ResourceNode`, `Ref`, `SecretRef`, `Readiness`.
- Compile a map of `RawNode`s into a validated, dependency-ordered `DesiredStateGraph` (`compile`).
- Provide the primitives others compose with: typed refs between nodes, env-sourced secrets, HTTP readiness gates, and ownership stamps.
- It does **not** know which resource kinds exist, how to reconcile them, or how to talk to infra — those belong to `resources`/`engine`/`providers`.

## Key files

- [src/types.ts](src/types.ts) — the IR types (`DesiredStateGraph`, `RawNode`, `Ref`, `SecretRef`, `Readiness`).
- [src/compile.ts](src/compile.ts) — `compile`: RawNode map → graph (validates refs, fills order).
- [src/topo.ts](src/topo.ts) — `toNodeMap`, `linearize` (topological dependency order).
- [src/ref.ts](src/ref.ts) — `makeRef`/`refKey`/`isRef`, `env` (env-sourced secret), `httpOk` (readiness gate).
- [src/stamp.ts](src/stamp.ts) — `formatStamp`/`parseStamp` (resource ownership stamps).
- [src/serialize.ts](src/serialize.ts) — stable serialization of the graph.

## How it fits

Foundational layer. `resources` constrains node `type`s on top of it; `need-resolver`, `state-resolver`, `engine`, and `sdk` all consume its types; authors import `env` from here (its true source) when writing a `deploy.config.ts`.

## Conventions & gotchas

- Refs are typed pointers to another node's outputs — never inline a downstream value; emit a `Ref` so ordering and resolution stay correct.
- Secrets are `SecretRef`s with a `source` (`env` or `generated`); keep them as refs, never bake plaintext into a node.
- Co-located tests in [src/index.test.ts](src/index.test.ts). See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the full pipeline.
