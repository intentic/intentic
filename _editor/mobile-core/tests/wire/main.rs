//! Holds src/wire/'s hand-written types to the contract. Each sample under src/wire/samples/ is checked three ways:
//! it is valid against its schema (so the samples stay realistic), it decodes into its Rust type, and that type written
//! back out is valid against the same schema. The contract's objects refuse unknown fields and list their required
//! ones, so the last check fails on a field the Rust renamed, dropped while required, or typed wrongly.

mod board;
mod contract;
mod conversation;
mod live;
mod platform;
