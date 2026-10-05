use serde_json::Value;

use crate::docker;
use crate::sandbox::{container_of, parked_of};

/* WHICH SIDE OF THIS COMPUTER KEEPS A SANDBOX. On Windows, ic on Windows and ic inside WSL both drive Docker Desktop's
one engine, so each sees every sandbox container on it, and each side's machine agent runs the same background rounds
over all of them: two keepers restarting one sandbox, two probation watches judging one swap, two tidies each deleting
the rollback images the other side's record names and its own does not. A sandbox's container carries the side whose
ic created it (HOST_PLATFORM, connect.rs, replayed by every recreate), and that side alone keeps it: the unattended
verbs below leave the other side's sandboxes alone, and `ic sandbox list` says which they are, so a machine agent need
not even ask. A person's own command still reaches every sandbox. A container from before HOST_PLATFORM names no side
and stays everyone's, as it always was. */

/// This ic's side, as connect.rs stamps it on the containers it creates.
pub fn here() -> &'static str {
    crate::sandbox::connect::host_platform()
}

/// The side to leave a sandbox to: the one that created it, when that is not `here`. Pure.
pub fn elsewhere(created: Option<&str>, here: &str) -> Option<String> {
    created
        .filter(|created| !created.eq_ignore_ascii_case(here))
        .map(str::to_string)
}

/// The side whose ic created the sandbox, off its container's env (or the parked one's, mid-swap); None when neither
/// says or docker does not answer.
pub fn created_on(slug: &str) -> Option<String> {
    [container_of(slug), parked_of(slug)]
        .iter()
        .find_map(|container| docker::container_env_value(container, "HOST_PLATFORM"))
}

/// The other side that keeps this sandbox, when one does.
pub fn kept_elsewhere(slug: &str) -> Option<String> {
    elsewhere(created_on(slug).as_deref(), here())
}

/// The side named off a container's `docker inspect` object, for a listing that already holds one. Pure.
pub fn created_on_inspected(inspected: &Value) -> Option<String> {
    inspected["Config"]["Env"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find_map(|pair| pair.strip_prefix("HOST_PLATFORM="))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// How a side is called where a person reads it. Pure.
pub fn name(side: &str) -> &str {
    match side {
        "windows" => "Windows",
        "linux" => "WSL or Linux",
        other => other,
    }
}

/// What an unattended run says about a sandbox it left to the other side. Pure.
pub fn sentence(side: &str) -> String {
    format!(
        "left alone: ic on {} created it, and the machine agent there keeps it.",
        name(side)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sandbox_is_left_to_the_side_that_created_it() {
        assert_eq!(
            elsewhere(Some("linux"), "windows").as_deref(),
            Some("linux")
        );
        assert_eq!(
            elsewhere(Some("windows"), "linux").as_deref(),
            Some("windows")
        );
        assert_eq!(elsewhere(Some("linux"), "linux"), None);
        assert_eq!(elsewhere(Some("Windows"), "windows"), None);
        assert_eq!(
            elsewhere(None, "windows"),
            None,
            "a container from before HOST_PLATFORM is everyone's"
        );
    }

    #[test]
    fn the_side_is_read_off_an_inspected_container() {
        let inspected = serde_json::json!({ "Config": { "Env": ["PATH=/bin", "HOST_PLATFORM=linux", "HOST_LABEL=rog"] } });
        assert_eq!(created_on_inspected(&inspected).as_deref(), Some("linux"));
        let older = serde_json::json!({ "Config": { "Env": ["PATH=/bin"] } });
        assert_eq!(created_on_inspected(&older), None);
        assert_eq!(created_on_inspected(&serde_json::json!({})), None);
    }

    #[test]
    fn what_is_said_names_the_side_as_a_person_knows_it() {
        assert_eq!(
            sentence("linux"),
            "left alone: ic on WSL or Linux created it, and the machine agent there keeps it."
        );
        assert!(sentence("windows").contains("ic on Windows"));
    }
}
