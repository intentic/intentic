//! The lock screen and admin prompts helper: a process running as SYSTEM in the session on the computer's screen,
//! started by intentic-remoted's Windows service, which can duplicate and type into the secure desktop (the sign-in
//! and lock screen, a UAC prompt, Ctrl+Alt+Del) that no process of the person's own can see.
//!
//! It is a capture and input backend, not a second streaming stack: remoted in the person's session keeps the encoder,
//! the viewers, the clipboard and the sound, and asks the helper over a local pipe ([`pipe`], [`proto`]) to duplicate a
//! monitor. The helper runs the same duplication thread remoted runs itself ([`crate::capture`]) and shares its mirror
//! texture with remoted's pipeline device by an NT handle it duplicates into remoted's process, so a frame crosses the
//! process boundary exactly as it crosses two devices in one process: a GPU copy under a keyed mutex. Only rectangles,
//! the pointer and statuses go down the pipe. Input goes the other way and is typed with SendInput on whichever desktop
//! takes input; Ctrl+Alt+Del becomes a secure attention sequence the service sends ([`serve::Options::sas`]).
//!
//! - [`serve`]: the helper's side, one connection.
//! - [`client`]: remoted's side: [`client::Link`], and a [`Finder`] the Windows platform gives each screen.
//! - [`notice`]: the "someone is connected" notice, drawn on the secure desktop while a monitor is duplicated.

pub mod client;
pub mod notice;
pub mod pipe;
pub mod proto;
pub mod serve;

/// How a screen reaches the helper: what remoted's Windows platform hands cast-win, holding its own policy (the pipe's
/// name, the secret's file, the path the helper must run from).
pub trait Finder: Send + Sync {
    /// The connected helper, connecting when there is none; None when there is no helper here.
    fn link(&self) -> Option<std::sync::Arc<client::Link>>;
    /// Whether a helper is listening now, without connecting: asked every few seconds while this process cannot see
    /// the desktop, so a service set up meanwhile takes over.
    fn present(&self) -> bool;
    /// The helper connected now, without connecting: where input goes while there is one.
    fn current(&self) -> Option<std::sync::Arc<client::Link>>;
}
