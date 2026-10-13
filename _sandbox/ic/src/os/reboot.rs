use std::time::Duration;

use serde_json::{json, Value};

use super::{bootc, Paths};
use crate::sandbox::listing::{self, Seen};
use crate::sandbox::{intent, now_ms, resume};
use crate::util::{Fail, Result};

/* A REBOOT THE SANDBOXES ARE TOLD ABOUT. Restarting the machine restarts every sandbox on it, and from inside one that
reads like a crash: the agent turns it cuts wait in Attention for a person. So before ic reboots the machine it does what
it does before any restart it makes of a sandbox: it leaves each running one the daemon's resume ask
(`/history/restart-resume.json`, resume.rs; `--no-resume` leaves the cut turns for a person) and says why on its volume
(intent.rs). Then it records which sandboxes ran (`/var/lib/intentic-os/expected-running.json`), which the next boot's
health check (health.rs) holds the machine to, and reboots through systemd. The image's `intentic-os-record` unit runs
`ic os record` at every orderly shutdown too, so a reboot from anywhere else leaves the same record. */

/// How long systemd may take to accept the reboot.
const REBOOT_LIMIT: Duration = Duration::from_secs(60);

/// `ic os record`: which sandboxes run now, written for the next boot.
pub fn record() -> Result<()> {
    let seen = listing::seen()?;
    let slugs = running(&seen);
    write_expected(&Paths::here(), &slugs)?;
    crate::ui::done(&recorded_sentence(&slugs));
    Ok(())
}

/// The sandboxes of a listing that run, by slug.
fn running(seen: &[Seen]) -> Vec<String> {
    seen.iter()
        .filter(|seen| seen.running)
        .map(|seen| seen.slug.clone())
        .collect()
}

fn recorded_sentence(slugs: &[String]) -> String {
    if slugs.is_empty() {
        "Recorded that no sandbox runs; the next boot expects none.".to_string()
    } else {
        format!(
            "Recorded {} running for the next boot to expect: {}.",
            crate::util::plural(slugs.len(), "sandbox"),
            slugs.join(", ")
        )
    }
}

/// `{ "recordedAt": <ms>, "slugs": [...] }`. Pure.
pub fn expected_body(at: u64, slugs: &[String]) -> Value {
    json!({ "recordedAt": at, "slugs": slugs })
}

fn write_expected(paths: &Paths, slugs: &[String]) -> Result<()> {
    let body = expected_body(now_ms(), slugs);
    super::write_atomic(&paths.expected_running(), format!("{body}\n").as_bytes())
}

/// The slugs the last record expects to run; none when nothing was recorded. A slug that is not one is dropped. Pure
/// over the file's value.
pub fn expected_slugs(recorded: Option<&Value>) -> Vec<String> {
    recorded
        .and_then(|recorded| recorded["slugs"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|slug| crate::sandbox::is_slug(slug))
        .map(str::to_string)
        .collect()
}

/// The orderly reboot every `--apply` and `ic os reboot` ends in: each running sandbox asked to resume what it cuts and
/// told why, the record written, then systemd's reboot. A sandbox docker cannot list, or a record that cannot be
/// written, is said and does not stop the reboot: the shutdown unit records again on the way down.
pub fn orderly() -> Result<()> {
    match listing::seen() {
        Ok(seen) => {
            let slugs = running(&seen);
            for sandbox in seen.iter().filter(|sandbox| sandbox.running) {
                intent::leave(
                    &sandbox.container,
                    intent::Action::Restart,
                    "the machine reboots (ic os)",
                );
                if resume::ask(&sandbox.container) {
                    crate::ui::note(&format!(
                        "asked {} to pick up its agents' interrupted turns after the reboot.",
                        sandbox.slug
                    ));
                }
            }
            match write_expected(&Paths::here(), &slugs) {
                Ok(()) => crate::ui::note(&recorded_sentence(&slugs)),
                Err(err) => crate::ui::warn(&format!(
                    "the running sandboxes were not recorded ({}); the shutdown unit records them on the way down.",
                    err.0
                )),
            }
        }
        Err(err) => crate::ui::warn(&format!(
            "the sandboxes could not be listed, so none was asked to resume its turns: {}",
            err.0.lines().next().unwrap_or_default()
        )),
    }
    crate::ui::note("rebooting now.");
    bootc::capture("systemctl", &["reboot"], REBOOT_LIMIT)
        .map(|_| ())
        .map_err(|err| Fail(format!("the reboot was refused: {}", err.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_is_the_shape_health_reads_back() {
        let slugs = vec!["work".to_string(), "lab".to_string()];
        let body = expected_body(1_791_240_330_000, &slugs);
        assert_eq!(
            body,
            json!({ "recordedAt": 1_791_240_330_000u64, "slugs": ["work", "lab"] })
        );
        assert_eq!(expected_slugs(Some(&body)), slugs);
    }

    #[test]
    fn nothing_recorded_expects_nothing_and_a_bad_slug_is_never_expected() {
        assert!(expected_slugs(None).is_empty());
        assert!(expected_slugs(Some(&json!({ "recordedAt": 1 }))).is_empty());
        assert!(expected_slugs(Some(&json!("work"))).is_empty());
        assert_eq!(
            expected_slugs(Some(&json!({ "slugs": ["work", "../etc", 4, "", "lab"] }))),
            vec!["work".to_string(), "lab".to_string()]
        );
    }

    #[test]
    fn only_running_sandboxes_are_recorded() {
        let seen = vec![
            Seen {
                slug: "work".to_string(),
                container: "intentic-sandbox-work".to_string(),
                running: true,
            },
            Seen {
                slug: "held".to_string(),
                container: "intentic-sandbox-held".to_string(),
                running: false,
            },
        ];
        assert_eq!(running(&seen), vec!["work".to_string()]);
        assert!(recorded_sentence(&[]).contains("no sandbox"));
        assert!(recorded_sentence(&running(&seen)).contains("1 sandbox running"));
    }

    #[test]
    fn the_record_lands_whole_where_health_looks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::under(dir.path());
        write_expected(&paths, &["work".to_string()]).expect("written");
        let read = crate::os::read_json(&paths.expected_running());
        assert_eq!(expected_slugs(read.as_ref()), vec!["work".to_string()]);
        assert!(read.unwrap()["recordedAt"].as_u64().unwrap() > 1_700_000_000_000);
    }
}
