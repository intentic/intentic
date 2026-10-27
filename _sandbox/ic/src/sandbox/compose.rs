use std::collections::BTreeMap;

use crate::docker;
use crate::sandbox::at_rest;

/* A SANDBOX DOCKER COMPOSE RUNS STAYS COMPOSE'S ACROSS AN `ic` SWAP (2026-10-27).

Compose (and Komodo, which drives it) finds the containers of a service by their `com.docker.compose.*` labels, not by
name, and decides whether one is current from two of them: `config-hash` (the service's config) and `image` (the id of
the image the service names). An `ic` swap (an update, an environment rebuild, a reshape, a connect --replace) used to
start the replacement with ic's labels only. Compose then no longer saw its container. It saw only the one parked as
`<name>.previous`, and its next `up` tried to recreate that one under the name the replacement held: "The container name
… is already in use".

So the replacement inherits Compose's labels as Compose wrote them, and `SANDBOX_MANAGER=compose` (the setup page's
marker that Compose owns the container, which the run contract does not replay). The `image` label is left as it was, not
recomputed: what Compose stores there depends on its version (the image id up to v2, the platform manifest's digest since
v5), and a guess that misses makes Compose recreate the container on its next `up`. Kept, it says what is true of the
service: an environment rebuild on the same base stays running through Compose's next `up`, and a swap onto another base
(or a file that names another image) is recreated from Compose's file then, with no name in the way either time.
A parked container still carrying the same labels would be a second container of the service, which Compose may keep in
place of the live one (checked against Compose 5.6.1), so a Compose sandbox keeps no parked container once its swap has
passed (recreate.rs). */

/// The prefix of every label Compose reads.
const PREFIX: &str = "com.docker.compose.";
/// The project a container belongs to: present on every container Compose made.
pub const PROJECT_LABEL: &str = "com.docker.compose.project";
/// The container a recreate of Compose's replaced: a fact about that one run, not about the service.
const REPLACE_LABEL: &str = "com.docker.compose.replace";
/// SANDBOX_MANAGER's value under Compose (@intentic/sandbox-run COMPOSE_MANAGER).
pub const MANAGER_ENV: &str = "SANDBOX_MANAGER";
pub const COMPOSE_MANAGER: &str = "compose";

/// The Compose labels a container carries; empty when Compose did not make it (or it does not exist).
pub fn labels_of(container: &str) -> BTreeMap<String, String> {
    docker::inspect(container, "{{json .Config.Labels}}")
        .map(|json| compose_labels(&json))
        .unwrap_or_default()
}

/// Out of a container's labels as `docker inspect` prints them, the ones Compose reads. Pure.
fn compose_labels(labels_json: &str) -> BTreeMap<String, String> {
    serde_json::from_str::<Option<BTreeMap<String, String>>>(labels_json.trim())
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, _)| key.starts_with(PREFIX))
        .collect()
}

/// Whether Compose owns the container these labels came from.
pub fn owns(labels: &BTreeMap<String, String>) -> bool {
    labels
        .get(PROJECT_LABEL)
        .is_some_and(|project| !project.is_empty())
}

/// The run options that keep a replacement Compose's: its labels and SANDBOX_MANAGER. Nothing for a container Compose
/// does not own. Pure.
pub fn carry_args(labels: &BTreeMap<String, String>) -> Vec<String> {
    if !owns(labels) {
        return Vec::new();
    }
    let mut args = Vec::with_capacity(labels.len() * 2 + 2);
    for (key, value) in labels {
        if key == REPLACE_LABEL {
            continue;
        }
        args.push("--label".to_string());
        args.push(format!("{key}={value}"));
    }
    args.push("-e".to_string());
    args.push(format!("{MANAGER_ENV}={COMPOSE_MANAGER}"));
    args
}

/// Where Compose's file for a project is, for a sentence to a person: the working directory its labels name.
pub fn working_dir(labels: &BTreeMap<String, String>) -> Option<&str> {
    labels
        .get("com.docker.compose.project.working_dir")
        .map(String::as_str)
        .filter(|dir| !dir.is_empty())
}

/// What a person is told when ic swaps a container Compose runs that has an at-rest key: Compose's next `up` starts it
/// from Compose's file, so that file has to mount the key too, or the daemon cannot open the stores encrypted with it
/// (dyspozytornia under Komodo, 2026-10-27: every capability read answered 500). None when there is no key. Pure.
pub fn key_warning(slug: &str, key: &at_rest::Source) -> Option<String> {
    let file = match key {
        at_rest::Source::Given(path) | at_rest::Source::Own(path) => path.display().to_string(),
        at_rest::Source::Kept(source) => source.clone(),
        at_rest::Source::Off => return None,
    };
    Some(format!(
        "{slug}'s stored credentials are encrypted with the at-rest key {file}. Its Compose file must mount that file read-only at {mount} and set {env}={mount}, or the next `docker compose up` starts it without the key and it cannot read its secrets, connections or AI sign-ins.",
        mount = at_rest::KEY_MOUNT,
        env = at_rest::KEY_ENV,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSPECTED: &str = r#"{
        "com.docker.compose.project": "intentic-sandbox",
        "com.docker.compose.service": "intentic-sandbox",
        "com.docker.compose.container-number": "1",
        "com.docker.compose.oneoff": "False",
        "com.docker.compose.config-hash": "d10d58e7",
        "com.docker.compose.image": "sha256:old",
        "com.docker.compose.replace": "9765861d17fa",
        "com.docker.compose.project.working_dir": "/etc/komodo/stacks/intentic-sandbox",
        "dev.intentic.sandbox": "sandbox-9f87594039e3",
        "org.opencontainers.image.source": "https://github.com/intentic/intentic"
    }"#;

    fn pairs(args: &[String]) -> Vec<(String, String)> {
        args.chunks(2)
            .map(|pair| (pair[0].clone(), pair[1].clone()))
            .collect()
    }

    #[test]
    fn a_compose_sandbox_with_a_key_is_told_its_file_must_mount_it() {
        assert_eq!(key_warning("sandbox-a", &at_rest::Source::Off), None);
        let line = key_warning(
            "sandbox-a",
            &at_rest::Source::Own(std::path::PathBuf::from(
                "/root/.intentic/keys/at-rest-sandbox-a.key",
            )),
        )
        .unwrap();
        assert!(
            line.contains("/root/.intentic/keys/at-rest-sandbox-a.key"),
            "{line}"
        );
        assert!(
            line.contains(at_rest::KEY_MOUNT) && line.contains(at_rest::KEY_ENV),
            "{line}"
        );
    }

    #[test]
    fn only_composes_own_labels_are_read_and_a_container_without_them_is_not_composes() {
        let labels = compose_labels(INSPECTED);
        assert!(owns(&labels));
        assert!(labels.keys().all(|key| key.starts_with(PREFIX)));
        assert_eq!(
            working_dir(&labels),
            Some("/etc/komodo/stacks/intentic-sandbox")
        );
        // `docker run` without a label prints `null`; a broken answer reads as no labels, never as a guess.
        for json in [
            "null",
            "",
            "{\"dev.intentic.kind\":\"sandbox\"}",
            "not json",
        ] {
            let labels = compose_labels(json);
            assert!(!owns(&labels));
            assert!(carry_args(&labels).is_empty());
        }
    }

    #[test]
    fn the_replacement_is_composes_as_compose_wrote_it_and_says_compose_manages_it() {
        let args = carry_args(&compose_labels(INSPECTED));
        let pairs = pairs(&args);
        assert!(pairs.contains(&(
            "--label".into(),
            "com.docker.compose.project=intentic-sandbox".into()
        )));
        assert!(pairs.contains(&(
            "--label".into(),
            "com.docker.compose.config-hash=d10d58e7".into()
        )));
        assert!(pairs.contains(&(
            "--label".into(),
            "com.docker.compose.image=sha256:old".into()
        )));
        assert!(pairs.contains(&("-e".into(), "SANDBOX_MANAGER=compose".into())));
        // The run that replaced some earlier container is not this one, and ic's own labels are stamped elsewhere.
        assert!(!args
            .iter()
            .any(|arg| arg.contains("replace=") || arg.contains("dev.intentic")));
    }
}
