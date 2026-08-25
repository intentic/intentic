# @intentic-app/api-contract

The single source of truth for the platform's API surface: the oRPC contract and its Zod schemas.

Consumed by both the backend ([`@intentic-app/api`](../../_platform/api), which `implement`s it) and the web client ([`@intentic-app/web`](../../_editor/web), which calls it). No codegen: the TypeScript source *is* the contract, so request/response types stay in lockstep across the wire.

## Responsibilities

- Define `apiContract`, the aggregate oRPC router (`me`, `sandbox`, `invite`, `desktop`, `pool`, `creator`, `push`, `admin`). `sandbox` includes the setup wizard's cloud lane (`cloudOptions`/`cloudProvision`): provider credentials are request-scoped inputs, never stored rows. `push` is the push relay's three-route handshake (register a device / release it / the daemon's sessionless send), the schema section in `schemas.ts` states the whole capability model. `admin` is the operator's read-only surface (overview, activation funnel, attention feed, cost meters, account directory + per-account support page), gated server-side by the `ADMIN_EMAILS` allowlist — see the api's `guards.ts requireAdmin`.
- Define the Zod schemas + inferred wire types (`ProjectSchema`/`Project`, `ServerSchema`/`Server`, `CloudflareStatusSchema`, `Repo` kinds, …).
- It contains **no** implementation: only the contract shapes both sides bind to.

## Key files

- [src/index.ts](src/index.ts): `apiContract` + public re-exports.
- [src/schemas.ts](src/schemas.ts): the Zod schemas and inferred types.

## How it fits

The seam between web and API. Add or change an endpoint here first; the API gets a type error until it `implement`s the new shape, and the web client gets the new method typed automatically.

## Conventions & gotchas

- Edit shapes here, never inline in a route or component: that's how the two sides stay in sync.
- Built before the API runs under `tsx` (it's an imported workspace package); run `pnpm build` after changes. Depends on `@orpc/contract` + Zod.
