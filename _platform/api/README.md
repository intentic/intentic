# api

The platform's HTTP server (`@intentic/api`): sign-in, the registry of sandboxes and their addresses, hosted Fly machines, the hosted plan and the agent wallet.

```mermaid
flowchart LR
    spa["web SPA"] -- "/rpc · /api/auth" --> api(["api"])
    daemon["Sandbox daemon"] -- "claim · announce" --> api
    ingress["ingress"] -- "/api/reachability/:id" --> api
    stripe["Stripe"] -- "webhook" --> api
    api --> db[("Postgres")]
    api --> fly["Fly Machines API"]
    api --> cf["Cloudflare DNS<br/>loopback certs"]
```

- A registry, never a relay: a daemon announces the address it answers on, and the browser talks to it directly.
  The api stores who owns which sandbox and where it answers; traffic between browser and sandbox never passes
  through it.
- Reachability is a signed grant. The api holds the Ed25519 private key (`INGRESS_SIGNING_KEY`), the edge holds only
  the public half, and deleting the sandbox row revokes it (`src/sandbox/reachability.ts`).
- A hosted machine is reached only down the tunnel it dials to the edge, with the grant and edge address
  `hostedMachineConfig` puts in its environment; it declares no Fly service, so nothing on Fly routes to it. One that
  dials nothing (stopped, booting) answers the edge's `no-tunnel` verdict, and the editor's wake starts it, re-applying
  its config first when the grant or address is missing or stale (`wakeHosted`). A machine configured while it still
  declared the old replay front door keeps that service until its next config apply, which drops it; it is inert until
  then, since the app has no public address and the edge replays nothing. `GET /api/reachability/:id` answers
  `{ ok, lane }` with no app name: today's edge reads only the status, and `lane` stays for an edge build from before
  replay went, which replays anything not named `tunnel`.
- The hosted lane is one Fly app, machine and volume per sandbox, named `<HOSTED_APP_PREFIX>-<id>`. The background
  jobs started in `src/main.ts` (warm pool, meter, abuse watch, builds, health) take a Postgres advisory lock per run
  (`src/jobs-lock.ts`), so two replicas never double-bill or double-provision.
- A hosted image change goes through the state gate (`src/sandbox/hosted/gate/state-gate.ts`), the hosted half of
  the stored-state promise in [COMPATIBILITY.md](../../COMPATIBILITY.md#stored-data). A restart, a rebuild, a rollback,
  or a wake that heals a stale tunnel first runs the target image's planner (`state-plan.js`) over the machine's own
  volume. It runs in a probe: the same machine with its daemon replaced by a sleep and none of the platform's
  credentials in its environment, asked through Fly's exec once it reads `started`. Fly has no read-only volume mount
  and no machine without a network, so unlike `ic`'s probe (`:ro`, `--network none`) this one mounts the volume
  read-write and can reach the internet; the planner it runs has no write mode, and it is the only command the probe
  runs. A target named by a tag is pinned to a digest first (the registry's, else the one Fly resolved for the probe),
  so the probe and the switch run the same image. A plan that says a conversion would fail, or a planner that crashed
  or answered what is not a plan, keeps the machine on its version and answers the owner in plain words (a restart's
  `CONFLICT`, a build's error). No plan to be had (an image older than the planner, a plan format newer than this
  platform reads, a probe that never comes up) lets the change go ahead as before the gate. The whole gate, probe to
  the new daemon's verdict, holds the app's advisory lock (`hosted-app-lock.ts`): a restart or rebuild waits for another
  change to the machine, a wake that meets one answers `CONFLICT` and is retried by the browser, and the hour meter's
  stop leaves a machine mid-change to its next tick. A resize, a move and a restore from the trash keep the running
  digest, so they have nothing to convert.
- A new version is kept once its daemon says it came up, not once Fly says it started (`gate/daemon-health.ts`). The
  gate asks the daemon's own `/health` through Fly's exec (`/usr/bin/curl -sf` on port 8787, the probe `ic` runs) until
  `boot.ready` with `state.journal` not open, and waits for the sandbox to check in (its announce moving `lastSeenAt`):
  three minutes to answer, ten once the journal was seen open. A version that does not start, exits after starting
  (Fly's restarts included), reads stopped, reports its journal `failed`, never commits it, never answers or never
  checks in is put back on the config and digest it had and started there, and the owner reads why (`HostedImageKept`,
  a restart's `BAD_GATEWAY`). The version put back is started without the wait: it is the one that ran. A rollback that
  fails is logged at error with both images and stamped on the machine's row (`strandedAt`), and the health sweep
  reports and mails it until the sandbox checks in again.
- An image the gate could not judge is on trial (`unprovenImage`): a rebuild applied to a stopped machine, or a version
  whose machine was stopped from outside while its daemon was waited for (a clean exit or a stop someone asked Fly for;
  a crash is not that). Its next start, a wake (`startOnTrial`) or a restart that keeps the digest, runs the same wait,
  and goes back to the image kept before it when the daemon does not come up.
- The machine's row keeps the way back (`gate/gate-row.ts`): an image change that takes records the pinned image it
  replaced and the overlay recipe that image carried (`previousImage`, `previousEnvironmentHash`), and the sandbox list
  says so (`canRollBack`). `hostedRollback` is owner-only and needs nothing of the daemon: it stops the machine, settles
  its stretch and switches to the kept image through the same gate and wait, keeping the image it left as the way
  forward, so a second press goes forward again. It records the platform digest it left (`skippedDigest`: the stock
  image's, or the left overlay's base), and a restart or a wake's heal does not move the machine onto it, nor rebuild an
  overlay on it, while `:stable` still resolves to it. No volume snapshot is taken or restored: the older build's own
  boot restores what the newer one had journaled.
- An overlay's base is a digest, never the tag's string (`build/hosted-build.ts`), since `HOSTED_IMAGE` is the moving
  `:stable`. A build pins its `FROM` to `<tag>@<digest>` as the tag resolves when it starts and keeps that digest
  (`baseDigest`, on the build, the machine and a trashed machine's row). "Already built", "reusable" and "the base
  moved" compare it with what the tag resolves to now, so "Restart & update" on an overlay machine rebuilds the approved
  recipe once `:stable` has moved. An overlay whose base digest was never kept reads as moved and is rebuilt once.
- The routes that change a machine and wait for it (restart, rollback, rebuild, wake, provision, tier change) lift
  Bun's per-request idle timeout (10s by default), which would otherwise close the request with no answer while the
  change went on.
- A daemon's announce may name its `version` (semver, at most 64 characters). It is stored on the sandbox row
  (`daemonVersion`), and an announce that names none, or something else, clears it.
- `src/config.ts` is the one config schema; each field is an env var in SCREAMING_SNAKE. A lane whose credential is
  unset (Stripe, APNs, trial keys, Fly) is switched off rather than failing the boot.
- Bun runs the TypeScript source; there is no build. The image applies migrations and then refuses to start if the
  database differs from `schema.prisma` ([Dockerfile](Dockerfile)).
- [specs](specs) holds a TLA+ model of the hosted awake-hour meter.

## Layout

| Directory | What it holds |
| --- | --- |
| `src/sandbox` | Sandbox routes, reachability grants, loopback DNS, trash; `hosted/` runs the Fly lane |
| `src/sandbox/hosted` | Fly client, provisioning, pool, meter, builds, migrations between machines, the Stripe plan |
| `src/admin` | Operator panel routes behind `ADMIN_EMAILS`, each call audited |
| `src/desktop` | Desktop sign-in handoff over the `intentic://` deep link |
| `src/fleet` | `/fleet`: an API token lets a sandbox create sandboxes for its owner |
| `src/invite` | Emailed invitations to share a sandbox |
| `src/me` | The caller's profile and GDPR data export |
| `src/tokens` | Account-level API tokens |
| `src/push-relay` | APNs push relay for native installs |
| `src/trial` | Free-trial model API, OpenAI-compatible, on the platform's credential |
| `src/wallet` | Agent wallet: payments signed by a custody provider under per-member caps |
| `src/e2e` | Suites against real Fly and Stripe, gated by `INTENTIC_E2E` |

## Key files

- [src/main.ts](src/main.ts) — boot: config, Prisma, the background jobs, `Bun.serve`.
- [src/app.ts](src/app.ts) — the Hono app: middleware, daemon-facing routes, sub-apps, the oRPC mount at `/rpc`.
- [src/router.ts](src/router.ts) — the oRPC router, one entry per domain, shaped by `@intentic/api-contract`.
- [src/config.ts](src/config.ts) — every setting, its env var and its default.
- [src/sandbox/hosted/hosted.ts](src/sandbox/hosted/hosted.ts) — provisioning and waking hosted machines.
- [src/sandbox/reachability.ts](src/sandbox/reachability.ts) — the hostname and signed grant each sandbox gets.

## Commands

```sh
pnpm db:up                             # repo root: Postgres in Docker, migrations applied
pnpm --filter @intentic/api dev        # watch mode, reads the root .env
pnpm --filter @intentic/api test
pnpm --filter @intentic/api fleet      # read-only: what the platform runs on Fly, and for whom
```
