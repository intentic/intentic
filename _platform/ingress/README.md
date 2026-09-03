# @intentic/ingress

The edge every sandbox is reached through: it owns `*.<zone>` and the one wildcard certificate, and for each request it decides who serves the hostname. There are two answers, because there are two kinds of sandbox.

A sandbox on **somebody's own machine** cannot be dialled, so it dials: ONE outbound WebSocket to this process, presenting an Ed25519 **reachability grant** the platform signed that says which sandbox it is. From then on every request whose `Host` ends in that sandbox's twelve-hex id is carried down that connection. A sandbox **the platform hosts on Fly** is on the internet already and dials nothing: a request for its hostname is answered with `fly-replay: app=<its app>`, and Fly's proxy delivers the request — and every byte after it — to that app's machine directly, with a cached route so this process is not asked again for a while. Either way nothing is provisioned, claimed or bound: the edge verifies a signature or parses a hostname, and either forwards bytes or says where they go.

## What it replaced, and why the difference is the point

Under the tunnel hub before this, "make a sandbox reachable" was **state**: an account minted per sandbox over an admin API, a name claimed, a share bound to it, and a reaper collecting what the soft-deletes leaked. Every piece of it existed to answer one question — *which sandbox may serve this hostname?* — that the hostnames already answer by construction. Every public name a sandbox serves ends in its own id (`sandbox-<id>`, `preview-<panel>-<id>`, `port-<slot>-<id>`, `public-<slot>-<id>`), so ownership is a **parse**, not a registry. The same parse names a hosted sandbox's Fly app (`<prefix>-<id>`), which is what lets the replay decision need no state either.

What follows from that is most of this package's character:

- **No admin credential.** The edge holds the platform's *public* key. It can verify a grant and can never mint one, so a compromised edge cannot make anything reachable. It holds no Fly credential either: a replay is a response header the proxy honours, not an API call.
- **No durable state.** Each machine's registry is a `Map` of the tunnels it holds. A restart forgets every registration and every container redials inside its own backoff; a hosted sandbox notices nothing, since its bytes were never here. Which *other* machine holds a tunnel is a second, soft map the machines keep each other told about — so scaling is still "add another machine", and no store is shared.
- **No reclaim dance.** A second tunnel for an id displaces the first (close code `4001`), on whichever machine it lands. A recreated container heals itself instead of fighting a registration its dead predecessor still held.
- **Revocation is deleting the sandbox row**, which the edge learns by asking the platform once per registration, and once per unheld hostname per cache TTL.

## Key files

- [src/server.ts](src/server.ts) — the edge itself: the tunnel door, grant verification, per-request host routing, where a local miss is handed to a peer, and where a hosted sandbox's request is answered with a replay instead.
- [src/revocation.ts](src/revocation.ts) — "does this sandbox still exist, and which lane is it on", cached, and deliberately failing open.
- [src/cluster.ts](src/cluster.ts) — which peer holds which tunnel, the holds protocol the machines speak, and the one-hop rule.
- [src/registry.ts](src/registry.ts) — which local tunnel serves which sandbox, and the displacement rule.
- [src/forward.ts](src/forward.ts) — handing a request or an upgrade to the machine that holds the tunnel, streamed, never buffered.
- [src/peers.ts](src/peers.ts) — who the other machines are: Fly's internal DNS, or a static list.

## How a request gets to a workspace

```dag
{ "title": "One browser request, one sandbox", "direction": "LR",
  "nodes": [
    { "id": "browser", "label": "Browser", "note": "sandbox-<id>.<zone>", "accent": "1" },
    { "id": "proxy", "label": "Fly's proxy", "note": "terminates TLS, honours a replay", "accent": "2" },
    { "id": "edge", "label": "@intentic/ingress", "note": "parses Host: tunnel, peer, or replay", "accent": "2" },
    { "id": "peer", "label": "Another edge machine", "note": "when the tunnel is there", "accent": "2" },
    { "id": "own", "label": "Sandbox on the owner's machine", "note": "over the tunnel it dialled", "accent": "3" },
    { "id": "hosted", "label": "Hosted sandbox (Fly app)", "note": "replayed to by the proxy", "accent": "3" },
    { "id": "platform", "label": "Platform API", "note": "answers /api/reachability", "accent": "4" }
  ],
  "edges": [
    { "from": "browser", "to": "proxy" },
    { "from": "proxy", "to": "edge" },
    { "from": "edge", "to": "own" },
    { "from": "edge", "to": "peer", "dashed": true },
    { "from": "peer", "to": "own", "dashed": true },
    { "from": "proxy", "to": "hosted", "dashed": true },
    { "from": "edge", "to": "platform", "dashed": true }
  ] }
```

Two of the dashed arrows are dashed for the same reason: they are exceptions. The hop to another machine runs only when anycast put a tunnel and its browser on different machines, which for the owner at home they are not. The platform is asked when a tunnel registers and when a hostname nobody holds arrives, and is on no other path — so a platform outage does not take reachability with it. That is what the fail-open in `revocation.ts` protects, and it is the reason reachability moved off the platform in the first place.

The third dashed arrow is the hosted lane, and it is dashed because *this process is not on it*. The edge answers a hosted sandbox's first request with the three replay headers (`fly-replay`, `fly-replay-cache`, `fly-replay-cache-ttl-secs`, `replayHeaders` in server.ts); Fly's proxy replays that request to the sandbox's app and remembers the route for the hostname for `REPLAY_CACHE_TTL_SECS`, keyed on the `Host` header ([fly.toml](fly.toml)), so every later request goes browser → proxy → machine. The app needs no public address and no certificate of its own — a replay reaches an app on its own private network — and the edge derives its name from the id in the hostname (`<prefix>-<id>`), or takes the one the platform names when it can be asked. Two Fly rules shape the code: a request over 1 MB cannot be replayed (only the first request on a hostname per TTL can ever meet this, and from a browser that is a GET), and the app that answers with a replay must not negotiate a WebSocket upgrade itself, so an upgrade is replayed by answering a plain head and letting the machine send the 101.

Notice also that the edge forwards to **one** port, and the replay delivers to **one** service. It routes to a *sandbox*; which port inside that sandbox answers a given hostname is the container's own business, and the preview proxy is what decides it.

## Several machines

Machines find each other on Fly through the app's own DNS (`<app>.internal`, polled), or off Fly through `INGRESS_PEERS`; one machine with neither is exactly the edge as it was. They speak a small holds protocol on a private port: a tunnel arriving or leaving is told to every peer at once, the whole held-id list is pushed every thirty seconds so a lost message is repaired within one, and a machine discovery has just shown is asked what it holds on sight. Entries nobody refreshes expire; a machine discovery drops loses its entries at once.

A request that misses locally is handed to the holder over the private network with a hop header, and a hop-marked request that misses is a 502 — at most one hop, ever, and never a replay: the peer believed we held the tunnel, and the answer to a belief that was wrong is the 502 that lets it forget. A holder that turns out to be unreachable is forgotten on the spot. `fly scale count N` is the whole of the operator's part.

## Deploying

[fly.toml](fly.toml) is the shape of a machine. **Where** the machines are is not expressible there — Fly removed the key — so placement is `fly scale count`. The placement rule is about the tunnel lane: a browser lands on the machine nearest *it* and a tunnel on the machine nearest *the sandbox*, and when both are in the same region the cluster's forward never runs. Hosted sandboxes do not care where the edge is (the replay is carried from whichever machine answered), but Fly's own advice for a router is to keep it near users, which argues for more cheap machines rather than fewer.

```sh
fly deploy --image ghcr.io/intentic/ingress:latest
fly scale count 2 --region iad,arn        # one per region tunnel-lane owners are likely in; add regions freely
fly secrets set INGRESS_PUBLIC_KEY="$(cat ingress.pub)" PLATFORM_URL=https://app.intentic.dev HOSTED_APP_PREFIX=intentic-sbx
fly certs add '*.sbx.intentic.dev'        # the one wildcard every sandbox hostname is covered by
```

`HOSTED_APP_PREFIX` is the switch for the hosted lane and must equal the api's: it is how the edge names `<prefix>-<id>` when the platform cannot be asked. Leave it unset on an edge that does not run in the Fly org the hosted apps are created in (a replay cannot cross organisations) and on a platform with no hosted lane; a hostname nobody holds is then simply "not connected". Adding a machine needs nothing else set: `FLY_APP_NAME`, `FLY_PRIVATE_IP` and `FLY_MACHINE_ID` are injected, the app's own DNS lists the machines, and [src/peers.ts](src/peers.ts) polls it.

**Verify with `/health`**, which is also how a single-machine deployment gives itself away:

```jsonc
{ "status": "ok", "tunnels": 5, "instance": "148e…", "peers": 1, "remote": 3, "replay": true }
```

- `peers` is how many *other* machines discovery currently sees. **`0` on an app that has been scaled past one machine means discovery is broken**, and every request for a sandbox held next door is a 502.
- `remote` is how many ids this machine would forward rather than serve. Persistently `0` alongside a healthy `peers` on a multi-region app is worth a look — it usually means one region is holding every tunnel.
- `replay` is whether hosted sandboxes are replayed to their apps here. **`false` on the production edge means every hosted sandbox answers 502**, with nothing else looking wrong.
- An answer with **no `instance`/`peers`/`remote` fields at all** predates the cluster: that build is a single machine no matter how many you scale to.

## Conventions & gotchas

- **Routing is per request, never per connection.** The edge terminates one wildcard certificate, and HTTP/2 browsers coalesce connections across every name it covers — one TCP connection can carry `sandbox-a…` and `preview-x-b…` interleaved. Routing a connection by its first `Host` would deliver one sandbox's requests to another. The replay cache is keyed on `Host` for the same reason.
- **The tunnel door is matched by path, before any host check.** The edge's own name carries no sandbox id, so host routing cannot find it.
- **A sandbox with no tunnel gets 502, not 404**, unless it is hosted, in which case it gets a replay. The browser's availability flow reads any 5xx as "unreachable" and drives the wake — including the proxy's own error for a hosted app whose machine is stopped, which is how a sleeping hosted sandbox is woken. The 502 body names the label, because this is the one edge error a person actually meets.
- **Unknown replays.** A platform that cannot say which lane an id is on leaves it unknown, and unknown is replayed: a wrong replay costs one proxy error for a sandbox that was unreachable anyway, a wrong refusal costs a working hosted sandbox its whole outage.
- **`INGRESS_PUBLIC_KEY` is required and the process exits without it.** An edge that cannot verify has two possible behaviours and both are worse than not starting: refuse every sandbox, or accept every one.
- **The internal port must never be public.** It is bound to Fly's private address when there is one and is simply not published in compose; it trusts any peer discovery knows, and discovery is the only lock on it.
- The wire format both halves agree on lives in [ingress-contract.ts](../../_sandbox/sandbox-contract/src/ingress-contract.ts); the HTTP/2-over-WebSocket data plane is [ingress-protocol.ts](../../_sandbox/sandbox-contract/src/ingress-protocol.ts), whose `openIngressSession` this package calls and whose `serveIngressSession` the daemon calls. A hosted machine's front door — the service the replay lands on — is declared beside the machine config in [sandbox-run/fly.ts](../../_sandbox/sandbox-run/src/fly.ts).
