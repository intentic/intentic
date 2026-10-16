# netd-wire

The control socket between intentic-netd and the Node daemon: length-prefixed JSON frames over one Unix socket, with netd owning every socket and byte and Node making every decision about them.

- The socket's only definition. [netd](../netd) speaks it in Rust, and the Node daemon speaks it through the
  TypeScript that `cargo test -p netd-wire` writes, with a manifest the contract's lock pins, into
  `_shared/sandbox-contract/src/netd/generated/`. Edit the Rust, never the generated file.
- Either side may ask the other a question: an `Ask` with an id, answered by an `Answer` or a `Refused` with the same
  id, which the asker waits a fixed patience for. Everything else is told and never answered.
- Also names the environment netd hands the daemon it starts: where to dial this socket, where to serve HTTP, the
  netd instance and which start of the daemon this is.
- A browser never sees any of it. What a browser sees of netd is [browser-wire](../browser-wire).

## Key files

- [src/lib.rs](src/lib.rs) — every frame, the environment names, the framing limits, and the test that writes their
  TypeScript.
- [../netd/src/link.rs](../netd/src/link.rs) — netd's half of the socket: one Node at a time, questions both ways.
- [../netd/src/supervise.rs](../netd/src/supervise.rs) — where netd sets the environment named here on each Node it starts.
