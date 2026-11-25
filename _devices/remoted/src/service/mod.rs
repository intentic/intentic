//! The lock screen and admin prompts service (Windows): `intentic-remoted service install|uninstall|status|run` and the
//! SYSTEM helper it keeps in the session on the computer's screen (`intentic-remoted desktop-helper`). Opt-in: the
//! machine agent installs it only when the owner asks (`remote_service`), with one administrator's yes.
//!
//! - **Why a service at all.** A process of the person's own cannot see or type into the secure desktop: the sign-in
//!   and lock screen's password box, a UAC prompt, Ctrl+Alt+Del. A process running as SYSTEM in that session can, and
//!   only a service can start one there (and send Ctrl+Alt+Del).
//! - **One binary.** The service is this program, copied to `%ProgramData%\Intentic\Remoted\bin` (which only an
//!   administrator can write, so the user's own programs cannot swap the code that runs as SYSTEM). It starts the
//!   helper, also this program, as SYSTEM in the console session, following the console from session to session.
//! - **A capture and input backend, not a second stack.** The helper duplicates monitors and types input for the
//!   person's remoted over a local pipe (cast-win's `helper`); remoted keeps the encoder, viewers, clipboard and sound,
//!   and runs its screens on the helper whenever it reaches it, on its own duplication otherwise.
//! - **Who may connect.** The pipe's access list names SYSTEM and the user who installed it; the helper accepts only a
//!   process in its own session running from one of the paths installed (`--client`, the agent's own remoted), and only
//!   after it says the per-boot secret the service writes where only that user can read it. remoted in turn checks the
//!   pipe's server runs from the service's own path in its session. Nothing listens on a network.
//! - **Administrator runs** (`service admin-run`, [`admin`]). The helper also starts a command for the person's remoted
//!   with the signed-in person's own elevated token in their session, which is what clicking Yes on a UAC prompt
//!   gives, and relays its output and exit code back: on a pipe and a protocol of their own, with the same checks, and
//!   only with a grant that a sandbox key pinned at install (`--trust`) signed for exactly that PowerShell command.

pub mod admin;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::finder::finder;

/// A security descriptor naming this process's user alone: the control endpoint's ([`crate::control`]).
#[cfg(windows)]
pub(crate) fn owner_only_descriptor() -> Result<windows::secure::Descriptor, String> {
    windows::secure::Descriptor::new(&format!(
        "D:P(A;;GA;;;{})",
        windows::secure::current_user_sid()?
    ))
}

/// `service status`'s answer, for `/info`.
#[cfg(windows)]
pub fn windows_status() -> serde_json::Value {
    windows::status()
}

/// `intentic-remoted service …`: the exit code.
pub fn main(args: &[String]) -> i32 {
    #[cfg(windows)]
    return windows::cli(args);
    #[cfg(not(windows))]
    {
        if args.first().map(String::as_str) == Some("admin-run") {
            return admin::not_windows(&args[1..]);
        }
        println!(
            "{}",
            serde_json::json!({
                "supported": false,
                "reason": "the lock screen and admin prompts service is for Windows; this computer's own sign-in screen is not served",
            })
        );
        0
    }
}

/// `intentic-remoted desktop-helper`: the SYSTEM helper the service starts in the console session.
pub fn helper_main() -> i32 {
    #[cfg(windows)]
    return windows::helper::main();
    #[cfg(not(windows))]
    {
        eprintln!("intentic-remoted: desktop-helper is Windows' only");
        2
    }
}
