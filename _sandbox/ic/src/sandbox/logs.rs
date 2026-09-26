use crate::docker;
use crate::sandbox::{resolve_slug, CONTAINER_PREFIX};
use crate::util::{bail, Result};

/* `ic sandbox logs` — a sandbox's own log, read through the one host authority rather than by whoever asks docker. */

/// The last `tail` lines of the sandbox container's log, both streams. Read-only: the machine agent's Logs button and
/// `sandbox_logs` tool run this, so what a model reads and what a person types on the machine are one command.
pub fn run(slug: Option<String>, tail: u32) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, "ic sandbox logs")?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if !docker::container_exists(&container) {
        bail!("sandbox container {container} does not exist on this machine.");
    }
    docker::logs_passthrough(&container, tail)
}
