//! intentic-remoted: a person's terminals (and, from phase 2, screens) on one of the owner's computers, served over one
//! uplink per linked sandbox. `main.rs` is the command line; everything else is here so the integration tests can stand
//! the pieces up on their own.

pub mod config;
pub mod daemon;
pub mod environments;
pub mod http;
pub mod media;
pub mod status;
pub mod term;
pub mod token;
pub mod uplink;

/// The release this binary is, stamped by the build (`INTENTIC_REMOTED_VERSION`); `0.0.0` for a source build, as the
/// machine agent's own.
pub const VERSION: &str = match option_env!("INTENTIC_REMOTED_VERSION") {
    Some(version) => version,
    None => "0.0.0",
};
