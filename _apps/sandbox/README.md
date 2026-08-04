# @intentic/sandbox

The **per-project AI-agent dev daemon** — a Docker image that runs as the project's workspace container on the customer's host. It exposes an HTTP API the browser drives **directly** over the sandbox's own Cloudflare tunnel (Google-verified auth): run a Claude Agent turn over the project's three repos, run the `intentic` CLI, do git operations, read/write inventory, and report the dev-server preview. Ships to GHCR as `ghcr.io/intentic/sandbox`. A private package (not published to npm).

## Responsibilities

- Serve the daemon API (`/agent`, `/intentic`, `/git/:repo/*`, `/inventory`, `/info`, `/preview`, `/health`); the browser calls it directly over the sandbox's tunnel, each request authenticated by the owner's Google ID token (`/health` carved out for liveness).
- Run one Claude Agent turn (`runAgent`) over the workspace, streaming typed `AgentEvent`s as SSE `data:` frames.
- Run the `intentic` CLI in-workspace and stream its ndjson lines; commit/push the repos.
- Manage the app dev server and report preview status.

## Key files

- [src/daemon.ts](src/daemon.ts) — the Hono HTTP API + request schemas.
- [src/agent.ts](src/agent.ts) — `runAgent` + the `AgentEvent` union (`session`/`delta`/`tool`/`error`/`done`); wraps the Claude Agent SDK.
- [src/dev-server.ts](src/dev-server.ts) — spawns/watches the app dev server; `/preview` status.
- [src/intentic-runner.ts](src/intentic-runner.ts) — runs the `intentic` CLI and parses its ndjson.
- [src/git.ts](src/git.ts) — status/commit/push; [src/workspace.ts](src/workspace.ts) — the three-repo layout (intent / desired-state / monorepo).
- [src/main.ts](src/main.ts) — entrypoint: builds the workspace + dev server and serves the daemon.

## How it fits

The agent half of the dev plane. The browser talks to this daemon **directly** over the sandbox's own Cloudflare tunnel; the daemon verifies the owner's Google ID token, resolves the Claude token from its **own** stored credentials, and injects it into the SDK per turn. The platform is never on this path and never contacts the sandbox — it only stores the sandbox's public URL (which the browser derived and wrote) so the browser knows where to reach it; the browser alone probes the daemon for liveness (`/health` + the `/events` stream).

## Conventions & gotchas

- The Claude credential lives in the sandbox's own store (connected via the daemon's `/claude/*` flow), resolved + injected into the SDK per turn — never held by the platform.
- The daemon authenticates every request itself (the owner's Google ID token, verified via Google's JWKS), since it is reached directly over its public tunnel — it owns its own auth.
- Built on Hono + the Claude Agent SDK + zod; `runAgent`'s `QueryFn` is injectable so co-located `*.test.ts` run without the SDK or network.
