use serde_json::{json, Value};

use crate::docker;
use crate::sandbox::{inside, power, resolve_slug, side, CONTAINER_PREFIX};
use crate::ui;
use crate::util::{bail, Result};

/* ONE ACTIVE HOST PER SANDBOX: THE TAKEOVER MARKER (2026-11-11).

A connect token can sit in containers on two machines (a stale copy on the machine a sandbox moved away from), and the
edge keeps whichever dials first, so the stale copy could hold the address while the real one sat refused. The platform
now names one active host per sandbox, and moves it only when a copy announces with a takeover newer than the active
host's own (api active-host.ts); every other copy is told so and goes on standby (the daemon's standby.ts, `fix`'s
`elsewhere`).

A takeover is a one-shot file on the container's own /history volume, `/history/.ic/takeover.json`:
`{"v":1,"at":<epoch ms>,"by":"move"|"claim","machineId":"<ic machine id>","host":"<host label>"}`. ic writes it when a
person says this machine runs the sandbox: a move here (`by: move`) or `ic sandbox claim` (`by: claim`). The daemon
reads it at its next announce, sends it, and deletes it once an announce is accepted. `at` is the container's clock when
it runs, this machine's otherwise (inside.rs's TWO CLOCKS); it is compared only with an earlier takeover's.

While a takeover is waiting the copy is never treated as on standby (`pending`), so neither the daemon's boot nor
`ic sandbox fix` holds back the copy the person just asked to run. */

/// Where the marker lives on the sandbox's volume (the daemon reads the same path).
pub const MARKER_PATH: &str = "/history/.ic/takeover.json";

/// Where a copy told it is not the active one says so (the daemon writes it, `fix` reads it).
pub const STANDBY_PATH: &str = "/history/.ic/standby.json";

/// Who wrote a takeover.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    /// The sandbox was moved to this machine. Written by the move between devices, which lands beside this module.
    #[allow(dead_code)]
    Move,
    /// `ic sandbox claim`: the owner's "run it here".
    Claim,
}

impl By {
    fn word(self) -> &'static str {
        match self {
            By::Move => "move",
            By::Claim => "claim",
        }
    }
}

/// The marker's body, with the moment of writing left as inside.rs's placeholder. Pure.
pub fn body(by: By, machine_id: Option<&str>, host: Option<&str>) -> Value {
    let mut body = json!({ "v": 1, "at": inside::NOW, "by": by.word() });
    if let Some(id) = machine_id.map(str::trim).filter(|id| !id.is_empty()) {
        body["machineId"] = json!(id);
    }
    if let Some(host) = host.map(str::trim).filter(|host| !host.is_empty()) {
        body["host"] = json!(host);
    }
    body
}

/// The machine's name a container answers to, out of its `docker inspect`: its HOST_LABEL, else its hostname. Pure.
pub fn host_of(inspected: &Value) -> Option<String> {
    let config = &inspected["Config"];
    let label = config["Env"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find_map(|pair| pair.strip_prefix("HOST_LABEL="))
        .map(str::trim)
        .filter(|label| !label.is_empty());
    label
        .or_else(|| {
            config["Hostname"]
                .as_str()
                .map(str::trim)
                .filter(|name| !name.is_empty())
        })
        .map(str::to_string)
}

/// Write the takeover marker into `container`'s history: `inspected` is its `docker inspect` when the caller already
/// holds it (one object, or docker's one-element array), read here otherwise.
pub fn mark(container: &str, inspected: Option<&Value>, by: By) -> Result<()> {
    let read;
    let inspected = match inspected {
        Some(value) => Some(value),
        None => {
            read = docker::inspect(container, "{{json .}}")
                .and_then(|json| serde_json::from_str::<Value>(json.trim()).ok());
            read.as_ref()
        }
    };
    let host = inspected
        .map(|value| value.get(0).unwrap_or(value))
        .and_then(host_of);
    let body = body(by, side::machine_id().as_deref(), host.as_deref());
    if inside::write_stamped(container, MARKER_PATH, &body).is_none() {
        bail!(
            "could not write the takeover marker into {container}'s history; is docker answering? Try again: ic sandbox claim"
        );
    }
    Ok(())
}

/// Whether a takeover marker waits in the container's history: a copy that has one is never on standby. Unreadable
/// reads as none, so a docker that does not answer never licenses a start either.
pub fn pending(container: &str) -> bool {
    matches!(inside::read(container, MARKER_PATH), inside::Read::Found(_))
}

/// `ic sandbox claim [slug]`: this machine runs the sandbox. Writes the takeover marker and starts the sandbox, or
/// restarts it when it runs, so its daemon announces the takeover now rather than at its next hourly heartbeat. The
/// copy elsewhere is told at its own next announce that it is not the active one and goes on standby.
pub fn claim(slug: Option<String>) -> Result<()> {
    docker::require_daemon()?;
    let slug = resolve_slug(slug, "ic sandbox claim")?;
    let container = format!("{CONTAINER_PREFIX}{slug}");
    if !docker::container_exists(&container) {
        bail!("{slug} has no container on this machine to run it here; set it up or move it here first");
    }
    ui::act(&format!("Making this machine the one that runs {slug}"));
    mark(&container, None, By::Claim)?;
    let next = if inside::running(&container) {
        power::Power::Restart
    } else {
        power::Power::Start
    };
    power::run(next, Some(slug.clone()))?;
    ui::note(&format!(
        "{slug} announces the takeover as it starts; any other copy of it goes on standby at its next check-in."
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_names_who_wrote_it_and_leaves_out_what_is_unknown() {
        assert_eq!(
            body(By::Claim, Some(" m-1 "), Some("z440")),
            json!({ "v": 1, "at": inside::NOW, "by": "claim", "machineId": "m-1", "host": "z440" })
        );
        assert_eq!(
            body(By::Move, None, Some("  ")),
            json!({ "v": 1, "at": inside::NOW, "by": "move" })
        );
        // Stamped as every file on the volume is: the moment is a number, as the platform's contract reads it.
        let stamped: Value =
            serde_json::from_str(&inside::stamp(&body(By::Move, None, None).to_string(), 7))
                .expect("JSON");
        assert_eq!(stamped, json!({ "v": 1, "at": 7, "by": "move" }));
    }

    #[test]
    fn the_host_is_the_containers_host_label_else_its_hostname() {
        let labelled = json!({ "Config": { "Env": ["PATH=/bin", "HOST_LABEL= z440 "], "Hostname": "abc123" } });
        assert_eq!(host_of(&labelled).as_deref(), Some("z440"));
        let bare = json!({ "Config": { "Env": ["HOST_LABEL="], "Hostname": "abc123" } });
        assert_eq!(host_of(&bare).as_deref(), Some("abc123"));
        assert_eq!(host_of(&json!({})), None);
    }

    #[test]
    fn the_paths_are_the_ones_the_daemon_reads() {
        assert_eq!(MARKER_PATH, "/history/.ic/takeover.json");
        assert_eq!(STANDBY_PATH, "/history/.ic/standby.json");
    }
}
