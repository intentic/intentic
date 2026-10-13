use std::time::Duration;

use serde_json::{json, Value};

use super::policy::{self, Updates};
use super::{bootc, reboot, Paths};
use crate::util::{bail, Result};

/* MOVING THE MACHINE BETWEEN IMAGES. bootc keeps two deployments: the one booted and one more, staged for the next boot
or kept to go back to. `ic os update` downloads a newer image of the channel this machine follows and stages it;
nothing restarts until a reboot, which `--apply` makes the orderly way (reboot.rs). `rollback` queues the other
deployment, `channel` stages the same edition from another channel. A newer image is only ever applied by a reboot
somebody asked for: the daily timer (`--scheduled`) stages, and the owner approves the reboot from the agent's card or
the desktop app. */

/// How long asking the registry whether a newer image is out may take.
const CHECK_LIMIT: Duration = Duration::from_secs(5 * 60);
/// How long a download and stage may take: an OS image is gigabytes, on whatever link the machine has.
const STAGE_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);
/// How long queueing the rollback deployment may take (nothing is downloaded).
const ROLLBACK_LIMIT: Duration = Duration::from_secs(5 * 60);

/// What `ic os update` was asked to do.
pub struct Args {
    pub check: bool,
    pub json: bool,
    pub apply: bool,
    pub scheduled: bool,
}

/// `ic os update [--check [--json]] [--apply] [--scheduled]`.
pub fn run(args: Args) -> Result<()> {
    if args.check {
        return check(args.json);
    }
    if args.scheduled && policy::current().updates == Updates::Off {
        crate::ui::quiet(
            "Automatic OS updates are off (updates: off in /etc/intentic/os.json); nothing was checked.",
        );
        return Ok(());
    }
    crate::ui::note("downloading the newest OS image of this machine's channel and staging it for the next boot…");
    bootc::stream("bootc", &["upgrade"], STAGE_LIMIT)?;
    let staged = super::status::deployment(&bootc::status()?["status"]["staged"]);
    if staged.is_null() {
        crate::ui::done("This machine already runs the newest OS image; nothing was staged.");
        return Ok(());
    }
    let version = staged["version"].as_str().unwrap_or("the new image");
    if !args.apply {
        crate::ui::done(&format!(
            "Staged {version}; it runs from the next boot (ic os reboot, or ic os update --apply)."
        ));
        return Ok(());
    }
    crate::ui::note(&format!("staged {version}; rebooting into it."));
    reboot::orderly()
}

/// `ic os update --check`: ask the registry, then read what bootc learned.
fn check(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    bootc::capture("bootc", &["upgrade", "--check"], CHECK_LIMIT)?;
    let answer = check_value(&bootc::status()?);
    if json {
        super::emit_json(&answer);
    } else if answer["available"] == true {
        crate::ui::done(&format!(
            "A newer OS image is out: {} ({}). ic os update stages it.",
            answer["version"].as_str().unwrap_or("unversioned"),
            answer["digest"].as_str().unwrap_or_default()
        ));
    } else {
        crate::ui::quiet("This machine runs the newest OS image of its channel.");
    }
    Ok(())
}

/// `{available, version, digest}`: a newer image is out when bootc cached one for the booted deployment whose digest is
/// not the booted one's. Pure.
pub fn check_value(bootc: &Value) -> Value {
    let booted = &bootc["status"]["booted"];
    let cached = &booted["cachedUpdate"];
    let digest = cached["imageDigest"].as_str();
    let available = digest.is_some() && digest != booted["image"]["imageDigest"].as_str();
    if !available {
        return json!({ "available": false, "version": null, "digest": null });
    }
    json!({
        "available": true,
        "version": cached["version"].as_str(),
        "digest": digest,
    })
}

/// `ic os rollback [--apply]`.
pub fn rollback(apply: bool) -> Result<()> {
    crate::ui::note("queueing the previous OS deployment for the next boot…");
    bootc::capture("bootc", &["rollback"], ROLLBACK_LIMIT)?;
    if !apply {
        crate::ui::done("The previous OS deployment runs from the next boot (ic os reboot).");
        return Ok(());
    }
    reboot::orderly()
}

/// `ic os channel <name>`: the same edition, from another channel, staged for the next boot.
pub fn channel(name: &str) -> Result<()> {
    if !valid_channel(name) {
        bail!(
            "{}",
            crate::ui::explain(
                &format!("{name:?} is not a channel name."),
                Some("a channel is an image tag: lowercase letters, digits, '.', '_' and '-', starting with a letter or a digit."),
                Some("ic os channel stable"),
            )
        );
    }
    let release = super::release(&Paths::here())?;
    let Some(repository) = release["repository"]
        .as_str()
        .filter(|repository| !repository.is_empty())
    else {
        bail!(
            "{} names no repository, so there is no image to switch to.",
            Paths::here().release().display()
        );
    };
    let target = format!("{repository}:{name}");
    crate::ui::note(&format!(
        "switching to {target} and staging it for the next boot…"
    ));
    bootc::stream("bootc", &["switch", &target], STAGE_LIMIT)?;
    crate::ui::done(&format!(
        "This machine follows {target} now; it runs from the next boot (ic os reboot)."
    ));
    Ok(())
}

/// A channel name: an image tag ic will put after the repository, `[a-z0-9][a-z0-9._-]*`, at most 128 long. Pure.
pub fn valid_channel(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && name.len() <= 128
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::os::status::fixture;

    #[test]
    fn an_update_is_out_when_bootc_cached_one_unlike_what_runs() {
        assert_eq!(
            check_value(&fixture::bootc_status()),
            json!({
                "available": true,
                "version": "2026.10.14.0",
                "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
            })
        );
    }

    #[test]
    fn nothing_cached_or_the_same_digest_is_no_update() {
        let mut bootc = fixture::bootc_status();
        let none = json!({ "available": false, "version": null, "digest": null });
        bootc["status"]["booted"]["cachedUpdate"]["imageDigest"] =
            bootc["status"]["booted"]["image"]["imageDigest"].clone();
        assert_eq!(check_value(&bootc), none);
        bootc["status"]["booted"]["cachedUpdate"] = Value::Null;
        assert_eq!(check_value(&bootc), none);
        assert_eq!(check_value(&json!({})), none);
    }

    #[test]
    fn a_channel_is_a_tag_and_nothing_a_shell_or_a_registry_would_read_otherwise() {
        for good in ["stable", "beta", "2026.10", "rc-1", "a_b", "0"] {
            assert!(valid_channel(good), "{good}");
        }
        for bad in [
            "",
            "Stable",
            "-beta",
            ".x",
            "beta:latest",
            "beta/x",
            "be ta",
            "beta@sha256",
            "ü",
        ] {
            assert!(!valid_channel(bad), "{bad}");
        }
        assert!(!valid_channel(&"a".repeat(129)));
    }

    #[test]
    fn every_update_check_the_contract_shows_is_the_shape_made_here() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/golden/intentic-os.json"
        ))
        .expect("the golden file is JSON");
        for example in golden["updateCheck"]
            .as_array()
            .expect("updateCheck examples")
        {
            let mut bootc = fixture::bootc_status();
            if example["available"] == true {
                bootc["status"]["booted"]["cachedUpdate"]["version"] = example["version"].clone();
                bootc["status"]["booted"]["cachedUpdate"]["imageDigest"] =
                    example["digest"].clone();
            } else {
                bootc["status"]["booted"]["cachedUpdate"] = Value::Null;
            }
            assert_eq!(&check_value(&bootc), example);
        }
    }
}
