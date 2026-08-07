# @intentic-app/api

The **platform backend** — Hono + oRPC + Prisma + Better Auth. The platform is an **identity + sandbox-URL store only**: it authenticates the user (Google) and stores the sandbox URL the browser tells it so the browser can reach the sandbox directly. It never probes the sandbox or tracks liveness, owns no infrastructure, no infra secrets, and sits **off the command path** — the browser talks to the sandbox daemon directly over the sandbox's own Cloudflare tunnel. Runs under `tsx` in dev on :6480 (the web dev-server proxies to it). Consumes [`@intentic-app/api-contract`](../../_platform/api-contract) (`implement`) + [`@intentic-app/prisma`](../../_platform/prisma).

## Responsibilities

- Authenticate the user (Better Auth + Google) and expose the typed oRPC surface (`me`, `setup.*`).
- Mint the per-user connection token + serve the setup one-liner. The workspace gate is enforced in the browser, which probes the daemon's `/health` directly — the platform never decides liveness.
- Store the sandbox's public `daemonUrl` the **browser** derives (`sandbox-<sha256(token)[:12]>.<zone>`) and writes (`setup.bind`), and serve it back (`setup.binding`) so the browser knows where to reach it. Persist nothing else about the sandbox.
- The setup wizard's **cloud lane** ([src/sandbox/cloud/](src/sandbox/cloud/)): create ONE VM in the **user's own** cloud account (Hetzner / DigitalOcean / Oracle Always-Free) whose first boot runs the sandbox's setup code. The pasted provider credential is request-scoped like the Cloudflare zone listing — spent on the provider's catalog + create calls, never persisted — so the platform keeps no way back into the machine; only display metadata (`Sandbox.cloud`) survives.

## Routes (see [src/app.ts](src/app.ts))

- `/api/auth/**` — Better Auth (Google OAuth, session).
- `${API_BASE_PATH}/*` — the oRPC OpenAPI handler ([src/router.ts](src/router.ts): `me`, `setup.connect`, `setup.zones`, `setup.bind`, `setup.binding`). `bind` stores the browser-derived `daemonUrl`; `binding` reads it back.
- `/health` — DB connectivity.

## Key files

- [src/main.ts](src/main.ts) — entrypoint: `serve(...)`.
- [src/app.ts](src/app.ts) — the Hono app factory + all route wiring; [src/router.ts](src/router.ts) + [src/context.ts](src/context.ts) — oRPC.
- [src/auth.ts](src/auth.ts) — Better Auth (Google sign-in + the desktop one-time-token handoff).
- [src/sandbox/cloud/index.ts](src/sandbox/cloud/index.ts) — the cloud lane's provider switch; one plain-fetch adapter per provider beside it (Oracle's request signing in [src/sandbox/cloud/oci-sign.ts](src/sandbox/cloud/oci-sign.ts), the first-boot script in [src/sandbox/cloud/user-data.ts](src/sandbox/cloud/user-data.ts)).
- [src/config.ts](src/config.ts) — `@puristic/env` config; [src/prisma.ts](src/prisma.ts) — client factory; [src/types.ts](src/types.ts) — the shared Prisma type.

## Conventions & gotchas

- The platform is **off the command path** — there is no relay, no socket to the sandbox, and no sandbox-originated calls. The browser calls the sandbox daemon directly (authenticated by the user's Google ID token); the platform only holds the stored URL.
- `setup.connect` returns only the connection token + the connect-script URLs. The sandbox's public URL is **derived deterministically** from that token + the chosen zone (`sandbox-<sha256(token)[:12]>.<zone>`, matching the CLI's tunnel hostname) and written by the browser via `setup.bind` — the sandbox never calls the platform.
- Config is nested + SCREAMING_SNAKE-derived by `@puristic/env`; secrets are plaintext in the DB for now. No platform test harness — verify with `pnpm build` + `pnpm lint`.
