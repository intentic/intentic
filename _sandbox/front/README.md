# front

The sandbox's native front: a Rust process that owns every port and the ingress tunnel, relays what the Node daemon
answers over a Unix socket, and supervises that daemon so a crash or restart never closes a browser's socket.

The image's entrypoint execs `intentic-front -- node … dist/main.js`. From then on the daemon binds nothing: it
serves HTTP on a Unix socket only the front dials, and tells the front over a second socket (the control lane) which
ports to bind, which certificate the loopback name serves, and where the tunnel dials. **Node decides, the front
binds**: every policy (preview routing, auth, the interstitial pages) stays in Node, and the front carries the bytes.
Why the split looks like this, and the phases that move more of the hot path here, is
[docs/design/native-front.md](../../docs/design/native-front.md).

```
browser ─▶ :8787 daemon · :5173 preview · :8788 loopback (TLS sniffed, h2) ─┐
edge    ─▶ tunnel: h2 over the WebSocket the front dials, one stream a request ─┤
                                                                               ├─▶ route by listener + Host label
                        Node's Unix socket (HTTP/1.1, pooled) ◀── sandbox-<id> ─┤
                        a preview's own upstream (TCP/TLS)    ◀── preview-/port- ┘
```

- **Routing** is the listener plus the Host's leftmost label: `sandbox-<id>` is Node's, `preview-`/`port-`/`public-`
  labels are a preview's. The label rules mirror the contract's `hostnames.ts` and are held to the same fixture file
  (`hostnames.fixture.json`) by both test suites.
- **Previews**: the front asks Node where a host goes (cached a second), relays a serving upstream itself with Host
  and Origin rewritten to `localhost:<port>` where the app expects that, `X-Forwarded-*` set, and the editor's
  `frame-ancestors` in place of the app's own. Everything else (a refusal page, the probe, the outbox, an upstream
  that refused the connection) goes back to Node marked with a header only the front may set.
- **Upgrades** (terminals, HMR sockets, desktop sync) are spliced byte for byte once the far side answers 101; a
  WebSocket arriving down the tunnel is the edge's CONNECT envelope (`x-ingress-*`), answered in the same raw h1.
- **Supervision**: exit 0 (a stop, an idle machine) and 78 (a refused config) end the front as they ended the
  container; any other exit restarts Node with backoff while every socket stays open, and a request that arrives
  meanwhile waits for the new Node. The daemon runs in its own process group and dies with the front.
- **cgroups**: the entrypoint's `daemon` leaf (no swap, top cpu/io weight) holds the front and Node alone; anything
  else that lands there moves to `workload`, and Node's children run at nice 10.

## The control lane

One Unix socket, each frame a 4-byte big-endian length then JSON. The types are defined once, in
[crates/front-wire](crates/front-wire/src/lib.rs); `cargo test` writes their TypeScript to
`_shared/sandbox-contract/src/front/generated/wire.ts` (`@intentic/sandbox-contract/front-wire`), which the daemon's
[front-link.ts](../sandbox/src/front/front-link.ts) imports. CI refuses a committed copy that differs from what the
Rust emits, so run `cargo test` in this directory after changing a type (cargo reads `.cargo/config.toml` from where
it runs, and that config names the output directory).

## Building

`cargo build` here for development. The image's copy is built by
[build-front.sh](../../_tools/scripts/image/build-front.sh) inside `rust:*-slim-trixie` (the image's own Debian
release, so it links the glibc the image carries), which `prepare-image-trees.sh` runs and `dev-restart.sh` reruns;
the dev loop mounts its output directory over `/opt/sandbox/front`.

## Key files

- [crates/front/src/proxy.rs](crates/front/src/proxy.rs): one request's destination (Node, a preview upstream, or
  unavailable) and its relay, upgrades and the tunnel's CONNECT envelope included.
- [crates/front/src/supervise.rs](crates/front/src/supervise.rs): which exits end the front and which restart Node.
- [crates/front/src/tunnel.rs](crates/front/src/tunnel.rs): the ingress dial, its heartbeat and backoff, and h2
  served straight over the WebSocket.
- [crates/front/src/link.rs](crates/front/src/link.rs): the control lane's front half: questions to Node, and the
  config Node pushes.
- [crates/front-wire/src/lib.rs](crates/front-wire/src/lib.rs): every message on the lane, the one definition both
  runtimes compile against.
- [crates/front/tests/tunnel.rs](crates/front/tests/tunnel.rs): the tunnel against a stand-in edge speaking what
  `_platform/ingress` speaks.
