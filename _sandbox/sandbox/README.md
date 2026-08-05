# @intentic/sandbox

The **per-project AI-agent dev daemon** — a Docker image that runs as the project's workspace container on the customer's host. It exposes an HTTP API the browser drives **directly** over the sandbox's own Cloudflare tunnel (Google-verified auth): run a Claude Agent turn over the project's three repos, run the `intentic` CLI, do git operations, read/write inventory, and report the dev-server preview. Ships to GHCR as `ghcr.io/intentic/sandbox`. A private package (not published to npm).

## Responsibilities

- Serve the daemon API (`/agent`, `/intentic`, `/git/:repo/*`, `/inventory`, `/info`, `/preview`, `/health`); the browser calls it directly over the sandbox's tunnel, each request authenticated by the owner's Google ID token (`/health` carved out for liveness).
- Run one Claude Agent turn (`runAgent`) over the workspace, streaming typed `AgentEvent`s as SSE `data:` frames.
- Run the `intentic` CLI in-workspace and stream its ndjson lines; commit/push the repos.
- Manage the app dev server and report preview status.

## Key files

- [src/app.ts](src/app.ts) — the Hono HTTP API: every route the browser and the CLI reach the daemon through.
- [src/agent](src/agent) — **singular**: one conversation. The turn loop, its tools, steering, terminals and diagnostics.
- [src/agents](src/agents) — **plural**: the fleet. The registry, `worktrees.ts`, `isolation.ts`, `land.ts`, `origins.ts`.
- [src/git/git.routes.ts](src/git/git.routes.ts) — status/commit/push over the wire; [src/workspace](src/workspace) — the repo layout the daemon serves.
- [src/composition.ts](src/composition.ts) — what is wired to what; [src/main.ts](src/main.ts) — the entrypoint that builds it and serves.

## How it fits

The agent half of the dev plane. The browser talks to this daemon **directly** over the sandbox's own Cloudflare tunnel; the daemon verifies the owner's Google ID token, resolves the Claude token from its **own** stored credentials, and injects it into the SDK per turn. The platform is never on this path and never contacts the sandbox — it only stores the sandbox's public URL (which the browser derived and wrote) so the browser knows where to reach it; the browser alone probes the daemon for liveness (`/health` + the `/events` stream).

## Conventions & gotchas

- The Claude credential lives in the sandbox's own store (connected via the daemon's `/claude/*` flow), resolved + injected into the SDK per turn — never held by the platform.
- The daemon authenticates every request itself (the owner's Google ID token, verified via Google's JWKS), since it is reached directly over its public tunnel — it owns its own auth.
- Built on Hono + the Claude Agent SDK + zod; `runAgent`'s `QueryFn` is injectable so co-located `*.test.ts` run without the SDK or network.
