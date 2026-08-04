# @intentic-app/e2e

The browser smoke tier: Playwright drives the real Vue SPA + https API + Postgres + the **published sandbox
daemon** (`registry.gitlab.com/radarsu/intentic/sandbox:stable`) running in loopback (no-auth) mode — the same
image a user's browser meets, so a hand-mirrored `api-contract` schema that drifts from the daemon fails here.

## What it proves

- **Auth-adjacent plumbing without Google**: a Prisma-seeded user + session with a self-signed Better Auth
  cookie (verified against `/api/auth/get-session` before any spec runs), and a cached fake Google ID token in
  `localStorage` so `sandboxClient` calls the daemon (the loopback daemon ignores the bearer).
- **Workspace upload journey** — picker → upload-diff → XHR upload → tree refetch → daemon disk read-back.
- **Automations journey** — create-dialog form → daemon manifest → listed back (the mirrored-schema drift guard).
- **Desktop-sync journey** — Enable → `/system/sync/pair` → the agent one-liner renders.

## Run

```sh
pnpm e2e:browser    # from the repo root: builds libs, then runs this package's playwright suite
```

Requirements: Docker (compose Postgres + the daemon image), Bun, and Playwright's Chromium
(`pnpm --filter @intentic-app/e2e exec playwright install chromium`). Everything already running (dev machine)
is reused; whatever the setup started is torn down, including the seeded rows. `SANDBOX_E2E_IMAGE` overrides
the daemon image (e.g. a source build).

**A dev-machine tier, not a CI one**, and that is what the separate task name records (turbo.json says it at
length): every server above is addressed on `localhost`, and every CI job here drives a docker-in-docker
*service* that publishes ports on its own namespace instead — `pnpm e2e` in the nightly used to include this
suite and could only ever fail it on `P1001` against `localhost:5440`. The tiers CI does run are
`pnpm e2e` (gated real-infra) and `pnpm e2e:hermetic` (no secrets, every MR).

Those tiers each declare the credentials they need with `e2eTier` (`_libs/testing/src/e2e.ts`) and stand down
naming what was missing, which is what lets CI ask for all of them at once. This suite declares nothing —
its requirement is a whole local stack, which no environment variable can announce.

## Not covered here (by design)

Real Google OAuth, Stripe billing and invites — platform unit tests cover their logic. Everything that needs
real infrastructure or real Discord lives in the gated tiers beside this one: `_apps/cli/src/cli.e2e.test.ts`
(Cloudflare), `_apps/sandbox/src/discord.e2e.test.ts` (Discord + Whisper), and
`_apps/cli/src/hermetic.e2e.test.ts` (the secret-free control-plane run). `ARCHITECTURE.md` → *What each tier
needs* is the table.
