# @intentic-app/prisma

The **database layer**: the Prisma schema, the generated client, and the migrations. Owns the Postgres data model and exposes the typed `PrismaClient` that [`@intentic-app/api`](../../_platform/api) imports. Prisma 7 with the `prisma-client` generator (output to `./generated`).

## Responsibilities

- Define the schema: the Better Auth tables (`User`/`Session`/`Account`/`Verification`), the sandbox registry (`Sandbox`/`SandboxMember`, connection token, the derived 12-hex `tunnelId` the edge looks a sandbox up by, announced `daemonUrl`; no liveness state and no reachability state — a sandbox's grant is signed on demand, never stored), the hosted lane's machine record (`HostedMachine`, the one row that deliberately keeps the way back into a machine: the Fly app the platform created for a hosted sandbox, so it can wake, stop and destroy it) and its warm stock (`HostedPoolMachine`, each row holding the identity its app was named after at build, which a claim adopts into the sandbox row), the free-trial meter (`TrialUsage`), and the creator pool's credit economy (`Membership` (the Stripe mirror) the `CreditSpend` daily meter, the `Donation` ledger non-service extensions earn by, the `Service` catalog rows, the `ServiceRun` ledger provider earnings settle on, and the `ServiceWant` demand notes the public catalog aggregates, what agents looked for and no listing served), plus the off-sandbox half of that economy: the OAuth tables this platform issues MCP bearers from (`OauthApplication`/`OauthAccessToken`/`OauthConsent`, **casing is load-bearing**, see the schema's note) and `ServiceOffer`, the spend gate written down, whose `pending → approved` transition only an owner's browser session can make. Beside those, `AdminDailyStat`: one row per closed UTC day of platform counts (no ids, no emails), written by the api's daily rollup so the admin panel's trend lines survive the retention sweeps that take the raw rows.
- Generate the client and own the migration history.
- Provide nothing at runtime beyond the client: no business logic.

## Key files

- [schema.prisma](schema.prisma): the data model (`@@map`ped to snake_case tables).
- [client.ts](client.ts) (the package entry (re-exports the generated client); `prisma.config.ts`) generator/datasource config.
- `generated/` (the generated Prisma client (git-ignored, built by `generate`); `migrations/`) ordered SQL + `migration_lock.toml`.

## Workflow

- `pnpm generate`: regenerate the client after editing `schema.prisma`.
- `pnpm migrate:dev`: create/apply a dev migration (`prisma migrate dev`).
- `pnpm migrate:deploy`: apply pending migrations (`prisma migrate deploy`, CI/prod/local startup).
- `pnpm studio`: Prisma Studio.
- `pnpm db:up` / `pnpm db:reset` (root): start Postgres (docker compose, dev :5440) / wipe + recreate.

## Conventions & gotchas

- **A migration that has been applied is never edited.** Not the SQL, not the directory name. Prisma records a
  migration by NAME, so a database that already ran one never runs it again whatever the file later says: the
  edit reaches only databases created after it, and the two diverge in silence. `migrate deploy` reports "No
  pending migrations to apply" either way, because it compares names and does not read a single column. This is
  not hypothetical: `challenge` was added to `desktop_handoff` by editing its original migration, production
  never got the column, and every desktop sign-in answered an unhandled 500 for a week while CI: whose
  databases are all built fresh from the edited file: stayed green throughout. To change a schema, add a
  migration. Two things now enforce that, and both will fail rather than let it recur:
  [check-migrations.sh](../../_tools/scripts/check-migrations.sh) in the `migrations` CI job (the history is
  append-only, every new entry can apply to a database that has rows, and replaying it into an empty database
  reproduces `schema.prisma` exactly), and the api image, which diffs its own database against this schema at
  boot and refuses to serve if they disagree ([Dockerfile](../api/Dockerfile)).
- **A new column is nullable first, or it has a default.** `ADD COLUMN … NOT NULL` with no `DEFAULT` is the one
  statement Postgres accepts on an empty table and refuses on a used one, so writing it means writing a
  migration that can only ever apply where there is nothing in the table. `tunnelId` was written that way
  (`20260831120000_ingress_reachability`, "fresh-state reshape, pre-launch, no users"): green in CI, where every
  database is built fresh, and dead on the live one — and a FAILED migration is a wall, not a bad night, because
  `migrate deploy` then refuses every later migration too (P3009), so the api's boot chain stopped at its first
  step and the platform served nothing until it was repaired. Write the three steps instead: add the column
  nullable, `UPDATE` it to the value each existing row implies, then `ALTER COLUMN … SET NOT NULL`. A column no
  existing row implies a value for wants a `DEFAULT`, which fills them for you. Check 2 of the script above
  fails the pipeline on the shape rather than the deploy on the consequence.
- **Recovering a migration that failed in production** (`Error: P3009`, which the api container prints on repeat
  and the deploy job reports as "did not come back healthy"). Prisma rolls the statement back but keeps the
  failed row, and nothing pending applies until that row is resolved — no redeploy clears it. Fix it forward:
  write the repair as a NEW migration whose statements are guarded (`IF EXISTS` / `IF NOT EXISTS`, an `UPDATE …
  WHERE … IS NULL`) so it is a no-op on every database where the original succeeded, then, once that image is
  built, tell the live database to stop waiting on the name it will never run:
  `docker compose exec api bun node_modules/prisma/build/index.js migrate resolve --applied <migration_name>
  --config node_modules/@intentic-app/prisma/prisma.config.ts`, and redeploy. The name is recorded as done, the
  repair supplies what the name promised, and the boot-time schema diff is what proves the result before the api
  serves a request. `20260901190000_tunnel_id_backfill` is the worked example.
- Run the CI check locally before pushing a schema change: it is the same script:
  `pnpm db:up && MIGRATION_CHECK_DATABASE_URL=postgresql://app:app@localhost:5440/app bash _tools/scripts/check-migrations.sh`
  (any empty, disposable Postgres will do; it gets every migration replayed into it).
- After any schema change, run `migrate:dev` (or at least `generate` when no migration is needed) **and** `pnpm build` before the API runs under `tsx`.
- One `SandboxConnection` per user (`userId @unique`); its `token` seeds the deterministic tunnel hostname and is the daemon's first-bind secret. `daemonUrl` is the only sandbox state the platform stores: written by the browser, never used for liveness (the browser probes the daemon directly).
- The connection token is stored **plaintext** for now: encryption is deferred. No infra/Claude secrets live here; those stay in the sandbox.
