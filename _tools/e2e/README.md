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
pnpm e2e            # from the repo root: builds libs, then runs this package's playwright suite
```

Requirements: Docker (compose Postgres + the daemon image), Bun, and Playwright's Chromium
(`pnpm --filter @intentic-app/e2e exec playwright install chromium`). Everything already running (dev machine)
is reused; whatever the setup started is torn down, including the seeded rows. `SANDBOX_E2E_IMAGE` overrides
the daemon image (e.g. a source build from the sibling `intentic` repo).

## Not covered here (by design)

Real Google OAuth, Stripe billing, invites (platform unit tests cover their logic), and everything that needs
real infrastructure or Discord — those live in the `intentic` repo's gated e2e tiers.
