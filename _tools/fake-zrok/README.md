# @intentic/fake-zrok

A stand-in for the tunnel hub — the three calls the platform makes to zrok, and nothing else.

## Responsibilities

- Answer the namespace lookup and the account mint the platform needs before it will issue a setup code.
- Refuse a wrong admin token, and answer a duplicate account the way the real hub does.
- Nothing else. It carries no traffic and creates no tunnel.

## How it fits

Reachability is the one thing standing between a hermetic test and the whole install path. Every installer
lane starts the same way — the wizard asks the platform for a setup code — and the platform refuses to mint
one without a tunnel fabric to put the sandbox behind. Without an answer to that question a test cannot reach
the second step of any of the four onboarding paths.

**It does not tunnel anything, and nothing downstream needs it to.** The sandbox's own `zrok2 enable` against
this will fail, and the daemon's entrypoint treats that as non-fatal on purpose — it logs and serves anyway.
The browser then reaches the box the way a browser on the same machine always prefers to: the loopback port
the container publishes, a hop away, needing no fabric at all.

Pointing the platform here needs **no product change**: the endpoint and the admin token are already config,
and the token is also the switch that decides whether a platform mints addresses at all.

## Conventions & gotchas

- **It answers in the hub's own media type**, not `application/json`. The real API declares
  `application/zrok.v1+json` on every operation and the platform's client sends it; a stand-in that was
  lenient about this would be hiding the header mismatch the client was written around.
- **A duplicate account answers 500 on purpose.** That is what the real hub does, and the platform's one
  retry — delete, then create again — exists solely because of it. A stand-in that happily re-created would
  leave that recovery path unrun.
- **A wrong token answers 401 on purpose**, because that is the one status the platform turns into a sentence
  naming the two settings behind it.
- No dependencies and no build. Node 24 runs TypeScript by erasing its types, so relative imports here name
  `.ts` — node resolves the specifier literally and will not rewrite one extension into the other.

## Key files

- [src/server.ts](src/server.ts) — the three routes, the two refusals.
- [src/main.ts](src/main.ts) — the container entrypoint.
- [src/server.test.ts](src/server.test.ts) — what the platform sends, and both refusals.
- [Dockerfile](Dockerfile) — the image the journey harness stands up beside the platform.
