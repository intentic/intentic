//! Typed views of the sandbox daemon's and the platform's wire: only the fields the app reads, shaped like the contract
//! and checked against its JSON Schema by `tests/wire/`.
//!
//! One file per family of messages, roughly in the order the app meets them. `auth` and `session` sign in, to the
//! platform and to one sandbox. `platform` lists the sandboxes and mints the proofs a daemon takes. `events` is a
//! sandbox's live stream. `agents` and `lanes` are the board. `transcript`, `cards` and `attach` are a conversation.
//! `act` and `push` are what the app sends. Every route the app calls is an `Endpoint` const beside the types it
//! carries, and `endpoint.rs` says how an oRPC procedure becomes a plain HTTP call.
//!
//! Written by hand, not generated: typify panicked on the contract's unions, and quicktype flattened each union into
//! one struct of optional fields. A newer sandbox never fails a frame here. Unknown fields are ignored, a string enum
//! keeps a value it does not know as `Other(text)`, and a tagged union keeps a kind it does not know as `Other(Value)`
//! (`lenient.rs`). The price: a known kind whose shape this build cannot read lands in `Other` too, without a word, so
//! the tests pin every sample of a known kind to its own variant.
//!
//! The daemon's schemas are `_shared/sandbox-contract/contract.lock.json`. The platform keeps no lock, so
//! `scripts/api-schemas.mjs` writes the slice the app calls into `api.schema.json`. Since the contract's objects refuse
//! unknown fields and list their required ones, writing a typed value back out and validating it is what catches a
//! renamed field. What the app does not draw natively yet (card payloads, pages, needs, review findings) stays a
//! `serde_json::Value` inside a typed envelope.

pub mod act;
pub mod agents;
pub mod attach;
pub mod auth;
pub mod cards;
pub mod endpoint;
pub mod events;
pub mod lanes;
pub(crate) mod lenient;
pub mod platform;
pub mod push;
pub mod session;
pub mod transcript;

pub use endpoint::{Endpoint, Method};
pub use lenient::{Millis, Secs, Seq, True};
