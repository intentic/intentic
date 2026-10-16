# intentic-netd

The binary of the sandbox's network daemon: it owns every port and the ingress tunnel, relays each request to the Node daemon or a preview, and runs Node as its child across restarts.

- The one binary of the [netd workspace](../..), whose README describes how netd works as a whole: routing, the
  tunnel, supervision, terminals. This page only maps the crate.
- Speaks [netd-wire](../netd-wire) with Node over the control socket, answers what [browser-wire](../browser-wire)
  names to the browser, and dials the edge through [tunnel](../tunnel). Relays with the shared `_shared/relay` crate.
- Runs as the sandbox container's main process; `docker-entrypoint.sh` execs it with Node's command line after `--`.
- Remembers what Node last told it (ports, certificate, tunnel) and applies it again at start, so a Node that crashes
  before it speaks still leaves netd answering its vitals.
- The tests run the real binary on real ports.

## Key files

- [src/main.rs](src/main.rs) — the modules and how the process starts.
- [src/proxy.rs](src/proxy.rs) — where every listener and tunnel stream hands its requests, and how each is relayed.
- [src/route.rs](src/route.rs) — which side answers a request.
- [src/supervise.rs](src/supervise.rs) — runs Node, restarts it and ends what it left behind.
- [src/tunnel.rs](src/tunnel.rs) — dials the edge and serves a stream per request.
- [tests/routes.rs](tests/routes.rs) — the real binary on real ports: routing, preview relay, TLS, upgrades.
