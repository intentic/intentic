// SANDBOX-TO-SANDBOX (docs/architecture/messages.md): every wire and editor shape of contacts, messages and calls,
// imported from here. s2s-identity.ts: the identity document, keys, addresses and grants. s2s-wire.ts: the envelope, its
// payload kinds, the doors' refusals, sessions and calls. s2s-views.ts: what the Messages tab and the `messages` command
// read and send, and the pairing and upgrade exchanges. contact-need.ts: the card an agent raises to add or accept a
// contact. The primitives that make and check them are protocol/s2s/ (`@intentic/sandbox-contract/s2s`).
export * from "./s2s-identity.js";
export * from "./s2s-wire.js";
export * from "./s2s-views.js";
export * from "./contact-need.js";
