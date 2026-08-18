use std::time::{SystemTime, UNIX_EPOCH};

use crate::docker;
use crate::logfile::Log;

/* TELLING THE SANDBOX THAT ITS NEXT UPDATE IS ALREADY DOWNLOADED.
 *
 * The daemon inside the container cannot see any of this by itself: it holds no host Docker socket, so it
 * cannot look at the host's images, and the channel record lives under the user's home on the HOST, which the
 * container never mounts. Left to itself all it can say is "a newer release exists" — which is what made every
 * update card quote a few minutes of downtime for what is really seconds of downtime behind a download.
 *
 * So the host tells it, in one small file, written the moment `ic sandbox prepare` finishes.
 *
 * WHY IT GOES ON THE HISTORY VOLUME. /history is daemon-owned and outside the agent's /work mount — the same
 * placement, for the same reason, as the activity ledger and the usage ledger. Put this under /work instead
 * and the file would be agent-writable, which would make "an update is ready to apply" a fact any agent in the
 * sandbox could assert about the host. It only drives card copy today, and that is exactly the kind of thing
 * that stops being true later.
 *
 * It is written and removed with `docker exec` rather than `docker cp` so the file is owned by the container's
 * own user throughout — a root-owned file dropped into a daemon-owned directory is a file the daemon may not
 * be able to replace. Temp-then-rename, like every other record this repo writes. */

/// Where the daemon looks. Its config takes an overridable `historyRoot` whose default this matches; the
/// override exists for isolated turns, which are never the target of an update.
const MARKER: &str = "/history/update-staged.json";

/// Tell the sandbox what is built and waiting for it. Best-effort by construction: the staged image and the
/// host record are the real outcome of a prepare, and a container that is stopped, wedged or too old to hold
/// the file must not turn a successful build into a failed command. The card simply reads as it did before.
pub fn announce(container: &str, version: Option<&str>, channel: &str, image: &str, log: &Log) {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let mut fields = vec![
        format!("\"channel\":\"{}\"", escape(channel)),
        format!("\"image\":\"{}\"", escape(image)),
        format!("\"at\":{at}"),
    ];
    if let Some(version) = version {
        fields.insert(0, format!("\"version\":\"{}\"", escape(version)));
    }
    let json = format!("{{{}}}", fields.join(","));
    let script = format!("cat > {MARKER}.tmp && mv {MARKER}.tmp {MARKER}");
    log.section("announcing the staged update to the sandbox");
    log.line(&json);
    let _ = docker::capture_with_stdin(
        &["exec", "-i", container, "sh", "-c", &script],
        json.as_bytes(),
        log,
    );
}

/// Take the offer back — the sandbox has just moved onto an image, or what was staged stopped being the right
/// answer. Silent and best-effort: a container that is mid-swap has nothing to be told.
pub fn withdraw(container: &str) {
    docker::quiet(&["exec", container, "rm", "-f", MARKER]);
}

/// JSON string escaping for the three values that reach the marker. Two of them are docker references, which
/// cannot contain either character — the third is a `--channel` the user typed, and a channel named `a"b` must
/// produce an unreadable marker rather than a file that reads as something else entirely.
fn escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            // Control characters have no place in a tag or a version; dropping them keeps the file parseable
            // rather than inventing an escape for something that cannot legitimately arrive.
            c if (c as u32) < 0x20 => Vec::new(),
            c => vec![c],
        })
        .collect()
}

/// The readable version an image reports, by asking the image itself — the same "the contract ships with the
/// image" move every other probe in this binary makes. `None` for anything that does not answer cleanly: an
/// older build with no `--version`, a daemon that refused the run, output in a shape this does not recognise.
/// Every reader treats the absence as "ready, version unknown", never as nothing being ready.
pub fn image_version(image: &str) -> Option<String> {
    version_token(&docker::try_capture(&[
        "run",
        "--rm",
        "--entrypoint",
        "intentic",
        image,
        "--version",
    ])?)
}

/// The first version-shaped token in `--version` output, so a CLI that prints `intentic 1.4.2` and one that
/// prints `1.4.2` both answer. Anything else answers None rather than a guess: a wrong version on the update
/// card is worse than no version, because the card would name a release the user is not about to get.
fn version_token(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .map(|token| token.trim_start_matches('v'))
        .find(|token| is_version(token))
        .map(str::to_string)
}

/// Three dot-separated numbers, optionally trailed by a prerelease or build suffix — `1.4.2` and `1.4.2-rc.1`
/// both qualify, and the whole token (suffix included) is what gets reported: a prerelease IS the version the
/// daemon will report about itself, and trimming it would name a release that was never published.
fn is_version(token: &str) -> bool {
    let core = token.split_once(['-', '+']).map_or(token, |(core, _)| core);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_read_out_of_whatever_shape_the_cli_prints_it_in() {
        assert_eq!(version_token("1.4.2").as_deref(), Some("1.4.2"));
        assert_eq!(version_token("intentic 1.4.2\n").as_deref(), Some("1.4.2"));
        assert_eq!(version_token("v1.4.2").as_deref(), Some("1.4.2"));
        // A prerelease keeps its suffix: it is the version the daemon will report about itself.
        assert_eq!(
            version_token("1.4.2-rc.1").as_deref(),
            Some("1.4.2-rc.1"),
            "a prerelease is still a version"
        );
    }

    #[test]
    fn output_with_no_version_in_it_answers_nothing_rather_than_a_guess() {
        // An image too old to know `--version` prints its help, or an error, or nothing at all. The card then
        // says an update is ready without naming it, which is true — naming the wrong release would not be.
        assert_eq!(version_token(""), None);
        assert_eq!(version_token("unknown option --version"), None);
        assert_eq!(version_token("1.4"), None);
        assert_eq!(version_token("a.b.c"), None);
    }

    #[test]
    fn a_channel_a_user_typed_cannot_break_the_marker_open() {
        // The one value here that is not a docker reference. A quote must be escaped, not passed through:
        // this file is parsed by the daemon, and a channel named `a"b` would otherwise end the string early.
        assert_eq!(escape(r#"a"b"#), r#"a\"b"#);
        assert_eq!(escape(r"a\b"), r"a\\b");
        assert_eq!(escape("core-stable"), "core-stable");
        assert_eq!(escape("a\nb"), "ab");
    }
}
