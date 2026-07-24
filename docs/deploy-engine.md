# The intentic deployment engine

> **This is a bundled tool, not the intentic product.** The deployment engine is a standalone,
> declarative infrastructure tool that ships in this monorepo for convenience. It is one of the many
> tools a [specialized agent](../README.md) can reach for — no more part of the product than `psql` or
> `docker`. The product is the co-piloted agent workspace; this page documents the engine on its own terms.

**Infrastructure as intent.** You declare *what you have* — a server, a Cloudflare account — and *what you want* — an app. The split is lifecycle ownership: what you have is only read, never created or destroyed; what you want is the engine's to create, reconcile, prune, and destroy. The engine derives everything in between: it resolves your intent into a desired-state graph and runs a reconcile loop that drives your real infrastructure toward it, fixing drift until reality matches. A declarative, git-reviewed source of truth instead of clicking through dashboards.

You never wire the integrations yourself. You declare clean interfaces; the engine picks and glues the providers (git, CI, a registry, a deploy orchestrator, a tunnel, DNS) to satisfy them.

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

That is the entire input. You never name Forgejo, Komodo, a tunnel, or a DNS record — the engine derives them from your intent.

**2. Scaffold, resolve, preview, apply:**

```sh
intentic deploy init
```
```text
initialized intent (with deploy.config.ts) and desired-state
```

Put your secrets in `desired-state/.env` (with no authored `zone` on `i.have.cloudflare`, the Cloudflare token is read first, to discover your zone), then:

```sh
intentic deploy resolve
```
```text
resolved desired state (12 resources) → desired-state/desired-state.json
discovered Cloudflare zone "example.com" from the API token
set these in .env before apply (see .env.example): HOST_SSH_KEY, CLOUDFLARE_API_TOKEN, PRODUCTION_DATABASE_URL
generated these (stored in .secrets.json): FORGEJO_ADMIN_PASSWORD, KOMODO_ADMIN_PASSWORD
```

```sh
intentic deploy plan          # read-only preview of what apply will do
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
intentic deploy apply         # execute until state reads true
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

Re-run `intentic deploy apply` any time: it reads live state, fixes drift, and converges back to all-noop.

## What you declared vs. what the engine derived

Your `i.have.host` / `i.have.cloudflare` + `i.want.app` expand into the abstract *needs* an app requires — `source-control`, `docker-registry`, `infra-control`, `deployment-target`, `domain` — and the engine resolves the option catalog that meets them: Forgejo covers git + registry, Komodo the control plane, a Cloudflare Tunnel the domain. The result is one serializable desired-state graph, committed to git and reconciled. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full intent → needs → desired state → reconcile flow.

## Capabilities

- **Reconcile & self-heal** — `intentic deploy plan` classifies every node create/update/noop against live state; `intentic deploy apply` loops apply→read until the plan reads all-noop ("state reads true"). It is idempotent: drift is detected by reading reality and corrected on the next apply. Every resource is stamped (`intentic.id` + an `intentic.hash` of its authored inputs), so a config edit reads as an update even when the provider's own diff wouldn't see it.

- **Collection-oriented pruning** — providers enumerate their stamped resources live (`list`), so anything running that the intent no longer declares is detected as an orphan and pruned — even without the `.last-applied.json` baseline. Deletions never run silently: `apply` lists pending deletes and requires `--yes` (the scaffolded CI workflow passes it; the PR review is the confirmation).

- **Protected data** — stateful backings (`i.want.database` / `cache` / `auth` / `objectStorage`) are `protect`-ed by default: removing one from the config never deletes its volume until you author `protect: false` — a reviewed change. Protection is stamped on the container, so it holds even for orphans.

- **Teardown & targeting** — `intentic deploy destroy --yes` tears down everything the artifact declares in reverse dependency order (owned inventory — your host, your Cloudflare zone — is never touched). `--target <id,…>` on plan/apply reconciles just a slice and its dependencies.

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

- **Backups & restore** — point `i.have.backup` at a restic repo for scheduled, app-consistent snapshots of Forgejo + Komodo state; `intentic deploy restore --snapshot <id>` recovers them and re-applies:
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

- **Strict version locking** — every image the engine deploys is pinned `repo:tag@sha256:…` and recorded in `desired-state.json`. An upstream re-push of a tag cannot change what runs; a version moves only by a reviewed commit (Renovate opens the PR), and rollback is `git revert` + re-apply.

- **GitOps via `adopt`** — `intentic deploy adopt` pushes your `intent` and `desired-state` repos into the Forgejo it just stood up and wires Forgejo Actions, so from then on `git push` → resolve → apply runs in CI.

- **Notifications** — declare a Discord bot with `i.have.discord` and wire an app's `notify`; the engine owns the guild, channels, and webhooks, and posts CI/CD and reconcile summaries.

- **Pluggable source control** — the default is the self-hosted Forgejo stack. Declare `i.have.github` (or `i.have.gitlab`) instead and apps source from GitHub with GitHub Actions + GHCR — no Forgejo, no self-hosted runner. Komodo is unconditional: on every stack CI only builds and pushes the image, Komodo on your host rolls it out — so no host SSH key is ever handed to a hosted forge and the host stays outbound-only.

- **Machine-readable output** — every command honors `INTENTIC_OUTPUT` so a backend can drive the CLI and parse it instead of scraping prose. `text` (default) is the human output unchanged; `json` prints one result document at the end (`plan` → steps + orphans; `apply` → converged/iterations/steps/outputs/pruned/access); `ndjson` streams one JSON event per line as it runs (`node` start/done, `readiness`, `iteration`, `prune`, `orphan`, provider `log`) and closes with a `result` line. Known secret values are masked out of every stream. The `EngineEvent` type is exported from `@intentic/engine` for embedders.
  ```sh
  INTENTIC_OUTPUT=ndjson intentic deploy apply   # live event stream, then a final {"kind":"result",…}
  INTENTIC_OUTPUT=json   intentic deploy plan     # one JSON document: { steps, orphans }
  ```

## Getting started

```sh
pnpm install
pnpm build               # turbo build across packages

pnpm intentic deploy --help  # the deploy group: init · resolve · plan · apply · destroy · adopt · restore · secrets · deployments · logs
pnpm intentic deploy init       # scaffold the intent + desired-state repos
```

> Requires **Node 24** and **pnpm 11**. From this repo the CLI runs as `pnpm intentic deploy <command>` (the first call builds `dist`, then runs incrementally). The full authoring reference is [_tools/examples/deploy.config.ts](../_tools/examples/deploy.config.ts).

**Deploy against your own infra.** A filled artifact lives (gitignored) at `intent/` + `desired-state/`; `desired-state/.env` holds your `HOST_SSH_KEY` / `CLOUDFLARE_API_TOKEN` / `DISCORD_BOT_TOKEN` (regenerated as `.env.example` by `intentic deploy resolve`). Install the intent's deps once, then drive it:

```sh
(cd intent && pnpm install --ignore-workspace)
pnpm intentic deploy plan        # reads intent/deploy.config.ts + desired-state/ + its .env
```

## Cloudflare API token

The engine discovers your zone and account from the token alone (author `zone` on `i.have.cloudflare` to pin it and skip discovery at resolve), so the only Cloudflare setup is a token with:

- **Account → Cloudflare Tunnel → Edit**
- **Zone → DNS → Edit**
- **Zone → Zone → Read**

**Security posture:** each host gets one Cloudflare Tunnel that connects *outbound* — no inbound ports are opened. SSH is used only for the engine's own control operations, and host identity is verified on every connect: the engine trusts a host's key on first use, pins it in a committed `.known-hosts.json` lockfile, and refuses to connect if a host later presents a different key (so a key change is a reviewable diff, and the Forgejo CI apply verifies against the reviewed pin). The host-key store is injectable, so an embedded control plane can back it with its own per-tenant store.

## Known limitations

- **`plan` reads live infra** — the read-only preview queries the Cloudflare API and SSHes to the host to observe current state.
- **Tunnels and API-object resources are not orphan-scanned** — the docker-container families and stamped DNS records enumerate live; tunnels (whose teardown spans Cloudflare + the host) and resources living inside a platform service (repos, users, teams — they die with it) rely on the `.last-applied.json` baseline.

## Run on your own PC (no server)

No VPS? Because each host's Cloudflare Tunnel connects *outbound* (the host opens no inbound ports), the "host" can be your own laptop or desktop behind NAT. See [LOCAL.md](../LOCAL.md).
