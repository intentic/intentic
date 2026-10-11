use crate::docker;
use crate::sandbox::lock;
use crate::sandbox::{container_of, now_ms};
use crate::ui;
use crate::util::{bail, Result};

/* `ic sandbox reset-owner <slug>` — the way back in when the sandbox's owner file cannot be read.

The daemon refuses every sign-in while its owner file exists and cannot be read (a file truncated by a
power loss, a permission an image change broke): treating it as absent would let the next identity to arrive claim the
sandbox. Nothing inside the sandbox can fix that, since fixing it needs a sign-in. This moves the unreadable file aside,
kept beside it for a person to inspect, so the owner's next sign-in binds again the way the first one did, still checked
against the owner this sandbox was set up for. It runs on the machine that runs the sandbox, which is the proof of
ownership a locked-out owner still has. */

// Where the daemon keeps it: on the history volume since 2026-10-06, off the workspace every turn writes, and in the
// workspace before that. The first that exists is the one the running daemon reads: a daemon from before the move has
// only the workspace one, and a later one reads the history copy even where the workspace still holds the old one.
const HISTORY_OWNER_FILE: &str = "identity/owner.json";
const WORKSPACE_OWNER_FILE: &str = "/work/.intentic/identity/owner.json";

fn owner_file(container: &str) -> Option<String> {
    let history = docker::container_env_value(container, "HISTORY_ROOT")
        .unwrap_or_else(|| "/history".to_string());
    [
        format!("{}/{HISTORY_OWNER_FILE}", history.trim_end_matches('/')),
        WORKSPACE_OWNER_FILE.to_string(),
    ]
    .into_iter()
    .find(|path| docker::exec_ok(container, &["test", "-e", path.as_str()]))
}

/// What answering yes does, said before the question. Pure.
fn consequence(slug: &str, named_owner: Option<&str>) -> String {
    let who = match named_owner {
        Some(email) => format!("Only {email} can sign in to bind it, as when it was set up."),
        None => "This sandbox names no owner, so the first Google account to sign in with its connect token becomes its owner.".to_string(),
    };
    format!("{slug}'s owner file cannot be read, so nobody can sign in. This moves it aside so the owner's next sign-in binds the sandbox again. {who}")
}

pub fn run(slug: String, yes: bool) -> Result<()> {
    docker::require_daemon()?;
    let _held = lock::hold_for_person(&slug)?;
    let container = container_of(&slug);
    if !docker::container_exists(&container) {
        bail!("{}", crate::sandbox::missing(&slug));
    }
    if docker::inspect(&container, "{{.State.Running}}").as_deref() != Some("true") {
        bail!(
            "{}",
            ui::explain(
                &format!("{slug} is not running, so its owner file cannot be reset."),
                None,
                Some(&format!(
                    "ic sandbox start {slug}, then run this command again."
                )),
            )
        );
    }
    let Some(owner_file) = owner_file(&container) else {
        ui::quiet(&format!(
            "{slug} has no owner file, so its owner's next sign-in already binds it. Nothing changed."
        ));
        return Ok(());
    };
    // A file that reads is a working sign-in: moving it aside would only hand the sandbox to whoever signs in next.
    if docker::exec_capture(&container, &["cat", owner_file.as_str()])
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|owner| owner["email"].is_string())
    {
        bail!(
            "{}",
            ui::explain(
                "Nothing changed.",
                Some(&format!(
                    "{slug}'s owner file reads fine, so it is not what blocks sign-in."
                )),
                Some(&format!("ic sandbox doctor {slug}")),
            )
        );
    }
    // Who can bind once the file is gone: the owner the platform named (OWNER_EMAIL), signing in with the connect
    // token. Without a connect token any Google account that reaches the daemon would bind, so this refuses; without
    // an owner email the first account to sign in with the token does, which is said before anyone agrees.
    if docker::container_env_value(&container, "CONNECT_TOKEN").is_none() {
        bail!(
            "{}",
            ui::explain(
                "Nothing changed.",
                Some(&format!(
                    "{slug} has no connect token, so after a reset anyone who reached it could claim it."
                )),
                Some("set the sandbox up again with its setup code."),
            )
        );
    }
    let named_owner = docker::container_env_value(&container, "OWNER_EMAIL");
    if !ui::confirm(
        &format!("Reset {slug}'s owner?"),
        &consequence(&slug, named_owner.as_deref()),
        yes,
    )? {
        ui::cancelled();
        return Ok(());
    }
    ui::act(&format!("Moving {slug}'s unreadable owner file aside"));
    let aside = format!("{owner_file}.unreadable-{}", now_ms());
    if !docker::exec_ok(&container, &["mv", owner_file.as_str(), aside.as_str()]) {
        bail!(
            "{}",
            ui::explain(
                "Nothing changed.",
                Some(&format!(
                    "{owner_file} could not be moved aside inside {container}."
                )),
                Some(&format!("ic sandbox doctor {slug}")),
            )
        );
    }
    ui::done(&format!("The unreadable owner file is kept as {aside}."));
    ui::note("Sign in again as this sandbox's owner: the first sign-in binds it, as it did when it was set up.");
    Ok(())
}
