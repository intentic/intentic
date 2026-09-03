# @intentic/ingress

The edge every sandbox is reached through: sandboxes dial it, browsers arrive at it, and it matches the two up by parsing a hostname.

A sandbox opens ONE outbound WebSocket to this process, presenting an Ed25519 **reachability grant** the platform signed that says which sandbox it is. From then on every request whose `Host` ends in that sandbox's twelve-hex id is carried down that connection. Nothing is provisioned, claimed or bound: the edge verifies a signature and forwards bytes.

## What it replaced, and why the difference is the point

Under the tunnel hub before this, "make a sandbox reachable" was **state**: an account minted per sandbox over an admin API, a name claimed, a share bound to it, and a reaper collecting what the soft-deletes leaked. Every piece of it existed to answer one question — *which sandbox may serve this hostname?* — that the hostnames already answer by construction. Every public name a sandbox serves ends in its own id (`sandbox-<id>`, `preview-<panel>-<id>`, `port-<slot>-<id>`, `public-<slot>-<id>`), so ownership is a **parse**, not a registry.

What follows from that is most of this package's character:

- **No admin credential.** The edge holds the platform's *public* key. It can verify a grant and can never mint one, so a compromised edge cannot make anything reachable.
- **No durable state.** Each machine's registry is a `Map` of the tunnels it holds. A restart forgets every registration and every container redials inside its own backoff. Which *other* machine holds a tunnel is a second, soft map the machines keep each other told about — so scaling is still "add another machine", and no store is shared.
- **No reclaim dance.** A second tunnel for an id displaces the first (close code `4001`), on whichever machine it lands. A recreated container heals itself instead of fighting a registration its dead predecessor still held.
- **Revocation is deleting the sandbox row**, which the edge learns by asking the platform once per registration.

## Key files

- [src/server.ts](src/server.ts) — the edge itself: the tunnel door, grant verification, per-request host routing, and where a local miss is handed to a peer.
- [src/cluster.ts](src/cluster.ts) — which peer holds which tunnel, the holds protocol the machines speak, and the one-hop rule.
- [src/registry.ts](src/registry.ts) — which local tunnel serves which sandbox, and the displacement rule.
- [src/forward.ts](src/forward.ts) — handing a request or an upgrade to the machine that holds the tunnel, streamed, never buffered.
- [src/peers.ts](src/peers.ts) — who the other machines are: Fly's internal DNS, or a static list.
- [src/revocation.ts](src/revocation.ts) — "does this sandbox still exist", cached, and deliberately failing open.

## How a request gets to a workspace

```dag
{ "title": "One browser request, one sandbox", "direction": "LR",
  "nodes": [
    { "id": "browser", "label": "Browser", "note": "sandbox-<id>.<zone>", "accent": "1" },
    { "id": "edge", "label": "@intentic/ingress", "note": "parses Host, picks a tunnel", "accent": "2" },
    { "id": "peer", "label": "Another edge machine", "note": "when the tunnel is there", "accent": "2" },
    { "id": "proxy", "label": "Preview proxy", "note": "the container's front door", "accent": "3" },
    { "id": "daemon", "label": "Sandbox daemon", "note": "or a panel, a port, the outbox", "accent": "3" },
    { "id": "platform", "label": "Platform API", "note": "signs grants, answers /api/reachability", "accent": "4" }
  ],
  "edges": [
    { "from": "browser", "to": "edge" },
    { "from": "edge", "to": "proxy" },
    { "from": "edge", "to": "peer", "dashed": true },
    { "from": "peer", "to": "proxy", "dashed": true },
    { "from": "proxy", "to": "daemon" },
    { "from": "edge", "to": "platform", "dashed": true }
  ] }
```

Notice which arrows are dashed. The platform is asked whether a sandbox still exists when a tunnel registers, and is on no other path — so a platform outage does not take reachability with it. That is what the fail-open in `revocation.ts` is protecting, and it is the reason reachability moved off the platform in the first place. The hop to another machine is dashed for a different reason: it is the exception. Anycast puts a sandbox's tunnel on the machine nearest the sandbox and a browser on the machine nearest itself, and for the owner at home those are the same machine.

Notice also that the edge forwards to **one** port. It routes to a *sandbox*; which port inside that sandbox answers a given hostname is the container's own business, and the preview proxy is what decides it.

## Several machines

Machines find each other on Fly through the app's own DNS (`<app>.internal`, polled), or off Fly through `INGRESS_PEERS`; one machine with neither is exactly the edge as it was. They speak a small holds protocol on a private port: a tunnel arriving or leaving is told to every peer at once, the whole held-id list is pushed every thirty seconds so a lost message is repaired within one, and a machine discovery has just shown is asked what it holds on sight. Entries nobody refreshes expire; a machine discovery drops loses its entries at once.

A request that misses locally is handed to the holder over the private network with a hop header, and a hop-marked request that misses is a 502 — at most one hop, ever. A holder that turns out to be unreachable is forgotten on the spot. `fly scale count N` is the whole of the operator's part.

## Conventions & gotchas

- **Routing is per request, never per connection.** The edge terminates one wildcard certificate, and HTTP/2 browsers coalesce connections across every name it covers — one TCP connection can carry `sandbox-a…` and `preview-x-b…` interleaved. Routing a connection by its first `Host` would deliver one sandbox's requests to another.
- **The tunnel door is matched by path, before any host check.** The edge's own name carries no sandbox id, so host routing cannot find it.
- **A sandbox with no tunnel gets 502, not 404.** The browser's availability flow reads any 5xx as "unreachable" and drives the wake; a 404 reads as "no such thing" and stops it. The body names the label, because this is the one edge error a person actually meets.
- **`INGRESS_PUBLIC_KEY` is required and the process exits without it.** An edge that cannot verify has two possible behaviours and both are worse than not starting: refuse every sandbox, or accept every one.
- **The internal port must never be public.** It is bound to Fly's private address when there is one and is simply not published in compose; it trusts any peer discovery knows, and discovery is the only lock on it.
- The wire format both halves agree on lives in [ingress-contract.ts](../../_sandbox/sandbox-contract/src/ingress-contract.ts); the HTTP/2-over-WebSocket data plane is [ingress-protocol.ts](../../_sandbox/sandbox-contract/src/ingress-protocol.ts), whose `openIngressSession` this package calls and whose `serveIngressSession` the daemon calls.
