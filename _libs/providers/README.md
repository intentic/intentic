# @intentic/providers

The real **Provider SPI implementations** the engine reconciles against — the only seam between a compiled graph and live infrastructure. Each provider does `read` (stateless introspection), `diff` (pure decision), and `apply` (create/update) over SSH/Docker and the Forgejo/Komodo/Cloudflare/Authentik HTTP APIs. Depends on [`@intentic/engine`](../engine) (SPI types) + [`@intentic/graph`](../graph).

## Responsibilities

- Implement one provider per `ResourceType` and assemble them into the `ResourceType → Provider` map (`createProviders`).
- Wrap external systems behind injectable API adapters (Forgejo, Komodo, Cloudflare, Authentik, Discord, Garage) so providers stay testable.
- Own the host/SSH transport, Docker operations, DNS/tunnel routes, repos/CI, deployments, backups/restore, and identity (users/orgs/teams).
- Validate node inputs with zod (`parseInputs`) before any I/O.

## Key files

- [src/index.ts](src/index.ts) — `createProviders` + `ProviderDeps`; re-points to every `create*Provider` factory.
- `src/<kind>.ts` — one provider per kind: e.g. [src/cloudflare.ts](src/cloudflare.ts), [src/forgejo.ts](src/forgejo.ts), [src/komodo.ts](src/komodo.ts), [src/deployment.ts](src/deployment.ts), [src/cf-route.ts](src/cf-route.ts), [src/ci.ts](src/ci.ts).
- `src/<system>-api.ts` — HTTP adapters: [src/forgejo-api.ts](src/forgejo-api.ts), [src/komodo-api.ts](src/komodo-api.ts), [src/cloudflare-api.ts](src/cloudflare-api.ts), [src/authentik-api.ts](src/authentik-api.ts); fakes like [src/forgejo-api.fake.ts](src/forgejo-api.fake.ts).
- [src/backing-ssh.ts](src/backing-ssh.ts) — `sshExecutor` (+ `SshExecutor`/`SshSession`); [src/api-validation.test.ts](src/api-validation.test.ts) — input-validation coverage.

## How it fits

The infra boundary. `engine` defines the SPI and consumes a `Providers` map; this package is the production implementation of that map (the `cli` builds it via `createProviders`). Tests inject the fakes instead.

## Conventions & gotchas

- Providers are constructed from injected deps/adapters — never reach for ambient globals; pass a fake adapter in tests.
- Keep `diff` pure: do all reads in `read`, all mutations in `apply`. Stamp created resources (`intentic.id=<id>`) for future orphan detection. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
