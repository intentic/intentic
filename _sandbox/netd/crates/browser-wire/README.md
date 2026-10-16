# browser-wire

Everything a browser sees of a sandbox's netd and of the edge in front of it outside the daemon's oRPC contract: the terminal socket, netd's vitals, the WebTransport path and the verdict the edge refuses a request with.

- The only definition of those names and shapes. Both ends build it: [netd](../netd) answers the terminal and vitals
  paths, and the edge (`_platform/ingress`) answers the WebTransport session and sets the verdict header.
- Standalone rather than a member of netd's workspace, like [tunnel](../tunnel), because the edge builds it by path
  from its own workspace.
- The editor reads the same types in TypeScript. `cargo test -p browser-wire` writes them, with a manifest the
  contract's lock pins, into `_shared/sandbox-contract/src/netd/generated/`; edit the Rust, never the generated file.
- Nothing here crosses the control socket between netd and Node. That is [netd-wire](../netd-wire).

## Key files

- [src/lib.rs](src/lib.rs) — every path, header, message and verdict, and the test that writes their TypeScript.
- [Cargo.toml](Cargo.toml) — why the crate stands outside netd's workspace.
- [../netd/src/vitals.rs](../netd/src/vitals.rs) — where netd answers the vitals this crate shapes.
