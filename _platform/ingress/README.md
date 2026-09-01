# @intentic/ingress

The edge every sandbox is reached through: sandboxes dial it, browsers arrive at it, and it matches the two up by parsing a hostname.

A sandbox opens ONE outbound WebSocket to this process, presenting an Ed25519 **reachability grant** the platform signed that says which sandbox it is. From then on every request whose `Host` ends in that sandbox's twelve-hex id is carried down that connection. Nothing is provisioned, claimed or bound: the edge verifies a signature and forwards bytes.

## What it replaced, and why the difference is the point

Under the tunnel hub before this, "make a sandbox reachable" was **state**: an account minted per sandbox over an admin API, a name claimed, a share bound to it, and a reaper collecting what the soft-deletes leaked. Every piece of it existed to answer one question — *which sandbox may serve this hostname?* — that the hostnames already answer by construction. Every public name a sandbox serves ends in its own id (`sandbox-<id>`, `preview-<panel>-<id>`, `port-<slot>-<id>`, `public-<slot>-<id>`), so ownership is a **parse**, not a registry.

What follows from that is most of this package's character:

- **No admin credential.** The edge holds the platform's *public* key. It can verify a grant and can never mint one, so a compromised edge cannot make anything reachable.
- **No durable state.** The registry is a `Map`. A restart forgets every registration and every container redials inside its own backoff, which is why scaling is "add another machine" rather than "share a store".
- **No reclaim dance.** A second tunnel for an id displaces the first (close code `4001`). A recreated container heals itself instead of fighting a registration its dead predecessor still held.
- **Revocation is deleting the sandbox row**, which the edge learns by asking the platform once per registration.

## Key files

- [src/server.ts](src/server.ts) — the edge itself: the tunnel door, grant verification, and per-request host routing.
- [src/registry.ts](src/registry.ts) — which tunnel serves which sandbox, and the displacement rule.
- [src/revocation.ts](src/revocation.ts) — "does this sandbox still exist", cached, and deliberately failing open.
- [src/heartbeat.ts](src/heartbeat.ts) — ping/silence tracking, so a dead peer is unregistered rather than left answering.
- [src/config.ts](src/config.ts) — the whole configuration, which is three values.

## How a request gets to a workspace

```dag
{ "title": "One browser request, one sandbox", "direction": "LR",
  "nodes": [
    { "id": "browser", "label": "Browser", "note": "sandbox-<id>.<zone>", "accent": "1" },
    { "id": "edge", "label": "@intentic/ingress", "note": "parses Host, picks a tunnel", "accent": "2" },
    { "id": "proxy", "label": "Preview proxy", "note": "the container's front door", "accent": "3" },
    { "id": "daemon", "label": "Sandbox daemon", "note": "or a panel, a port, the outbox", "accent": "3" },
    { "id": "platform", "label": "Platform API", "note": "signs grants, answers /api/reachability", "accent": "4" }
  ],
  "edges": [
    { "from": "browser", "to": "edge" },
    { "from": "edge", "to": "proxy" },
    { "from": "proxy", "to": "daemon" },
    { "from": "edge", "to": "platform", "dashed": true }
  ] }
```

Notice which arrow is dashed. The platform is asked whether a sandbox still exists when a tunnel registers, and is on no other path — so a platform outage does not take reachability with it. That is what the fail-open in `revocation.ts` is protecting, and it is the reason reachability moved off the platform in the first place.

Notice also that the edge forwards to **one** port. It routes to a *sandbox*; which port inside that sandbox answers a given hostname is the container's own business, and the preview proxy is what decides it.

## Conventions & gotchas

- **Routing is per request, never per connection.** The edge terminates one wildcard certificate, and HTTP/2 browsers coalesce connections across every name it covers — one TCP connection can carry `sandbox-a…` and `preview-x-b…` interleaved. Routing a connection by its first `Host` would deliver one sandbox's requests to another.
- **The tunnel door is matched by path, before any host check.** The edge's own name carries no sandbox id, so host routing cannot find it.
- **A sandbox with no tunnel gets 502, not 404.** The browser's availability flow reads any 5xx as "unreachable" and drives the wake; a 404 reads as "no such thing" and stops it. The body names the label, because this is the one edge error a person actually meets.
- **`INGRESS_PUBLIC_KEY` is required and the process exits without it.** An edge that cannot verify has two possible behaviours and both are worse than not starting: refuse every sandbox, or accept every one.
- The wire format both halves agree on lives in [ingress-contract.ts](../../_sandbox/sandbox-contract/src/ingress-contract.ts); the HTTP/2-over-WebSocket data plane is [ingress-protocol.ts](../../_sandbox/sandbox-contract/src/ingress-protocol.ts), whose `openIngressSession` this package calls and whose `serveIngressSession` the daemon calls.
