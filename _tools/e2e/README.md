# @intentic-app/e2e

The browser smoke tier — Playwright against the whole stack, including the published daemon image.

It drives the real Vue SPA, the https API, Postgres, and the **published sandbox daemon**
(`ghcr.io/intentic/sandbox:stable`) in loopback (no-auth) mode — the same image a user's browser meets, so a
hand-mirrored `api-contract` schema that drifts from the daemon fails here.

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

Those tiers each declare the credentials they need with `e2eTier` (`_tools/testing/src/e2e.ts`) and stand down
naming what was missing, which is what lets CI ask for all of them at once. This suite declares nothing —
its requirement is a whole local stack, which no environment variable can announce.

## The one thing here that runs against production: `smoke:signin`

```sh
pnpm --filter @intentic-app/e2e smoke:signin https://app.intentic.dev
```

Everything above stubs Google out, and rightly so — a hermetic suite cannot depend on someone else's console.
The consequence was a blind spot with nothing behind it: whether Google still *accepts the deployed origin*
for our OAuth client is state that lives outside this repo, and when it stopped being true every Google button
on the site went dead while the entire pipeline stayed green. This is the check that goes red for that. It
loads the real login page in a real browser and asserts two things: Google's button reaches a pressable size
(a refused one still exists, at 0×0), and the fallback link that bypasses Google's frame is present.

It runs in the **platform deploy job**, straight after the health wait, so a deploy that shuts the front door
fails the job that rolled it. It is not part of `e2e:browser`: it needs the internet and a live deployment,
which is the opposite of what that suite is for.

Why a browser rather than a curl, given a browser costs a install step in a deploy job: the identical request
is answered **200 to curl and 400 to Chromium** — with matching origin, referer, user-agent, fetch-metadata
headers and the page's own `cas` value. An HTTP probe would have stayed green for the whole outage, which is
worse than no check at all. [smoke-signin.mjs](smoke-signin.mjs) carries the evidence.

## Not covered here (by design)

Real Google OAuth beyond the origin check above, and invites — platform unit tests cover their logic. Everything that needs
real infrastructure or real Discord lives in the gated tiers beside this one: `_deploy/cli/src/cli.e2e.test.ts`
(Cloudflare), `_sandbox/sandbox/src/discord.e2e.test.ts` (Discord + Whisper), and
`_deploy/cli/src/hermetic.e2e.test.ts` (the secret-free control-plane run). `ARCHITECTURE.md` → *What each tier
needs* is the table.

## Key files

- [specs](specs) — the browser journeys themselves.
- [smoke-signin.mjs](smoke-signin.mjs) — the post-deploy front-door check, the only thing here that meets real Google.
- [stack.ts](stack.ts) — bringing the whole stack up, including the published daemon image.
- [playwright.config.ts](playwright.config.ts) — projects, retries, and what runs where.
- [global-setup.ts](global-setup.ts) — what must exist before any spec runs.
- [fixtures](fixtures) — the data the journeys rest on.
