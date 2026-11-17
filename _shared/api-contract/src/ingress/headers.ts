// The header a sandbox presents its connect token in, on every platform route that sandbox calls as itself. Declared
// with the daemon's own wire, since the daemon's gate reads the same header; `ic` spells it in Rust (src/platform.rs),
// and ingress.test.ts holds it to this value.
export { CONNECT_TOKEN_HEADER } from "@intentic/sandbox-contract/protocol/headers";
