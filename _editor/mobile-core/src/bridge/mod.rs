//! How the app talks to the core. Kotlin (and later Swift) sends a [`Request`] as JSON through one function and gets
//! [`Event`]s back as JSON through one callback; `messages.rs` is the only place their shapes are written, and
//! typeshare generates the app's types from it (`scripts/messages.sh`). Rows a list draws every frame cross by
//! hand-written functions instead, as a string and an `int[]` of spans, so a scroll never parses JSON.

mod jni;
mod messages;

pub use messages::{
    BoardCard, BoardLane, CardAnswer, CardOption, CardQuestion, CardRow, CardRowKind, Config,
    Event, LinkState, OfferKind, Outcome, PermissionDecision, Request, RowChange, SandboxRow,
    SessionState, WebDaemonSession,
};
