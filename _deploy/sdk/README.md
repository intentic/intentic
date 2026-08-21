# @intentic/sdk

The **authoring surface** a user writes their `deploy.config.ts` against. A declaration uses `i.have.host` / `i.have.cloudflare` (the inventory you have) and `i.want.app` (what you want), wiring each app to its host/Cloudflare via `on` / `expose`. The split is lifecycle ownership, not requirements: intentic never creates or destroys a have, and owns a want end-to-end (create, reconcile, prune, destroy); requirements are the input fields, and may point at haves and wants alike. The support stack each app needs (git+CI, deploy orchestrator, runner, tunnel, routes) is *derived* by the resolvers, authors never name it. Depends on [`@intentic/graph`](../graph), [`@intentic/need-resolver`](../need-resolver), and [`@intentic/state-resolver`](../state-resolver).

## Responsibilities

- Provide the fluent `i.have.*` / `i.want.*` builders and capture them into an `IntentSet`.
- `defineIntent`, the authoring entry: declaration → `IntentSet` (what `intentic deploy resolve` consumes).
- `defineStack`, one-shot convenience: declaration → a single compiled `DesiredStateGraph`.
- Export the handle types (`Host`, `Cloudflare`, `App`, `Repo`, `Deployment`, …) used to wire declarations.

## Key files

- [src/index.ts](src/index.ts): `defineIntent` / `defineStack` (public entry).
- [src/handles.ts](src/handles.ts): the `i.have`/`i.want` builders and handle types.
- [src/stack.ts](src/stack.ts): assembles the `IntentSet` and runs the resolver pipeline.
- [src/\_\_fixtures\_\_](src/__fixtures__): the canonical `deploy.config.ts` + expected graph (snapshot).

## How it fits

The front door of the pipeline. A `deploy.config.ts` imports this + `@intentic/graph`; `defineIntent` yields an `IntentSet`; `need-resolver` then `state-resolver` turn it into the `DesiredStateGraph` the `engine` reconciles.

## Conventions & gotchas

- Authors import `env` (secret refs) from its true source, [`@intentic/graph`](../graph): **not** re-exported here.
- The fixtures are snapshot-tested ([src/index.test.ts](src/index.test.ts), [src/deploy.config.test.ts](src/deploy.config.test.ts)); changing builder output updates them. See [_tools/examples/deploy.config.ts](../../_tools/examples/deploy.config.ts) and [ARCHITECTURE.md](../../ARCHITECTURE.md).
