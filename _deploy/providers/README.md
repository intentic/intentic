# @intentic/providers

The real **Provider SPI implementations** the engine reconciles against: the only seam between a compiled graph and live infrastructure. Each provider does `read` (stateless introspection), `diff` (pure decision), and `apply` (create/update) over SSH/Docker and the Forgejo/Komodo/Cloudflare/Authentik HTTP APIs. Depends on [`@intentic/engine`](../engine) (SPI types) + [`@intentic/graph`](../graph).

## Responsibilities

- Implement one provider per `ResourceType` and assemble them into the `ResourceType → Provider` map (`createProviders`).
- Wrap external systems behind injectable API adapters (Forgejo, Komodo, Cloudflare, Authentik, Discord, Garage) so providers stay testable.
- Own the host/SSH transport, Docker operations, DNS/tunnel routes, repos/CI, deployments, backups/restore, and identity (users/orgs/teams).
- Validate node inputs with zod (`parseInputs`) before any I/O.

## Key files

- [src/index.ts](src/index.ts): `createProviders` + `ProviderDeps`; re-points to every `create*Provider` factory.
- `src/<kind>.ts`, one provider per kind: e.g. [src/network/cloudflare.ts](src/network/cloudflare.ts), [src/forgejo/forgejo.ts](src/forgejo/forgejo.ts), [src/komodo/komodo.ts](src/komodo/komodo.ts), [src/komodo/deployment.ts](src/komodo/deployment.ts), [src/network/cf-route.ts](src/network/cf-route.ts), [src/forgejo/ci.ts](src/forgejo/ci.ts).
- `src/<system>-api.ts`, HTTP adapters: [src/forgejo/forgejo-api.ts](src/forgejo/forgejo-api.ts), [src/komodo/komodo-api.ts](src/komodo/komodo-api.ts), [src/network/cloudflare-api.ts](src/network/cloudflare-api.ts), [src/auth/authentik-api.ts](src/auth/authentik-api.ts); fakes like [src/forgejo/forgejo-api.fake.ts](src/forgejo/forgejo-api.fake.ts).
- [src/backings](src/backings): `sshExecutor` (+ `SshExecutor`/`SshSession`); [src/api-validation.test.ts](src/api-validation.test.ts), input-validation coverage.
- The three **skeletons** every Docker-deploying provider is built from, so a new one is a spec rather than another copy of `read`/`diff`/`apply`/`delete`/`list`:
    - [src/core/backing-provider.ts](src/core/backing-provider.ts) — one container per node id (postgres, valkey, garage, authentik): a schema, a compose file, a readiness probe.
    - [src/core/instance-binding.ts](src/core/instance-binding.ts) — an app's slice INSIDE a backing (a database, an ACL user, a bucket), reached with `docker exec`.
    - [src/services/compose-service.ts](src/services/compose-service.ts) — one singleton stack per kind (the catalog services, signoz), diffed per compose service.
    - [src/core/host-files.ts](src/core/host-files.ts) is the writing the three share: rewritten config files, and the write-once `.env` whose two quoting layers are the part that used to be got wrong.

## How it fits

The infra boundary. `engine` defines the SPI and consumes a `Providers` map; this package is the production implementation of that map (the `cli` builds it via `createProviders`). Tests inject the fakes instead.

## Conventions & gotchas

- Providers are constructed from injected deps/adapters: never reach for ambient globals; pass a fake adapter in tests.
- Keep `diff` pure: do all reads in `read`, all mutations in `apply`. Stamp created resources (`intentic.id=<id>`) for future orphan detection. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
