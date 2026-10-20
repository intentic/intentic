//! The native mobile client's Rust core: see README.md.

pub mod bridge;
mod client;
pub mod conversation;
mod core;
pub mod net;
pub mod render;
pub mod session;
pub mod store;
pub mod wire;

pub use crate::core::{Core, StartError};
