# intentic

**Infrastructure as intent for self-hosters.** You declare *what you have* — a server, a Cloudflare account — and *what you want* — an app. The split is lifecycle ownership: what you have is only read, never created or destroyed; what you want is intentic's to create, reconcile, prune, and destroy. intentic derives everything in between: it resolves your intent into a desired-state graph and runs a reconcile loop that drives your real infrastructure toward it, fixing drift until reality matches. A declarative, git-reviewed source of truth instead of clicking through dashboards.

You never wire the integrations yourself. You declare clean interfaces; intentic picks and glues the providers (git, CI, a registry, a deploy orchestrator, a tunnel, DNS) to satisfy them.

## Demonstrate

**1. Declare what you have and what you want — one file:**

```ts
// intent/deploy.config.ts
import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    const host = i.have.host("host", {
        address: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
        },
    });
});
```

That is the entire input. You never name Forgejo, Komodo, a tunnel, or a DNS record — intentic derives them from your intent.

**2. Scaffold, resolve, preview, apply:**

```sh
intentic init
```
```text
initialized intent (with deploy.config.ts) and desired-state
```

Put your secrets in `desired-state/.env` (with no authored `zone` on `i.have.cloudflare`, the Cloudflare token is read first, to discover your zone), then:

```sh
intentic resolve
```
```text
resolved desired state (12 resources) → desired-state/desired-state.json
discovered Cloudflare zone "example.com" from the API token
set these in .env before apply (see .env.example): HOST_SSH_KEY, CLOUDFLARE_API_TOKEN, PRODUCTION_DATABASE_URL
generated these (stored in .secrets.json): FORGEJO_ADMIN_PASSWORD, KOMODO_ADMIN_PASSWORD
```

```sh
intentic plan          # read-only preview of what apply will do
```
```text
create   host            host
create   cloudflare      cf
create   forgejo         host-git
create   forgejo-runner  host-git-runner
create   komodo          host-deploy
create   tunnel          host-tunnel
create   cf-route        cf-git-example-com
create   cf-route        cf-deploy-example-com
create   cf-route        cf-app-example-com
create   repo            my-app-repo
create   ci              my-app.production-ci
create   deployment      my-app.production
```

```sh
intentic apply         # execute until state reads true
```
```text
converged in 2 iteration(s)

Access:
  Forgejo (git)  https://git.example.com
    user: intentic   password: (generated — see .secrets.json)
  Komodo (deploys)  https://deploy.example.com
    user: intentic   password: (generated — see .secrets.json)
  my-app.production  https://app.example.com
```

> Output above is illustrative; the resource count and ordering follow your intent.

**3. What those two `i.have` lines and one `i.want.app` stood up** — on your own server, with zero inbound ports:

- **Forgejo** — git + container registry, at `git.example.com`
- **Forgejo runner** — CI that builds and pushes your app image on every push
- **Komodo** — deploy orchestrator + UI, at `deploy.example.com`, rolling out new images
- **one Cloudflare Tunnel** — outbound-only; the host opens no ports
- **a proxied DNS route per hostname** — `git`, `deploy`, and your app's `app.example.com`
- **your app** — a repo seeded with CI/CD, built and deployed per environment

Re-run `intentic apply` any time: it reads live state, fixes drift, and converges back to all-noop.

## What you declared vs. what intentic derived

Your `i.have.host` / `i.have.cloudflare` + `i.want.app` expand into the abstract *needs* an app requires — `source-control`, `docker-registry`, `infra-control`, `deployment-target`, `domain` — and intentic resolves the option catalog that meets them: Forgejo covers git + registry, Komodo the control plane, a Cloudflare Tunnel the domain. The result is one serializable desired-state graph, committed to git and reconciled. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full intent → needs → desired state → reconcile flow.

## Capabilities

- **Reconcile & self-heal** — `intentic plan` classifies every node create/update/noop against live state; `intentic apply` loops apply→read until the plan reads all-noop ("state reads true"). It is idempotent: drift is detected by reading reality and corrected on the next apply. Every resource is stamped (`intentic.id` + an `intentic.hash` of its authored inputs), so a config edit reads as an update even when the provider's own diff wouldn't see it.

- **Collection-oriented pruning** — providers enumerate their stamped resources live (`list`), so anything running that the intent no longer declares is detected as an orphan and pruned — even without the `.last-applied.json` baseline. Deletions never run silently: `apply` lists pending deletes and requires `--yes` (the scaffolded CI workflow passes it; the PR review is the confirmation).

- **Protected data** — stateful backings (`i.want.database` / `cache` / `auth` / `objectStorage`) are `protect`-ed by default: removing one from the config never deletes its volume until you author `protect: false` — a reviewed change. Protection is stamped on the container, so it holds even for orphans.

- **Teardown & targeting** — `intentic destroy --yes` tears down everything the artifact declares in reverse dependency order (owned inventory — your host, your Cloudflare zone — is never touched). `--target <id,…>` on plan/apply reconciles just a slice and its dependencies.

- **Teams & people** — declare users and teams; intentic creates a Forgejo org + team and Komodo RBAC, and grants each team its role on the apps it manages:
  ```ts
  const alice = i.want.user("alice", { username: "alice", email: "alice@example.com" });
  const platform = i.want.team("platform", { members: [alice], komodo: "execute" });
  i.want.app("my-app", { on: host, expose: cf, teams: [{ team: platform, role: "write" }], environments: { /* … */ } });
  ```

- **Multi-environment apps** — each environment gets its own branch, domain, env, and deployment:
  ```ts
  environments: {
      staging:    { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
      production: { domain: "app.example.com",      branch: "main",    env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
  }
  ```

- **Observability** — declare a shared SignOz service and point apps at it; intentic injects its OTLP endpoint into every deployment:
  ```ts
  const obs = i.want.service("obs", { kind: "signoz", on: host, expose: cf, domain: "signoz.example.com" });
  i.want.app("my-app", { on: host, expose: cf, observe: obs, environments: { /* … */ } });
  ```

- **Backups & restore** — point `i.have.backup` at a restic repo for scheduled, app-consistent snapshots of Forgejo + Komodo state; `intentic restore --snapshot <id>` recovers them and re-applies:
  ```ts
  i.have.backup("backup", {
      repo: "s3:s3.amazonaws.com/my-bucket/intentic",
      password: env("RESTIC_PASSWORD"),
      credentials: { AWS_ACCESS_KEY_ID: env("AWS_ACCESS_KEY_ID"), AWS_SECRET_ACCESS_KEY: env("AWS_SECRET_ACCESS_KEY") },
  });
  ```

- **Guarded upgrades** — set `updatePolicy: "guarded"` on a host (with a backup declared) and every stateful-service image bump runs as a transaction: snapshot → recreate on the new image → health-gate → auto-rollback of image *and* data on failure.
  ```ts
  const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY"), updatePolicy: "guarded" });
  ```

- **Strict version locking** — every image intentic deploys is pinned `repo:tag@sha256:…` and recorded in `desired-state.json`. An upstream re-push of a tag cannot change what runs; a version moves only by a reviewed commit (Renovate opens the PR), and rollback is `git revert` + re-apply.

- **GitOps via `adopt`** — `intentic adopt` pushes your `intent` and `desired-state` repos into the Forgejo it just stood up and wires Forgejo Actions, so from then on `git push` → resolve → apply runs in CI.

- **Notifications** — declare a Discord bot with `i.have.discord` and wire an app's `notify`; intentic owns the guild, channels, and webhooks, and posts CI/CD and reconcile summaries.

- **Pluggable source control** — the default is the self-hosted Forgejo stack. Declare `i.have.github` (or `i.have.gitlab`) instead and apps source from GitHub with GitHub Actions + GHCR — no Forgejo, no self-hosted runner. Komodo is unconditional: on every stack CI only builds and pushes the image, Komodo on your host rolls it out — so no host SSH key is ever handed to a hosted forge and the host stays outbound-only.

- **Machine-readable output** — every command honors `INTENTIC_OUTPUT` so a backend can drive the CLI and parse it instead of scraping prose. `text` (default) is the human output unchanged; `json` prints one result document at the end (`plan` → steps + orphans; `apply` → converged/iterations/steps/outputs/pruned/access); `ndjson` streams one JSON event per line as it runs (`node` start/done, `readiness`, `iteration`, `prune`, `orphan`, provider `log`) and closes with a `result` line. Known secret values are masked out of every stream. The `EngineEvent` type is exported from `@intentic/engine` for embedders.
  ```sh
  INTENTIC_OUTPUT=ndjson intentic apply   # live event stream, then a final {"kind":"result",…}
  INTENTIC_OUTPUT=json   intentic plan     # one JSON document: { steps, orphans }
  ```

## Getting started

```sh
pnpm install
pnpm build               # turbo build across packages

pnpm intentic --help     # the CLI (bin: intentic) — init · resolve · plan · apply · destroy · adopt · restore
pnpm intentic init       # scaffold the intent + desired-state repos
```

> Requires **Node 24** and **pnpm 11**. From this repo the CLI runs as `pnpm intentic <command>` (the first call builds `dist`, then runs incrementally). The full authoring reference is [examples/deploy.config.ts](examples/deploy.config.ts).

## Develop locally

A single `.env` at the repo root drives the platform (only the api reads it; web/site bake their dev config into `src`). Copy the template and fill in Google credentials — everything else degrades with a startup warning:

```sh
cp .env.example .env      # set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (each var is documented in .env.example)
pnpm db:up                # Postgres on :5440 (docker-compose.yml) + prisma migrate
pnpm dev                  # turbo: api on https://localhost:6480, web on https://localhost:47145, the site, …
```

Dev serves over HTTPS via the committed `@intentic-app/localhost-https` cert (Google FedCM One Tap refuses `http://localhost`).

- **Sandbox daemon (optional).** To run the daemon outside its container, add its creds to the same root `.env` — see the `# Sandbox daemon` section of `.env.example` (`ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN`, … — all optional) — then `pnpm --filter @intentic/sandbox dev`.
- **CLI deploys against your own infra.** A filled artifact lives (gitignored) at `intent/` + `desired-state/`; `desired-state/.env` holds your `HOST_SSH_KEY` / `CLOUDFLARE_API_TOKEN` / `DISCORD_BOT_TOKEN` (regenerated as `.env.example` by `intentic resolve`). Install the intent's deps once, then drive it:
  ```sh
  (cd intent && pnpm install --ignore-workspace)
  pnpm intentic plan        # reads intent/deploy.config.ts + desired-state/ + its .env
  ```

## Run on your own PC (no server)

No VPS? Because each host's Cloudflare Tunnel connects *outbound* (the host opens no inbound ports), the "host" can be your own laptop or desktop behind NAT. One command bootstraps a Docker-in-Docker host on your machine, points intentic at it over SSH like any server, and stands up the whole stack — apps reachable through your Cloudflare account, zero inbound ports on your PC:

```sh
CLOUDFLARE_API_TOKEN=… INTENTIC_ZONE=example.com ./scripts/intentic-local.sh up
```

See [LOCAL.md](LOCAL.md) for prerequisites and details.

## Cloudflare API token

intentic discovers your zone and account from the token alone (author `zone` on `i.have.cloudflare` to pin it and skip discovery at resolve), so the only Cloudflare setup is a token with:

- **Account → Cloudflare Tunnel → Edit**
- **Zone → DNS → Edit**
- **Zone → Zone → Read**

**Security posture:** each host gets one Cloudflare Tunnel that connects *outbound* — no inbound ports are opened. SSH is used only for intentic's own control operations, and host identity is verified on every connect: intentic trusts a host's key on first use, pins it in a committed `.known-hosts.json` lockfile, and refuses to connect if a host later presents a different key (so a key change is a reviewable diff, and the Forgejo CI apply verifies against the reviewed pin). The host-key store is injectable, so an embedded control plane can back it with its own per-tenant store.

## Known limitations

- **`plan` reads live infra** — the read-only preview queries the Cloudflare API and SSHes to the host to observe current state.
- **Tunnels and API-object resources are not orphan-scanned** — the docker-container families and stamped DNS records enumerate live; tunnels (whose teardown spans Cloudflare + the host) and resources living inside a platform service (repos, users, teams — they die with it) rely on the `.last-applied.json` baseline.

## Packages

A pnpm + Turbo monorepo (`_*/*` workspaces). The libraries form the intent → needs → desired-state → reconcile pipeline; the apps are the runnable products.

| Package | Path | What it does |
|---------|------|--------------|
| `@intentic/graph` | [_libs/graph](_libs/graph) | Product-agnostic desired-state IR + `compile`; refs, secrets, readiness. The base everything builds on. |
| `@intentic/resources` | [_libs/resources](_libs/resources) | The closed `ResourceType` vocabulary + each kind's `OUTPUTS`. |
| `@intentic/need-resolver` | [_libs/need-resolver](_libs/need-resolver) | Authored intent shapes → abstract `Capability`/`Need` on a `Plane`. |
| `@intentic/state-resolver` | [_libs/state-resolver](_libs/state-resolver) | Needs → a `DesiredStateGraph`, choosing catalog options and emitting nodes. |
| `@intentic/sdk` | [_libs/sdk](_libs/sdk) | The authoring surface: `defineIntent`/`defineStack`, `i.have`/`i.want`. |
| `@intentic/engine` | [_libs/engine](_libs/engine) | Stateless `plan`/`apply`/`reconcile` over the Provider SPI. |
| `@intentic/providers` | [_libs/providers](_libs/providers) | Real SPI impls: SSH/Docker, Cloudflare, Forgejo, Komodo, Authentik. |
| `@intentic/sandbox-contract` | [_libs/sandbox-contract](_libs/sandbox-contract) | oRPC wire contract for the sandbox daemon, shared by the daemon and its browser client. |
| `@intentic/scaffold` | [_libs/scaffold](_libs/scaffold) | Intent-repo skeleton + deploy.config managed-region render/parse, used by `init` and the sandbox daemon. |
| `@intentic/cli` | [_apps/cli](_apps/cli) | The `intentic` CLI — `init`/`resolve`/`plan`/`apply`/`adopt`/`restore`. |
| `@intentic/sandbox` | [_apps/sandbox](_apps/sandbox) | Per-project AI-agent dev daemon image (Claude Agent SDK); the browser drives it directly over its own Cloudflare tunnel. |
| `@intentic/sync` | [_apps/sync](_apps/sync) | Local background agent keeping a directory bidirectionally in sync with a remote sandbox over its HTTP API. |
| `@intentic/tsconfig` | [_tools/tsconfig](_tools/tsconfig) | Shared TypeScript base configs. |

## Working in this repo (for agents)

- **Read [CLAUDE.md](CLAUDE.md) first** — it holds the hard editing rules (no legacy/compat shims, no re-exports or aliases, let errors propagate, prefer `undefined`, early returns).
- **Edit `src/` directly.** Workspace packages expose an `@intentic/src` export condition, so cross-package imports resolve to source — no build step is needed between editing a lib and running a dependent test.
- **Layering is acyclic:** `graph` → (`resources`, `need-resolver`) → (`state-resolver`, `engine`) → (`sdk`, `providers`) → `cli`. Import from the true source package, never re-export through another.
- **Tests are co-located:** `*.test.ts` (unit), `*.engine.test.ts` (engine integration), and gated `*.e2e.test.ts` (real infra, opt-in). Run `pnpm test` (Turbo) or per-package `vitest`.
- Each package has its own README with its responsibilities, key files, and gotchas — start there when working inside one.

## Architecture & contributing

[ARCHITECTURE.md](ARCHITECTURE.md) covers the package layout, the intent-driven flow, the control plane vs application plane split, and the maintainer workflows — local end-to-end testing and the `demo:up` stand-up.

## License

MIT
