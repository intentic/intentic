# Plan: demo bootstraps into the repo's real `desired-state/` so `intentic adopt` works with defaults

## Context

The `intentic adopt` command (already implemented — [adopt.ts](_apps/cli/src/adopt.ts),
[app.ts](_apps/cli/src/app.ts)) pushes the local `intent/` and `desired-state/` repos to the provisioned
Forgejo. Run from the repo root with no flags, it reads the artifact at `desired-state/desired-state.json`,
finds the `forgejo` node, and loads the Forgejo admin password from `desired-state/.secrets.json`.

Running `pnpm intentic adopt` failed with `forgejo admin password (generated secret FORGEJO_ADMIN_PASSWORD)
is not available`. Root cause: the platform is bootstrapped via the **demo** (`pnpm demo:up`), which scaffolds
and runs `resolve`/`apply` inside a throwaway `mkdtemp(/tmp/intentic-demo-XXX)` workspace
([demo.ts:215](_apps/cli/src/demo.ts#L215)). The real `FORGEJO_ADMIN_PASSWORD` that bootstrapped Forgejo
therefore lives at `/tmp/.../desired-state/.secrets.json`, while the repo-root `desired-state/` holds a stale,
secret-less artifact. `adopt` (default repo-root paths) can't find the matching password.

The repo root already reserves `/intent`, `/desired-state`, `/.demo` as gitignored scratch dirs (root
`.gitignore`) — exactly where the demo should write. **Goal:** point the demo at the repo-root `intent/` and
`desired-state/` so `.secrets.json` (and the artifact it matches) land there, letting `pnpm intentic adopt`
run with no flags right after `pnpm demo:up`.

## Approach

Edit [_apps/cli/src/demo.ts](_apps/cli/src/demo.ts) only.

### 1. `up()` — use the repo root as the workspace
- Replace `const workspace = await mkdtemp(join(tmpdir(), "intentic-demo-"));`
  ([demo.ts:215](_apps/cli/src/demo.ts#L215)) with `const workspace = repoRoot;`.
- Everything downstream already derives from `workspace`: `configPath`/`artifactPath`
  ([demo.ts:216-217](_apps/cli/src/demo.ts#L216-L217)), `init --dir workspace`
  ([demo.ts:240](_apps/cli/src/demo.ts#L240)), the `.env` write
  ([demo.ts:242](_apps/cli/src/demo.ts#L242)), and `readGeneratedSecrets(join(workspace, "desired-state"))`
  ([demo.ts:250](_apps/cli/src/demo.ts#L250)). So `resolve`/`apply` write the artifact, status, access, and
  `.secrets.json` straight into the repo-root `desired-state/`.
- `init` re-scaffolds and overwrites `intent/deploy.config.ts` etc. — fine: these are gitignored scratch dirs
  and the demo writes its own config right after. `git init`/`pnpm install` over the existing dirs are no-ops.

### 2. `down()` — stop deleting the workspace (it is now the repo root)
- Remove the `if (state.workspace !== undefined) { await rm(state.workspace, ...) }` block
  ([demo.ts:360-362](_apps/cli/src/demo.ts#L360-L362)) — with `workspace === repoRoot` this would delete the
  entire monorepo. `down` keeps tearing down the host container, tunnel, and DNS, and still removes the
  `.demo` state dir ([demo.ts:363](_apps/cli/src/demo.ts#L363)).
- Leaving `intent/`/`desired-state/` in place is intentional: `.secrets.json` persists so a subsequent
  `demo up` re-bootstraps Forgejo with the same admin password, and `adopt` can run after teardown. They are
  gitignored; `rm -rf intent desired-state` resets them manually if a clean slate is wanted.

### 3. Cleanup + closing banner
- Drop the now-unused `mkdtemp` and `tmpdir` imports ([demo.ts:2,4](_apps/cli/src/demo.ts#L2)); keep `mkdir`
  (used for `stateDir`) and `rm` (still used for `stateDir`).
- The closing banner ([demo.ts:285-307](_apps/cli/src/demo.ts#L285-L307)) already prints the workspace paths;
  add a line suggesting `pnpm intentic adopt` now that the secrets live in the default location.

## Verification

- `pnpm demo:up` → confirm `desired-state/.secrets.json` exists at the repo root with
  `FORGEJO_ADMIN_PASSWORD` (and `desired-state/desired-state.json` is the freshly-applied artifact).
- `pnpm intentic adopt` (no flags) → succeeds: creates `intentic/intent` and `intentic/desired-state` in
  Forgejo and pushes `main` (verify in `https://git.intentic.dev` or local `http://127.0.0.1:3000`).
  Requires the public Forgejo DNS to be live (the demo banner notes it may take ~1 min after `up`).
- `pnpm demo:down` → host container, tunnel, and DNS removed; repo-root `intent/`/`desired-state/` remain
  intact (the monorepo is NOT deleted).
- Existing tests unaffected (demo.ts is a dev harness, not under test); `pnpm --filter @intentic/cli test`
  still green.
