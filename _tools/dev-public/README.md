# @intentic/dev-public

Serve a local dev platform on the internet through the tunnel hub — `pnpm dev:public`.

## Responsibilities

- Mint ONE hub account for this developer's platform (the same grant the platform mints per sandbox), and
  keep it: the seed lives in the user's own data directory, so the hostnames never move.
- Run the `zrok2` agent on this machine and bind two public names to the local dev servers:
  `dev-<id>.<zone>` → the SPA (`https://localhost:47145`), `api-dev-<id>.<zone>` → the api
  (`https://localhost:6480`).
- Start `pnpm dev:light` with `API_URL`/`WEB_ORIGIN` pointing at those origins — which is all the invite
  path, CORS and Better Auth ever needed to work off this machine.

## How it fits

A locally-run platform already puts every **sandbox** it manages on the internet — reachability is a hub
account, and the hub is a real deployed service. What stays stuck on the developer's machine is the platform
pair itself: invite links are built from `WEB_ORIGIN` (localhost), the SPA calls `API_URL` (localhost), and
Google sign-in accepts only registered origins. This tool closes exactly that gap, the same way a sandbox
closes it, so a developer can invite a real user into a sandbox their dev platform manages — and the
sandboxes themselves talk to the platform over a real name with a valid certificate, the production shape
instead of the localhost TLS exceptions.

The agent sequence is the sandbox entrypoint's, verbatim (`_sandbox/sandbox/docker-entrypoint.sh`): enable
once into a private HOME, `agent start` supervised (the agent holds the shares), then per name `create name`
+ `share public … --name-selection`.

## Conventions & gotchas

- **The hostnames are the point of the seed.** `<id>` is digested from a per-user seed OUTSIDE the repo
  (beside localhost-https's certificate, for the same reason), because the Google client must list the exact
  origin and redirect URI — no wildcards — and a hostname that moved would mean registering again. The
  registration itself stays manual on purpose; the tool prints the two lines to paste.
- **A public origin refuses dev-grade secrets.** The api exits when `API_URL`/`WEB_ORIGIN` is public while
  `BETTER_AUTH_SECRET` is the `.env.example` placeholder or `SECRETS_KEY` is unset; this tool refuses first,
  with the same words. Anyone on the internet can reach a public dev platform — treat the mode as opt-in per
  run, and `--reset` as the kill switch (it revokes the hub account, which takes both names down with it).
- **A dev platform already running is refused, not published.** The tunnel forwards two local ports and does
  not care which process holds them, so a leftover `pnpm dev` would be served to the internet — configured
  with localhost origins, and therefore still minting invite links (and every other link the platform builds)
  that point at localhost, while the public address answers perfectly and looks healthy. The tool checks both
  ports before it mints anything and names that consequence. Stop the running dev first.
- **The invite link is the platform's `WEB_ORIGIN`, and nothing else builds it.** It is composed in
  `_platform/api/src/invite/email.ts` at send time, so a link that says localhost means the *api process* was
  started with a localhost origin — recreating a sandbox cannot change it, and neither can anything inside the
  box. Restart the platform through this tool and re-send.
- **`--insecure` is for the LOCAL hop only.** The dev servers present the repo-CA certificate no system
  trusts, so the agent's proxy skips verifying its own machine's listener; the public certificate is the hub
  frontend's wildcard either way.
- **`--tunnel-only`** stands the tunnel up, prints the `API_URL`/`WEB_ORIGIN` pair, and keeps holding the
  agent — for running dev your own way. The tunnel lives as long as the tool does.
- **An invitee reaches a sandbox only if it holds a reachability grant.** A box connected loopback-only (no
  grant) stays reachable from the owner's machine alone, however public the platform is.
- No dependencies and no build: node 24 runs these `.ts` files by erasing the types (the fake-zrok
  precedent), which is why relative imports name `.ts`.

## Key files

- [src/main.ts](src/main.ts) — the orchestrator: seed → grant → agent → shares → `pnpm dev:light`.
- [src/hub.ts](src/hub.ts) — the three admin calls, faithful to the platform's own client
  (`_platform/api/src/sandbox/zrok.ts`).
- [src/naming.ts](src/naming.ts) — the id, the two labels, the account email.
- [src/probe.ts](src/probe.ts) — the port check, and why publishing a leftover dev server is worse than
  failing to start.
- [src/hub.test.ts](src/hub.test.ts) — the calls against `@intentic/fake-zrok`, including the duplicate-500
  recovery.
