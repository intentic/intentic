# @intentic/engine

The stateless **reconcile engine**. It walks a `DesiredStateGraph` in dependency order and converges it through the **Provider SPI** — never constructing providers itself, only consuming a `ResourceType → Provider` map. Depends on [`@intentic/graph`](../graph) + [`@intentic/resources`](../resources); the real providers live in [`@intentic/providers`](../providers).

## Responsibilities

- `apply` — converge once: per node, `read` → `diff` → `create`/`update`/`noop`, gating on readiness.
- `plan` — dry run: classify every node without mutating infra.
- `reconcile` — loop apply→read until a plan reads all-noop ("state reads true"), returning a `ConvergeResult`.
- Define the **Provider SPI** the rest of the system implements: `Provider`, `Providers`, `Observed`, `DiffResult`, `ProviderContext`.
- Emit structured `EngineEvent`s (for the CLI's ndjson/json output) and handle readiness, orphans, and pruning.

## Key files

- [src/apply.ts](src/apply.ts) / [src/plan.ts](src/plan.ts) / [src/reconcile-loop.ts](src/reconcile-loop.ts) — the converge/dry-run/loop logic.
- [src/provider.ts](src/provider.ts) / [src/types.ts](src/types.ts) — the SPI and engine types (`Provider`, `DiffResult`, `EngineConfig`, `Step`, `Orphan`).
- [src/readiness.ts](src/readiness.ts) — `httpProbe` / `waitReady` (readiness gates).
- [src/resolve-inputs.ts](src/resolve-inputs.ts) — resolve refs/secrets into concrete provider inputs.
- [src/orphans.ts](src/orphans.ts) / [src/prune.ts](src/prune.ts) — drift cleanup; [src/providers/](src/providers) — `createFakeProviders` (in-memory SPI for tests).

## How it fits

The execution core. `state-resolver` produces the graph; `providers` supplies the concrete SPI map; the `cli` wires them together and runs `reconcile`. The engine stays infra-agnostic — all I/O is behind the SPI.

## Conventions & gotchas

- The engine never imports `providers` — it takes a `Providers` map as input, so it can run against fakes.
- `diff` must be **pure** (read does the I/O); apply is the only mutating step. `EngineEvent` is part of the public contract for embedders. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
