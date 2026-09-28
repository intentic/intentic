use crate::docker;
use crate::sandbox::lock;
use crate::sandbox::{container_of, now_ms};
use crate::util::{bail, Result};

/* `ic sandbox reset-owner <slug>` — the way back in when the sandbox's owner file cannot be read.

The daemon refuses every sign-in while `.intentic/identity/owner.json` exists and cannot be read (a file truncated by a
power loss, a permission an image change broke): treating it as absent would let the next identity to arrive claim the
sandbox. Nothing inside the sandbox can fix that, since fixing it needs a sign-in. This moves the unreadable file aside,
kept beside it for a person to inspect, so the owner's next sign-in binds again the way the first one did, still checked
against the owner this sandbox was set up for. It runs on the machine that runs the sandbox, which is the proof of
ownership a locked-out owner still has. */

const OWNER_FILE: &str = "/work/.intentic/identity/owner.json";

pub fn run(slug: String, yes: bool) -> Result<()> {
    docker::require_daemon()?;
    let _held = lock::hold_for_person(&slug)?;
    let container = container_of(&slug);
    if !docker::container_exists(&container) {
        bail!("sandbox container {container} does not exist on this machine.");
    }
    if docker::inspect(&container, "{{.State.Running}}").as_deref() != Some("true") {
        bail!("{slug} is not running — start it first (ic sandbox start {slug}), then run this again.");
    }
    if !docker::exec_ok(&container, &["test", "-e", OWNER_FILE]) {
        println!("intentic: {slug} has no owner file, so its owner's next sign-in already binds it. Nothing was changed.");
        return Ok(());
    }
    // A file that reads is a working sign-in: moving it aside would only hand the sandbox to whoever signs in next.
    if docker::exec_capture(&container, &["cat", OWNER_FILE])
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|owner| owner["email"].is_string())
    {
        bail!(
            "{slug}'s owner file reads fine, so sign-in is not blocked by it. Nothing was changed."
        );
    }
    // Who can bind once the file is gone: the owner the platform named (OWNER_EMAIL), signing in with the connect
    // token. Without a connect token any Google account that reaches the daemon would bind, so this refuses; without
    // an owner email the first account to sign in with the token does, which is said before anyone agrees.
    if docker::container_env_value(&container, "CONNECT_TOKEN").is_none() {
        bail!("{slug} has no connect token, so after this anyone who reached it could claim it. Nothing was changed; set the sandbox up again with its setup code instead.");
    }
    let named_owner = docker::container_env_value(&container, "OWNER_EMAIL");
    if !yes {
        if !crate::tty::have_tty() {
            bail!(
                "reset-owner changes who can sign in to {slug}; run it again with -y to confirm."
            );
        }
        println!("intentic: {slug}'s owner file cannot be read, so nobody can sign in.");
        println!(
            "          This moves it aside so the owner's next sign-in binds the sandbox again."
        );
        match &named_owner {
            Some(email) => println!("          Only {email} can sign in to bind it, as when it was set up."),
            None => println!("          This sandbox names no owner, so the first Google account to sign in with its connect token becomes its owner."),
        }
        if !crate::tty::confirm("Go ahead?", false) {
            println!("intentic: nothing was changed.");
            return Ok(());
        }
    }
    let aside = format!("{OWNER_FILE}.unreadable-{}", now_ms());
    if !docker::exec_ok(&container, &["mv", OWNER_FILE, &aside]) {
        bail!("could not move {OWNER_FILE} aside inside {container}.");
    }
    println!("intentic: the unreadable owner file is kept as {aside}.");
    println!("          Sign in again as this sandbox's owner: the first sign-in binds it, as it did when it was set up.");
    Ok(())
}
