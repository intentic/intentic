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
- **Ownership by construction** — code and credentials never leave your machine; the platform stores only your identity and the sandbox's URL and sits off the command path. What runs on your machine is MIT on [GitHub](https://github.com/intentic/intentic), so you can verify it.
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

- **Read [AGENTS.md](AGENTS.md) first** — it holds the hard editing rules (no legacy/compat shims, no re-exports or aliases, let errors propagate, prefer `undefined`, early returns).
- **Edit `src/` directly.** Workspace packages expose an `@intentic/src` export condition, so cross-package imports resolve to source — no build step is needed between editing a lib and running a dependent test.
- **Tests are co-located:** `*.test.ts` (unit), `*.integration.test.ts` (temp trees, subprocesses, real git — a 60s budget instead of the 5s hang detector), and gated `*.e2e.test.ts` (real infra, opt-in). Run `pnpm test` (Turbo) or per-package `vitest`.
- **`pnpm verify` is the gate — run it before you finish, including from an agent worktree.** It is `pnpm typecheck` and then `pnpm test` — under a minute for all 45 packages, from a cold cache. Both emit every dependency's dist with `tsgo -b` first (`_tools/scripts/prepass.mjs`), so neither needs `pnpm build`, which cannot run under worktree isolation. It is also what CI decides main's health on, so a green run here is a green run there.
- **Tests are type-checked too, by `pnpm typecheck`, not by `pnpm build`.** A package that emits to `dist` excludes `*.test.ts` from its build config and re-includes it in `tsconfig.test.json`; a package that only type-checks uses one config for both. Adding a package with tests and no `typecheck` script fails the same script's coverage guard. The testing conventions this protects are in [AGENTS.md](AGENTS.md).
- **Each package is documented by its own README** — responsibilities, key files, gotchas. Start there when working inside one, and update it in the same commit as a change that dates it. That rule is the whole of how these stay true; [AGENTS.md](AGENTS.md#documentation) has the details, including the two parts of the page a tool parses.

## Bundled deployment engine (a tool, not the product)

This monorepo also contains a standalone **deployment engine** — a declarative, reconciling infrastructure tool driven by the `intentic deploy` command group (`init` · `resolve` · `plan` · `apply` · `destroy` · `adopt` · `restore` · …). It turns `i.have` / `i.want` intent into real self-hosted infrastructure on hosts you own.

It is **not part of the intentic product.** It is one of the many tools a specialized agent can reach for — no more a "feature" than `psql` or `docker` — and it lives in this repo only for convenience. Its walkthrough, capabilities, and known limits are documented separately in **[docs/deploy-engine.md](docs/deploy-engine.md)**.

## The release surface

**One repository — [github.com/intentic/intentic](https://github.com/intentic/intentic) — and nothing is
exported anywhere else.** A release is a tag on the commit CI already built, and two things hang off it:

- `_tools/scripts/publish-github.sh` — semantic-release's publishCmd, run once the `v<version>` tag it pushed is
  on the remote: a GitHub Release with the desktop installers and the machine-agent binaries attached. That
  Release is the anonymous download channel behind `curl https://intentic.dev/sync | sh`.
- `.github/workflows/npm-publish.yml` — triggered by that tag: builds the closure and publishes all 23 packages
  with provenance over npm's OIDC trusted publishing, so there is no npm token in this repo's CI at all.

This used to be an export to a separate public mirror repo, with a path manifest and a subset guard. When
development moved onto the same repository the mirror targeted, the export published over the development tree
instead of alongside it — `release: v1.0.0` took `.github/workflows`, `_platform/api` and `.githooks` with it. The
mirror, its manifest and its guard are gone; there is no second tree to keep in step.

## Architecture & contributing

[ARCHITECTURE.md](ARCHITECTURE.md) covers the platform / sandbox / workspace split, the ownership and trust model, the extension system, the agent-facing tooling (iq/lsp), and the bundled deployment engine.

For the shorter, picture-led version — the components, the vocabulary, and what to read first — read
**[docs/architecture/repo.md](docs/architecture/repo.md)**, or open the **Documentation** tile in the app. It
renders that map and every package's README as one browsable set, draws each package's size and neighbours from
the live package graph, and flags any page whose code has moved on since it was written.

## License

MIT
