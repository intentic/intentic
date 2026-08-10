# @intentic-app/prisma

The **database layer** — the Prisma schema, the generated client, and the migrations. Owns the Postgres data model and exposes the typed `PrismaClient` that [`@intentic-app/api`](../../_platform/api) imports. Prisma 7 with the `prisma-client` generator (output to `./generated`).

## Responsibilities

- Define the schema: the Better Auth tables (`User`/`Session`/`Account`/`Verification`), the sandbox registry (`Sandbox`/`SandboxMember` — connection token + announced `daemonUrl`; no liveness state), the free-trial meter (`TrialUsage`), and the creator pool (`Membership` — the Stripe mirror — the `ExtensionUseDay` ledger the revenue share is computed from, and the services economy: `Service` catalog rows, the `CreditSpend` daily meter, and the `ServiceRun` ledger provider earnings settle on).
- Generate the client and own the migration history.
- Provide nothing at runtime beyond the client — no business logic.

## Key files

- [schema.prisma](schema.prisma) — the data model (`@@map`ped to snake_case tables).
- [client.ts](client.ts) — the package entry (re-exports the generated client); `prisma.config.ts` — generator/datasource config.
- `generated/` — the generated Prisma client (git-ignored, built by `generate`); `migrations/` — ordered SQL + `migration_lock.toml`.

## Workflow

- `pnpm generate` — regenerate the client after editing `schema.prisma`.
- `pnpm migrate:dev` — create/apply a dev migration (`prisma migrate dev`).
- `pnpm migrate:deploy` — apply pending migrations (`prisma migrate deploy`, CI/prod/local startup).
- `pnpm studio` — Prisma Studio.
- `pnpm db:up` / `pnpm db:reset` (root) — start Postgres (docker compose, dev :5438) / wipe + recreate.

## Conventions & gotchas

- After any schema change, run `migrate:dev` (or at least `generate` when no migration is needed) **and** `pnpm build` before the API runs under `tsx`.
- One `SandboxConnection` per user (`userId @unique`); its `token` seeds the deterministic tunnel hostname and is the daemon's first-bind secret. `daemonUrl` is the only sandbox state the platform stores — written by the browser, never used for liveness (the browser probes the daemon directly).
- The connection token is stored **plaintext** for now — encryption is deferred. No infra/Claude secrets live here; those stay in the sandbox.
