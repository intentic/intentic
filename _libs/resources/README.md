# @intentic/resources

The closed **resource vocabulary** shared by the state resolver (which emits these kinds), the engine (which reconciles them), and the providers (which implement them). The graph IR treats a node's `type` as an opaque string; this package is the single authority on which kinds exist and what each produces. Depends only on [`@intentic/graph`](../graph).

## Responsibilities

- Define `ResourceType` — the closed union of every resource kind intentic understands (`host`, `cloudflare`, `forgejo`, `forgejo-runner`, `komodo`, `tunnel`, `cf-route`, `repo`, `ci`, `deployment`, `app`, `backup`, `workspace`, …).
- Define `ResolvedNode` — a `RawNode` whose `type` is constrained to a `ResourceType`.
- Catalog `OUTPUTS` — the output fields each kind produces, so downstream nodes can ref them with confidence.
- It is a vocabulary only: no resolution logic, no reconciliation, no provider code.

## Key files

- [src/resource-types.ts](src/resource-types.ts) — the `ResourceType` union + `ResolvedNode`.
- [src/outputs.ts](src/outputs.ts) — the `OUTPUTS` map (kind → produced fields).
- [src/index.ts](src/index.ts) — public surface.

## How it fits

Sits just above `graph`. The `state-resolver` emits `ResolvedNode`s of these types; the `engine` keys its `ResourceType → Provider` map on them; `providers` implements one provider per kind. Adding a new resource kind starts here.

## Conventions & gotchas

- The union is **closed** — adding a kind means updating `ResourceType`, its `OUTPUTS` entry, the emitter in `state-resolver`, and a provider in `providers`, together.
- Keep `OUTPUTS` accurate: refs are validated against it, so a missing/typo'd output surfaces as a resolve-time error. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
