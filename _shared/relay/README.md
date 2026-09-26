# relay

How the tunnel's two Rust ends relay HTTP: one body type, one list of what never crosses a hop, one reading of a request's host, one HTTP/1.1 exchange over any byte stream with upgrades spliced, and one redial ladder.

- Built by path by the edge ([_platform/ingress](../../_platform/ingress)) and by the sandbox's front
  ([_sandbox/front](../../_sandbox/front)), including its `tunnel` crate, so the two ends read a request the same way.
  Its own Cargo workspace, tested apart from either.
- `exchange` is the only upgrade splice either end has: a tunnel stream, a peer's TCP connection, a socket to Node or
  to a dev server all carry an exchange the same way, and a 101 splices the caller's side to the far side once both are
  free, whatever carried either.
- `host_of` reads the target's own authority before a `Host` header, as RFC 9112 §3.2.2 asks of an absolute-form
  request and as h2 and h3 carry it; only an origin-form h1 request is routed by its `Host`.
- `HOP_BY_HOP` is RFC 9110's connection management plus h2c's `http2-settings`; `host` is not in it, since it names
  the target end to end. `strip_hop_by_hop` also drops whatever `Connection` names.
- Nothing here knows about sandboxes, grants or previews: those are the edge's and the front's.

## Key files

- [src/exchange.rs](src/exchange.rs) — one HTTP/1.1 exchange over any stream, an upgrade spliced on a 101.
- [src/headers.rs](src/headers.rs) — hop-by-hop headers, upgrades, the host a request names, its leftmost label.
- [src/backoff.rs](src/backoff.rs) — the jittered redial ladder the front's carriers and its supervisor climb.
- [src/body.rs](src/body.rs) — the one body type every relayed request and answer is carried in.

## Commands

```sh
(cd _shared/relay && cargo test)
```
