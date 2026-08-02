# intentic

**An IDE for your agents. A window for you.** One workspace, two kinds of operator. intentic turns a generic coding assistant into a *specialized agent* — an autonomous employee with its own sandbox on hardware you own: its dev-tools really installed, wired to the systems it operates, its context curated for one job. Everywhere else the prompt is the only layer you can change; here every layer of that environment is visible and yours to edit. Run one, or ten in parallel, from any browser. Works with Claude Code, Codex, Grok, Kimi Code, and Gemini, on your own subscription.

## Co-piloted, not fire-and-forget

An autonomous agent still needs a human in the loop. AI has to have its context configured, its work supervised, and its riskier calls approved — so every agent in intentic is **co-piloted**. That is what the workspace is *for*: the IDE surfaces (file tree, Monaco editor, diff review, terminals) and the observability surfaces (a fleet board of every run, plan mode by default, per-edit permission modes, a changes-review panel, full transcripts) exist so you can configure an agent, watch it work, drive it when you want, and approve what lands. Autonomy with the wheel in your hands.

## What you get

- **A fleet of specialized agents** — each in its own sandbox on a machine you own (laptop, workstation, VPS), reached from your browser over a private Cloudflare tunnel. One agent per role; Pro runs a whole team.
- **A real workspace, not a chat box** — a file tree, a Monaco editor, terminals that survive reconnects, live preview panels, and workspace search.
- **Plan-and-review by default** — agents propose before they act; every change is a diff you land or discard; environment changes need your explicit approval.
- **Capabilities** — wire an agent into GitHub, databases, Sentry, Stripe, SSH hosts, MCP servers, Claude plugins, and more, a click each. Credentials stay inside the sandbox.
- **Automations** — wake an agent on a schedule, a webhook, or a live event (a push, an alert, a payment, an email), each run leaving a transcript.
- **Ownership by construction** — code and credentials never leave your machine; the platform stores only your identity and the sandbox's URL and sits off the command path. What runs on your machine is MIT on [GitHub](https://github.com/radarsu/intentic), so you can verify it.
- **Your subscriptions, your hardware, a flat fee** — each agent runs on your own Claude, ChatGPT, or SuperGrok plan; intentic never meters your model usage.

## How it runs

Sign in with Google, name a sandbox, and paste one command on the machine that should host it. The command starts the sandbox daemon and an outbound-only tunnel; the workspace opens the moment the daemon reports in. From there you specialize the agent — install its tools, connect its systems, curate its context — then give it work and review what it does.

The product is three parts, all in this monorepo: a thin **platform** (identity + billing + the sandbox's URL), the per-user **sandbox** daemon (where the agent and your code actually live), and the browser **workspace**. See [ARCHITECTURE.md](ARCHITECTURE.md) for how they fit together and why the platform can't reach your code.

## Develop locally

A single `.env` at the repo root drives the platform (only the api reads it; web/site bake their dev config into `src`). Copy the template and fill in Google credentials — everything else degrades with a startup warning:

```sh
pnpm install
cp .env.example .env      # set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (each var is documented in .env.example)
pnpm db:up                # Postgres on :5440 (docker-compose.yml) + prisma migrate
pnpm dev                  # turbo: api on https://localhost:6480, web on https://localhost:47145
```

Dev serves over HTTPS via the committed `@intentic-app/localhost-https` cert (Google FedCM One Tap refuses `http://localhost`).

- **Sandbox daemon (optional).** To run the daemon outside its container, add its creds to the same root `.env` — see the `# Sandbox daemon` section of `.env.example` (`ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN`, … — all optional) — then `pnpm --filter @intentic/sandbox dev`.

> Requires **Node 24** and **pnpm 11**.

## Working in this repo (for agents)

- **Read [CLAUDE.md](CLAUDE.md) first** — it holds the hard editing rules (no legacy/compat shims, no re-exports or aliases, let errors propagate, prefer `undefined`, early returns).
- **Edit `src/` directly.** Workspace packages expose an `@intentic/src` export condition, so cross-package imports resolve to source — no build step is needed between editing a lib and running a dependent test.
- **Tests are co-located:** `*.test.ts` (unit), `*.engine.test.ts` (engine integration), and gated `*.e2e.test.ts` (real infra, opt-in). Run `pnpm test` (Turbo) or per-package `vitest`.
- **`pnpm typecheck` is the gate — run it before you finish, including from an agent worktree.** It emits every dependency's declarations with `tsgo -b` first (`_tools/scripts/typecheck.mjs`), so it needs nothing from `pnpm build`, which cannot run under worktree isolation. It is also what CI decides main's health on, so a green run here is a green run there.
- **Tests are type-checked too, by `pnpm typecheck`, not by `pnpm build`.** A package that emits to `dist` excludes `*.test.ts` from its build config and re-includes it in `tsconfig.test.json`; a package that only type-checks uses one config for both. Adding a package with tests and no `typecheck` script fails the same script's coverage guard. The testing conventions this protects are in [AGENTS.md](AGENTS.md).
- Each package has its own README with its responsibilities, key files, and gotchas — start there when working inside one.

## Bundled deployment engine (a tool, not the product)

This monorepo also contains a standalone **deployment engine** — a declarative, reconciling infrastructure tool driven by the `intentic deploy` command group (`init` · `resolve` · `plan` · `apply` · `destroy` · `adopt` · `restore` · …). It turns `i.have` / `i.want` intent into real self-hosted infrastructure on hosts you own.

It is **not part of the intentic product.** It is one of the many tools a specialized agent can reach for — no more a "feature" than `psql` or `docker` — and it lives in this repo only for convenience. Its walkthrough, capabilities, and known limits are documented separately in **[docs/deploy-engine.md](docs/deploy-engine.md)** (and [LOCAL.md](LOCAL.md) for running it against your own PC).

## The public mirror

Everything that runs on the user's machine is published as MIT source at
**[github.com/radarsu/intentic](https://github.com/radarsu/intentic)** — the sandbox, the CLIs, the desktop
app, the extensions, and the libs they stand on. The platform half of this repo (`_apps/{api,web,site,demo}`
and its libs) stays here.

It is a **snapshot per release, not a history mirror**: the release job materialises the public path set into a
scratch tree and lands it as one commit tagged `v<version>`, so nothing about a file's past is ever exported
and no force-push is ever needed. Three files carry the whole mechanism:

- `_tools/scripts/public.sh` — the manifest: what goes out, what is pruned, and the overlay of files the mirror
  has that this repo doesn't (its README, its root `package.json`, its GitHub Actions workflow).
- `_tools/scripts/publish-github.sh` — the export, run from `release-prepare.sh`: commit, tag, GitHub Release
  with the installers and machine-agent binaries attached.
- `_tools/scripts/verify-mirror.sh` — the guard, run by the `mirror:verify` CI job on every merge request:
  materialise, reconcile the subset lockfile, install frozen, type-check. **A public package that grows a
  workspace dependency on a private one fails here**, which is the one failure mode a subset has and this
  repo cannot see.

The pushed tag is also what publishes to npm: GitHub Actions builds the closure and publishes all 23 packages
with provenance over npm's OIDC trusted publishing, so there is no npm token in this repo's CI at all.

## Architecture & contributing

[ARCHITECTURE.md](ARCHITECTURE.md) covers the platform / sandbox / workspace split, the ownership and trust model, the extension system, the agent-facing tooling (iq/lsp), and the bundled deployment engine.

For the shorter, picture-led version — one page per package, mostly diagrams and charts — read
**[docs/architecture/repo.md](docs/architecture/repo.md)**, or open the **Documentation** tile in the app, which
renders the same files and flags any page whose code has moved on since it was written.

## License

MIT
