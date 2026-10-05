use std::path::Path;

use serde_json::Value;

use crate::docker::{self, Asked};
use crate::sandbox::{container_of, now_ms, parked_of};

/* THE SMALL FILES ic KEEPS ON A SANDBOX'S OWN /history VOLUME, read and written from outside the container.

The Windows side of a PC and each of its WSL distros drive one Docker engine from homes of their own, so a fact that
every one of them must see (who keeps this sandbox and when it last said so, which repairs were made to it, when it
was last backed up) cannot live in any one home: it lives on the sandbox's volume, where `docker cp` and `docker exec`
reach it from every side, the way the channel record's mirror does (mirror.rs). Every call here is bounded, and a
running container gets a file through a rename, so nothing ever reads half of one.

TWO CLOCKS (audit 2026-10, gap 12): a time written into one of these files is the CONTAINER's clock whenever the
container runs (`date` inside it), because the next reader may be another side whose own clock disagrees with this
one's; a stopped container gets this machine's clock, the only one there is to ask. */

/// What reading one of the files came back with. A file docker could not say anything about is `Unreadable`, never
/// `Missing`: "nobody wrote it" licenses an adoption or a delete, and "docker did not answer" licenses nothing.
#[derive(Clone, Debug, PartialEq)]
pub enum Read {
    Found(Value),
    Missing,
    Unreadable(String),
}

/// The placeholder a written body carries where the moment of writing goes (see `write_stamped`).
pub const NOW: &str = "__IC_NOW__";

/// The container that holds a sandbox's volume: the live one, else the one a swap parked.
pub fn holder(slug: &str) -> Option<String> {
    [container_of(slug), parked_of(slug)]
        .into_iter()
        .find(|name| docker::container_exists(name))
}

pub fn running(container: &str) -> bool {
    docker::ask(
        &["inspect", "--format", "{{.State.Running}}", container],
        docker::READ_LIMIT,
    )
    .said()
    .is_some_and(|said| said.trim() == "true")
}

/// The container's own clock in epoch milliseconds; None when it does not run or will not say.
pub fn clock_ms(container: &str) -> Option<u64> {
    let said = docker::ask(
        &["exec", container, "sh", "-c", CLOCK_SCRIPT],
        docker::READ_LIMIT,
    )
    .said()?;
    said.trim().parse().ok()
}

/// The clock to hold a file this container wrote against: its own while it runs, this machine's otherwise.
pub fn now_for(container: &str) -> u64 {
    clock_ms(container).unwrap_or_else(now_ms)
}

/// Milliseconds from `date`, falling back to whole seconds where `%N` is not known (a busybox `date` prints it back
/// verbatim, which is not a number).
const CLOCK_SCRIPT: &str = "at=$(date +%s%3N 2>/dev/null); case \"$at\" in ''|*[!0-9]*) at=$(( $(date +%s) * 1000 ));; esac; echo \"$at\"";

/// One file off the volume, as JSON. Works on a stopped container, as every `docker cp` does.
pub fn read(container: &str, path: &str) -> Read {
    let Ok(dir) = tempfile::tempdir() else {
        return Read::Unreadable("no temporary folder to copy into".to_string());
    };
    let dest = dir.path().join("read.json");
    let source = format!("{container}:{path}");
    match docker::ask(
        &["cp", &source, &dest.to_string_lossy()],
        docker::READ_LIMIT,
    ) {
        Asked::Said(_) => match std::fs::read_to_string(&dest) {
            Ok(text) => parse(&text),
            Err(err) => Read::Unreadable(err.to_string()),
        },
        Asked::Refused(said) if absent(&said) => Read::Missing,
        Asked::Refused(said) => Read::Unreadable(said),
        Asked::Silent => Read::Unreadable("docker did not answer in time".to_string()),
    }
}

/// A file's text as JSON; text that is not is unreadable rather than absent. Pure.
pub fn parse(text: &str) -> Read {
    match serde_json::from_str::<Value>(text.trim()) {
        Ok(value) => Read::Found(value),
        Err(err) => Read::Unreadable(format!("not JSON: {err}")),
    }
}

/// Docker's own words for a path the container does not hold. Pure.
pub fn absent(said: &str) -> bool {
    let lower = said.to_ascii_lowercase();
    lower.contains("could not find the file") || lower.contains("no such file or directory")
}

/// Write `body` at `path`, with every [`NOW`] in it (quoted, as a JSON string) replaced by the moment of writing: the
/// container's clock when it runs, this machine's otherwise. Returns that moment, or None when the file could not be
/// written. Best-effort by construction: every caller writes beside a flow whose own outcome does not depend on it.
pub fn write_stamped(container: &str, path: &str, body: &Value) -> Option<u64> {
    let template = body.to_string();
    if running(container) {
        let ran = docker::ask(
            &[
                "exec",
                container,
                "sh",
                "-c",
                WRITE_SCRIPT,
                "sh",
                path,
                &template,
            ],
            docker::READ_LIMIT,
        );
        return ran.said().and_then(|at| at.trim().parse().ok());
    }
    let at = now_ms();
    copy_in(container, path, &stamp(&template, at)).then_some(at)
}

/// The body with its placeholders replaced by `at`. Pure.
pub fn stamp(template: &str, at: u64) -> String {
    template.replace(&format!("\"{NOW}\""), &at.to_string())
}

/* Inside a running container: the clock read once, the placeholder replaced, the file made beside its final name and
renamed over it, owned like /history itself so the daemon (whatever user it runs as) can read and replace it. */
const WRITE_SCRIPT: &str = "f=\"$1\"; d=\"${f%/*}\"; t=\"$f.tmp.$$\"; \
at=$(date +%s%3N 2>/dev/null); case \"$at\" in ''|*[!0-9]*) at=$(( $(date +%s) * 1000 ));; esac; \
mkdir -p \"$d\" && printf '%s\\n' \"$2\" | sed \"s/\\\"__IC_NOW__\\\"/$at/g\" > \"$t\" && \
{ chown --reference=/history \"$d\" \"$t\" 2>/dev/null || true; } && chmod 644 \"$t\" && mv -f \"$t\" \"$f\" && echo \"$at\"";

/// Into a stopped container, through `docker cp`: nothing reads the file until it starts. A file directly under
/// /history is copied onto its path; a deeper one is staged in a folder of its parent's name and copied into the
/// grandparent, which makes the parent when it is missing (how mirror.rs puts /history/.ic there).
fn copy_in(container: &str, path: &str, text: &str) -> bool {
    let Ok(dir) = tempfile::tempdir() else {
        return false;
    };
    let target = Path::new(path);
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return false;
    };
    let (source, dest) = if parent == Path::new("/history") {
        let staged = dir.path().join(name);
        if std::fs::write(&staged, text).is_err() {
            return false;
        }
        (staged, format!("{container}:{path}"))
    } else {
        let (Some(folder), Some(grandparent)) = (parent.file_name(), parent.parent()) else {
            return false;
        };
        let staged = dir.path().join(folder);
        if std::fs::create_dir_all(&staged).is_err()
            || std::fs::write(staged.join(name), text).is_err()
        {
            return false;
        }
        (
            staged,
            format!("{container}:{}", grandparent.to_string_lossy()),
        )
    };
    matches!(
        docker::ask(
            &["cp", &source.to_string_lossy(), &dest],
            docker::READ_LIMIT
        ),
        Asked::Said(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_that_is_not_there_is_told_apart_from_one_docker_could_not_read() {
        assert!(absent(
            "Error response from daemon: Could not find the file /history/.ic/keeper.json in container x"
        ));
        assert!(absent(
            "cat: /history/.ic/repairs.json: No such file or directory"
        ));
        assert!(!absent(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
        ));
        assert!(!absent("Error: No such container: intentic-sandbox-x"));
        assert_eq!(
            parse("{\"at\": 5}\n"),
            Read::Found(serde_json::json!({"at": 5}))
        );
        assert!(matches!(parse("{half"), Read::Unreadable(_)));
    }

    #[test]
    fn the_moment_of_writing_replaces_every_placeholder_as_a_number() {
        let body = serde_json::json!({ "askedAt": NOW, "nested": { "at": NOW }, "kept": "NOW" });
        let stamped: Value = serde_json::from_str(&stamp(&body.to_string(), 42)).expect("JSON");
        assert_eq!(
            stamped,
            serde_json::json!({ "askedAt": 42, "nested": { "at": 42 }, "kept": "NOW" })
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_scripts_stamp_and_write_in_a_plain_shell() {
        // Run as the container would run them, in a folder of this test's own instead of /history.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("deep").join("keeper.json");
        let template = serde_json::json!({ "side": "linux", "at": NOW }).to_string();
        let out = std::process::Command::new("sh")
            .args(["-c", WRITE_SCRIPT, "sh", &path.to_string_lossy(), &template])
            .output()
            .expect("sh runs");
        assert!(out.status.success(), "{out:?}");
        let at: u64 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .expect("the moment is said back");
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("written")).expect("JSON");
        assert_eq!(written, serde_json::json!({ "side": "linux", "at": at }));
        assert!(at > 1_700_000_000_000, "milliseconds, not seconds: {at}");
        let clock = std::process::Command::new("sh")
            .args(["-c", CLOCK_SCRIPT])
            .output()
            .expect("sh runs");
        let now: u64 = String::from_utf8_lossy(&clock.stdout)
            .trim()
            .parse()
            .expect("a number");
        assert!(now >= at);
    }
}
