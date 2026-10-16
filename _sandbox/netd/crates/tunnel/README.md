# tunnel

The ingress tunnel's wire as both of its ends speak it: the edge that holds a sandbox's tunnels and the netd that dials them, with one byte stream per exchange carrying plain HTTP/1.1.

- Built by both ends: [netd](../netd) dials and serves the streams, and the edge (`_platform/ingress`) opens them.
  Standalone rather than a member of netd's workspace for that reason; the edge builds it by path from its own.
- Two carriers. A QUIC connection where the edge declares it serves one, and two WebSockets at `/tunnel/v2` carrying
  yamux, `interactive` and `bulk`, which carry every exchange while QUIC is not held. A transfer rides the bulk socket
  so a keystroke never queues behind it; over QUIC a stream that sends a burst yields by itself.
- Holds the one-holder rule's facts: the instance and host a netd presents on every dial, and the close codes the edge
  ends a tunnel with (displaced, held elsewhere, deleted), so two copies of one sandbox stop trading its tunnel.
- Liveness is the carrier's own: netd pings, and both ends drop a peer that stays silent too long.

## Key files

- [src/lib.rs](src/lib.rs) — the tunnel's door, headers, close codes and timings, shared by both ends.
- [src/quic.rs](src/quic.rs) — the tunnel over QUIC: the hello, the grant and identity, and the edge's probe stream.
- [src/mux.rs](src/mux.rs) — the tunnel over a WebSocket carrying yamux.
- [src/bulk.rs](src/bulk.rs) — which socket an exchange rides, from the transfer routes netd announces.
- [src/identity.rs](src/identity.rs) — who dialled a tunnel and whether its carrier still hears it.
- [src/pump.rs](src/pump.rs) — a WebSocket as a byte stream, and its liveness check.
