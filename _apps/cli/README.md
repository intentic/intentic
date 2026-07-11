# @intentic/cli

The **runnable product** — the `intentic` CLI (`bin: intentic`). It turns a local intent file into a
desired-state artifact and executes it, with no remote control plane required. Depends on
`@intentic/engine`, `@intentic/providers`, `@intentic/need-resolver`, `@intentic/state-resolver`, `@intentic/graph`.

## Local control plane

The "control plane" is two local git repos: an **intent** repo holding `deploy.config.ts`, and a
**desired-state** repo holding the generated artifact (`desired-state.json`) and the
execution record (`status.json`). `intentic init` scaffolds both.

## Commands

Built on [stricli](https://github.com/bloomberg/stricli) with generated `--help` / `--version`.

- `intentic init [--dir .]` — scaffold the `intent` and `desired-state` git repos (intent seeded
  with a starter `deploy.config.ts`).
- `intentic resolve [--config deploy.config.ts] [--out desired-state.json]` —
  load the intent, resolve it to a `DesiredStateGraph`, and write it, along with `.env.example` (the
  user-supplied secrets) and `.secrets.json` (the intentic-generated ones). No infra access.
- `intentic plan [--artifact desired-state.json]` — read-only preview of what `apply` would
  create/update.
- `intentic apply [--artifact desired-state.json] [--max-iterations 5]` — reconcile the artifact
  until state reads true, writing `status.json` beside it. Reads user-supplied secrets from `.env`
  beside the artifact (or the environment) and generates the platform admin secrets it owns (see
  below). On success it prints an **Access** summary and writes `access.md` beside the artifact: the
  URL, the `intentic` username, and the password (the generated value on stdout; a pointer to
  `.secrets.json` in the committed `access.md`) for Forgejo and Komodo, plus each app-environment URL.

## Secrets

Secrets split by who provides them:

- **User-supplied** (`source: env`) — credentials to systems intentic does **not** create:
  `HOST_SSH_KEY`, `CLOUDFLARE_API_TOKEN`, and each environment's `*_DATABASE_URL`. You set these in
  `.env` beside the artifact (or the ambient environment). The required set is more than what your
  `deploy.config.ts` names, so `resolve` derives it from the graph and writes `desired-state/.env.example`.
- **intentic-generated** (`source: generated`) — admin credentials for the services intentic itself
  provisions: `FORGEJO_ADMIN_PASSWORD`, `KOMODO_ADMIN_PASSWORD`, `KOMODO_WEBHOOK_SECRET`. `resolve`
  generates each one (shell-safe hex) the first time and persists it to gitignored
  `desired-state/.secrets.json`, reusing it forever after (`plan`/`apply` reuse it too; Forgejo/Komodo
  bake the password in on first init and won't re-key, so it must be stable). intentic **owns** this
  file — it's authoritative, so put platform keys here, not in `.env`; to pin your own value, edit
  `.secrets.json`. The Forgejo/Komodo password is what you log in with, as user `intentic`.

Both `.env` and `.secrets.json` are gitignored, so no secret lands in the PR-managed repo.

## Workflow

```sh
intentic init
cd intent && intentic resolve --out ../desired-state/desired-state.json
cp ../desired-state/.env.example ../desired-state/.env   # fill in the user-supplied values resolve listed
cd .. && intentic apply                                  # generates the platform secrets, prints the logins
```

> A `deploy.config.ts` imports `@intentic/sdk` + `@intentic/graph`, so the project it lives in must have
> them installed. `apply` reconciles the per-host platform (Forgejo/Komodo/runner, Cloudflare tunnel + DNS)
> as ordinary nodes in the artifact — a future "PR-managed" phase (a remote Forgejo watching the intent
> repo) would layer on top of this same flow.

## Key files

- [src/cli.ts](src/cli.ts) / [src/app.ts](src/app.ts) — the stricli app and command wiring.
- [src/init.ts](src/init.ts) / [src/resolve.ts](src/resolve.ts) / [src/apply.ts](src/apply.ts) — the `init`/`resolve`/`apply` commands (plan lives alongside resolve/apply).
- [src/artifact.ts](src/artifact.ts) — `readArtifact`/`writeArtifact`/`writeStatus` (the desired-state files).
- [src/secrets.ts](src/secrets.ts) / [src/generated-secrets.ts](src/generated-secrets.ts) — the user-supplied vs intentic-generated secret split.
- [src/output.ts](src/output.ts) — honors `INTENTIC_OUTPUT` (`text`/`json`/`ndjson`); maps `EngineEvent`s to the chosen format.
- [src/adopt.ts](src/adopt.ts) / [src/adopt-pipelines.ts](src/adopt-pipelines.ts) — push the intent/desired-state repos into Forgejo + wire Actions.
- [src/access.ts](src/access.ts) — the post-apply Access summary + `access.md`; [src/known-hosts.ts](src/known-hosts.ts) — TOFU host-key pinning.

## Conventions

- Runs the engine as the **only** place providers are constructed (via `createProviders`); it owns reading `.env` and generating `.secrets.json`.
- Subprocess-friendly: a backend can drive it and parse `INTENTIC_OUTPUT=ndjson`/`json` instead of scraping prose (the platform's `provision.ts` does exactly this).
- Co-located unit tests + a gated [src/cli.e2e.test.ts](src/cli.e2e.test.ts) (real infra, opt-in).

**Key exports:** `loadIntent`; `readArtifact` / `writeArtifact` / `writeStatus`; `scaffold`; the
`CONFIG_FILE` / `ARTIFACT_FILE` / `STATUS_FILE` constants. See [ARCHITECTURE.md](../../ARCHITECTURE.md).
