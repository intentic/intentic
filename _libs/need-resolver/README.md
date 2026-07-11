# @intentic/need-resolver

The **need resolver**: turns an authored `IntentSet` into the abstract capabilities it requires. It owns the authored intent shapes and the intent → needs derivation — the first stage of the pipeline. Depends only on [`@intentic/graph`](../graph); consumed by [`@intentic/state-resolver`](../state-resolver) and [`@intentic/sdk`](../sdk).

## Responsibilities

- Define the authored intent shapes (`IntentSet`, `HostIntent`, `CloudflareIntent`, `AppIntent`, …) and their input types.
- Derive the abstract `Need`s an intent implies — `source-control`, `docker-registry`, `infra-control`, `deployment-target`, `domain` — each a `Capability` on a `Plane` (control vs application).
- It stops at *abstract capabilities*: it does **not** choose concrete options (Forgejo/Komodo/etc.) or emit graph nodes — that is `state-resolver`'s job.

## Key files

- [src/intent.ts](src/intent.ts) — the authored intent types (`IntentSet` and friends).
- [src/inputs.ts](src/inputs.ts) — input shapes (`HostInput`, `CloudflareInput`, `EnvironmentInput`, `NotifyInput`, …).
- [src/needs.ts](src/needs.ts) — `resolveNeeds`, `Capability`/`Need`/`Plane`, `needKey`.
- [src/index.ts](src/index.ts) — public surface.

## How it fits

Stage 1 of intent → needs → desired-state. The `sdk` builds an `IntentSet` from a `deploy.config.ts`; `resolveNeeds` turns it into `Need`s; `state-resolver` assigns each need a catalog option and emits nodes.

## Conventions & gotchas

- Needs are intentionally provider-agnostic — keep concrete tech names out of this layer.
- Each need carries its `Plane`; downstream resolution and ordering rely on it. Co-located tests in [src/needs.test.ts](src/needs.test.ts). See [ARCHITECTURE.md](../../ARCHITECTURE.md).
