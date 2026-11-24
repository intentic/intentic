use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::util::{bail, Fail, Result};

/* bootc AND systemctl AS ic ASKS THEM. Both need root: the image's sudoers rule lets the `intentic` user run them without
a password (`/etc/sudoers.d/intentic-os`), so a run that is not root goes through `sudo -n`, which fails at once rather
than waiting at a password prompt nobody can see. Every call has a deadline: a registry that stops answering mid-pull
must not park the machine agent's tool call for good. */

/// How long `bootc status` may take.
const STATUS_LIMIT: Duration = Duration::from_secs(60);

/// `program args…`, through `sudo -n` unless this run is root already.
pub fn privileged(program: &str, args: &[&str]) -> Command {
    let mut command = if crate::docker::is_root() {
        Command::new(program)
    } else {
        let mut sudo = Command::new("sudo");
        sudo.arg("-n").arg(program);
        sudo
    };
    command.args(args);
    command
}

/// The command line a person would type for it, for messages.
fn spelled(program: &str, args: &[&str]) -> String {
    let sudo = if crate::docker::is_root() {
        ""
    } else {
        "sudo "
    };
    format!("{sudo}{program} {}", args.join(" "))
}

/// Run it with a deadline and keep what it printed; Err with its own words when it fails.
pub fn capture(program: &str, args: &[&str], limit: Duration) -> Result<String> {
    let ran = crate::docker::bounded(privileged(program, args), limit)?;
    if ran.timed_out {
        bail!(
            "{} did not finish within {}s.",
            spelled(program, args),
            limit.as_secs()
        );
    }
    if ran.code != Some(0) {
        let said = if ran.stderr.trim().is_empty() {
            ran.stdout.trim()
        } else {
            ran.stderr.trim()
        };
        bail!("{} failed: {said}", spelled(program, args));
    }
    Ok(ran.stdout)
}

/// Run it with its output on this terminal as it goes (a download's progress), killed at the deadline.
pub fn stream(program: &str, args: &[&str], limit: Duration) -> Result<()> {
    let mut child = privileged(program, args)
        .stdin(Stdio::null())
        .spawn()
        .map_err(|err| Fail(format!("could not run {}: {err}", spelled(program, args))))?;
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            bail!("{} failed ({status}).", spelled(program, args));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "{} did not finish within {} minutes and was stopped.",
                spelled(program, args),
                limit.as_secs() / 60
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// `bootc status --json`, read.
pub fn status() -> Result<Value> {
    let said = capture("bootc", &["status", "--json"], STATUS_LIMIT)?;
    serde_json::from_str(said.trim())
        .map_err(|err| Fail(format!("bootc status answered what is not JSON: {err}")))
}
