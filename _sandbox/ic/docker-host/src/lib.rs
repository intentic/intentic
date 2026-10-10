//! Docker on a host, as `ic` and the desktop app both read it.
//!
//! Two binaries ask the same questions of the same machine: why the engine refused (`ic`'s `docker.rs`, the desktop's
//! `scripts.rs`), and where Docker Desktop is installed (`ic`'s Windows probe, its repairs, the desktop's start). Each
//! used to keep its own answer, and they drifted: the desktop could not tell a broken engine from a slow one, and three
//! of the five Docker Desktop lookups knew only `C:\Program Files`. This crate is the one copy of the readings. It
//! spawns nothing: running a probe, with a deadline, stays with each caller, which hands the answer in. Since 2026-10-10
//! it also says how all three reach Intentic's engine (`engine_pipe`): its named pipe while the relay serves it.

pub mod desktop_app;
pub mod engine_pipe;
pub mod powershell;
pub mod refusal;
pub mod wsl_path;
