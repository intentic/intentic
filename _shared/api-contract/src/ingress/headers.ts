// The header a sandbox presents its connect token in, on every platform route that sandbox calls as itself. Declared
// with the daemon's own wire, since the daemon's gate reads the same header; `ic` spells it in Rust (src/platform.rs,
// src/machine/enroll.rs) and the site's cleanup script in shell, and ingress.test.ts holds each to this value.
export { CONNECT_TOKEN_HEADER } from "@intentic/sandbox-contract";
