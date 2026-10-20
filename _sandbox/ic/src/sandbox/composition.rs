use std::time::Duration;

use serde_json::Value;

use crate::docker;
use crate::logfile::Log;
use crate::sandbox::at_rest::{KEY_ENV, KEY_MOUNT};
use crate::sandbox::recreate::{overlay_base, rewrite_from};
use crate::sandbox::target_probe::{self, error_line, last_line, Probe, DOCKER_COULD_NOT_RUN};
use crate::ui;
use crate::util::sha256_hex;

/* THE OVERLAY A SWAP BUILDS IS THE TARGET'S COMPOSITION, NOT THE RUNNING DAEMON'S (2026-10-20).

A sandbox's environment overlay is composed by its daemon: every capability's fragment, the owner's custom section, and
the feature packs a connected provider or the privacy shield wants, each left out where the base image already bakes it
(the base's /opt/packs stamps). The composition is the daemon's code reading the base's facts, so it belongs to a
version. A swap used to copy the overlay the RUNNING daemon composed for its own base and only rewrite its FROM: on an
update or a dev rebuild that changed the daemon's pack steps (a pack baked into the new base, a pack's steps edited, a
fragment changed), the new daemon recomposed on its first boot, got a different hash than the one the container was
stamped with, and the Environment card said one more rebuild was pending right after the swap.

So the target image is asked. Its own composer (`compose-overlay.js`, the daemon's `composedOverlay`, one function with
what the daemon composes at boot) runs over read-only mounts of the sandbox's data with the container's runner-set
environment replayed, and prints the overlay its daemon will compose; ic builds exactly that and stamps its hash, so the
first boot agrees by construction. An image from before the composer, or one whose composer fails, gets what it always
got: the running daemon's overlay rebased onto it, said out loud. The contract's ComposedOverlayLineSchema is the line;
golden/compose-overlay.json holds examples this reader is held to. */

/// The image's own composer. An image built before it has no such file.
const SCRIPT: &str = "/opt/sandbox/dist/environment/compose-overlay.js";

/// The one answer format this binary reads.
const FORMAT: u64 = 1;

/// Composing reads a handful of files, after the daemon's modules load: two minutes is a hang.
const LIMIT: Duration = Duration::from_secs(120);

/// The probe's name, `<prefix><slug>`, outside CONTAINER_PREFIX like every probe (target_probe.rs).
const NAME_PREFIX: &str = "intentic-compose-";

/// What the composer's config reads off the container's environment, replayed from the running container as the
/// runner set it, so it composes as that sandbox's daemon would: where the data and the AI logins are, whether it is
/// a hosted VM (which strips runtime directives), the key that opens the encrypted provider accounts a pack is wanted
/// for, and the overlay the container runs (an emptied recipe keeps a bare overlay rather than none). The base is the
/// composer's `--base`, never replayed: it is what the swap moves onto.
const REPLAYED_ENV: [&str; 6] = [
    "WORKSPACE_ROOT",
    "HISTORY_ROOT",
    "AGENT_AUTH_DIR",
    "SANDBOX_VM",
    "SANDBOX_ENVIRONMENT_HASH",
    KEY_ENV,
];

/// Who composed the overlay a swap builds.
#[derive(Debug, PartialEq)]
pub(crate) enum By {
    /// The target image's own daemon: what it composes at boot.
    Target,
    /// The running daemon's overlay, rebased onto the target, because the target could not say: it predates the
    /// composer, or its composer failed (why).
    Running(Unanswered),
}

#[derive(Debug, PartialEq)]
pub(crate) enum Unanswered {
    Predates,
    Failed(String),
}

/// The overlay a swap builds: its content (empty for none) and who composed it.
#[derive(Debug, PartialEq)]
pub(crate) struct Overlay {
    pub(crate) content: String,
    pub(crate) by: By,
}

impl Overlay {
    /// What the new container is stamped with (SANDBOX_ENVIRONMENT_HASH); None for no overlay.
    pub(crate) fn hash(&self) -> Option<String> {
        (!self.content.is_empty()).then(|| sha256_hex(self.content.as_bytes()))
    }
}

/// The overlay to build on `base` for the sandbox `container` runs, as `composer` (the image `base` names, or the
/// exact image it resolved to) composes it; `approved` is the running daemon's overlay, already copied out
/// (recreate.rs `stage_overlay`), which is the fallback. `say` tells the person.
pub(crate) fn for_target(
    container: &str,
    slug: &str,
    composer: &str,
    base: &str,
    approved: &str,
    extra: &[String],
    log: &Log,
) -> Overlay {
    log.section(&format!("composing the environment in {composer}"));
    let answered = ask(container, slug, composer, base, extra, log);
    log.line(&format!("composition: {answered:?}"));
    settle(answered, approved, base)
}

/// Say who composed the overlay a swap is about to build, when that is not the plain case: the target composing what
/// the running daemon would have, or a sandbox with no overlay either way. Once per swap, for the overlay it builds.
pub(crate) fn say(overlay: &Overlay, composer: &str, approved: &str, base: &str) {
    match &overlay.by {
        By::Target if overlay.content != rebased(approved, base) => ui::note(&format!(
            "{composer} composes this sandbox's environment differently from the running version (its own feature packs and fragments), so its composition is built and nothing is left pending."
        )),
        By::Target => {}
        By::Running(_) if approved.is_empty() => {}
        By::Running(Unanswered::Predates) => ui::note(&format!(
            "{composer} predates composing environments for a swap, so the recipe the running version composed is built on it."
        )),
        By::Running(Unanswered::Failed(why)) => ui::warn(&format!(
            "{composer} could not compose this sandbox's environment ({why}), so the recipe the running version composed is built on it; the Environment card may ask for one more rebuild once it runs."
        )),
    }
}

/// The answer, or the running daemon's overlay rebased when there is none. Pure.
fn settle(answered: Result<Option<String>, Unanswered>, approved: &str, base: &str) -> Overlay {
    match answered {
        Ok(content) => Overlay {
            content: content.unwrap_or_default(),
            by: By::Target,
        },
        Err(unanswered) => Overlay {
            content: rebased(approved, base),
            by: By::Running(unanswered),
        },
    }
}

/// The running daemon's overlay moved onto `base`: its first FROM rewritten, nothing else; none stays none. Pure.
fn rebased(approved: &str, base: &str) -> String {
    if approved.is_empty() {
        String::new()
    } else {
        rewrite_from(approved, base)
    }
}

fn ask(
    container: &str,
    slug: &str,
    composer: &str,
    base: &str,
    extra: &[String],
    log: &Log,
) -> Result<Option<String>, Unanswered> {
    let mounts = target_probe::data_mounts(container).map_err(Unanswered::Failed)?;
    let env: Vec<String> = REPLAYED_ENV
        .iter()
        .filter_map(|name| {
            docker::container_env_value(container, name).map(|value| format!("{name}={value}"))
        })
        .collect();
    let mut extra = extra.to_vec();
    if let Some(key) = docker::mount_source(container, KEY_MOUNT) {
        extra.push(format!("{key}:{KEY_MOUNT}:ro"));
    }
    let args = ["--base".to_string(), base.to_string()];
    let probe = Probe {
        name: format!("{NAME_PREFIX}{slug}"),
        image: composer,
        script: SCRIPT,
        mounts: &mounts,
        extra: &extra,
        env: &env,
        args: &args,
    };
    let ran = target_probe::run(&probe, LIMIT, log).map_err(Unanswered::Failed)?;
    answer(&ran, base)
}

/// What a finished composer means. Pure, so every way it can end is asserted without a daemon. Anything short of a
/// clean answer in this format, naming exactly `base`, is no answer: building a guess would stamp a hash the target
/// may not agree with, which is the very drift this exists to end.
fn answer(ran: &docker::Bounded, base: &str) -> Result<Option<String>, Unanswered> {
    let failed = |why: String| Err(Unanswered::Failed(why));
    if ran.timed_out {
        return failed(format!("it did not answer within {}s", LIMIT.as_secs()));
    }
    match ran.code {
        Some(0) => {}
        _ if target_probe::predates(&ran.stderr, SCRIPT) => return Err(Unanswered::Predates),
        Some(code) if DOCKER_COULD_NOT_RUN.contains(&code) => {
            return failed(format!("docker could not run it (status {code})"))
        }
        Some(code) => {
            return failed(match error_line(&ran.stderr) {
                Some(line) => format!("its composer exited with status {code}: {line}"),
                None => format!("its composer exited with status {code}"),
            })
        }
        None => return failed("its composer was stopped before it answered".to_string()),
    }
    let Some(line) = last_line(&ran.stdout) else {
        return failed("its composer answered nothing".to_string());
    };
    let Ok(read) = serde_json::from_str::<Value>(line) else {
        return failed("its composer's answer is not JSON".to_string());
    };
    match read.get("compose").and_then(Value::as_u64) {
        Some(FORMAT) => {}
        Some(other) => {
            return failed(format!(
                "its composer answered format {other}, which only a newer ic reads"
            ))
        }
        None => return failed("its composer's answer names no format".to_string()),
    }
    let content = match read.get("overlay") {
        Some(Value::Null) => return Ok(None),
        Some(Value::String(content)) => content,
        _ => return failed("its composer's answer has no overlay".to_string()),
    };
    if read
        .get("hash")
        .and_then(Value::as_str)
        .is_some_and(|hash| hash != sha256_hex(content.as_bytes()))
    {
        return failed("its composer's overlay does not match its own hash".to_string());
    }
    match overlay_base(content) {
        Some(from) if from == base => Ok(Some(content.clone())),
        Some(from) => failed(format!("its composer extended {from}, not {base}")),
        None => failed("its composer's overlay has no FROM".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(code: i32, stdout: &str, stderr: &str) -> docker::Bounded {
        docker::Bounded {
            code: Some(code),
            timed_out: false,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    /// The contract's examples (ComposedOverlayLineSchema, written to golden/ by its test), each the line a composer
    /// prints, with the base it was asked for.
    const GOLDEN: &str =
        include_str!("../../../../_shared/sandbox-contract/golden/compose-overlay.json");

    fn golden() -> Vec<Value> {
        let read: Value = serde_json::from_str(GOLDEN).expect("golden parses");
        read["cases"].as_array().expect("cases").clone()
    }

    #[test]
    fn every_golden_line_reads_as_the_overlay_it_names() {
        let cases = golden();
        assert!(cases.len() >= 2);
        for case in cases {
            let line = case["line"].to_string();
            let base = case["base"].as_str().expect("base");
            let read = answer(&finished(0, &format!("{line}\n"), ""), base);
            let expected = case["line"]["overlay"].as_str().map(str::to_string);
            assert_eq!(read, Ok(expected), "{}", case["name"]);
        }
    }

    #[test]
    fn the_targets_composition_is_built_and_an_old_image_gets_the_running_overlay_on_its_base() {
        let approved = "# head\nFROM ghcr.io/intentic/sandbox:stable\nRUN old\n";
        let target = "FROM intentic-sandbox:dev\nRUN new\n";
        assert_eq!(
            settle(
                Ok(Some(target.to_string())),
                approved,
                "intentic-sandbox:dev"
            ),
            Overlay {
                content: target.to_string(),
                by: By::Target
            }
        );
        let fallback = settle(Err(Unanswered::Predates), approved, "intentic-sandbox:dev");
        assert_eq!(
            fallback.content,
            "# head\nFROM intentic-sandbox:dev\nRUN old\n"
        );
        assert_eq!(fallback.by, By::Running(Unanswered::Predates));
        // A target that wants none builds none, whatever the running daemon composed; none stays none on fallback.
        assert_eq!(settle(Ok(None), approved, "b").hash(), None);
        assert_eq!(
            settle(Err(Unanswered::Failed("x".into())), "", "b").content,
            ""
        );
    }

    #[test]
    fn the_stamped_hash_is_the_built_contents_own() {
        let overlay = Overlay {
            content: "FROM b\n".to_string(),
            by: By::Target,
        };
        assert_eq!(overlay.hash(), Some(sha256_hex(b"FROM b\n")));
    }

    #[test]
    fn a_composer_that_is_not_there_is_an_old_image_and_any_other_failure_is_said() {
        assert_eq!(
            answer(
                &finished(
                    1,
                    "",
                    "Error: Cannot find module '/opt/sandbox/dist/environment/compose-overlay.js'\n"
                ),
                "b"
            ),
            Err(Unanswered::Predates)
        );
        let crashed = answer(&finished(1, "", "TypeError: boom\n"), "b");
        assert!(
            matches!(&crashed, Err(Unanswered::Failed(why)) if why.contains("status 1") && why.contains("TypeError: boom")),
            "{crashed:?}"
        );
        let timed_out = docker::Bounded {
            code: None,
            timed_out: true,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert!(matches!(
            answer(&timed_out, "b"),
            Err(Unanswered::Failed(_))
        ));
    }

    #[test]
    fn an_answer_short_of_a_clean_overlay_on_the_asked_base_is_no_answer() {
        let line = |value: Value| finished(0, &format!("notice\n{value}\n"), "");
        let wrong_base = answer(
            &line(serde_json::json!({"compose": 1, "overlay": "FROM other\n"})),
            "b",
        );
        assert!(matches!(wrong_base, Err(Unanswered::Failed(why)) if why.contains("other")));
        let tampered = answer(
            &line(serde_json::json!({"compose": 1, "overlay": "FROM b\n", "hash": "00"})),
            "b",
        );
        assert!(matches!(tampered, Err(Unanswered::Failed(_))));
        let newer = answer(
            &line(serde_json::json!({"compose": 2, "overlay": "FROM b\n"})),
            "b",
        );
        assert!(matches!(newer, Err(Unanswered::Failed(why)) if why.contains("newer ic")));
        assert!(matches!(
            answer(&finished(0, "", ""), "b"),
            Err(Unanswered::Failed(_))
        ));
        assert!(matches!(
            answer(&finished(0, "not json\n", ""), "b"),
            Err(Unanswered::Failed(_))
        ));
        // The notice before the line does not cost the answer.
        assert_eq!(
            answer(
                &line(serde_json::json!({"compose": 1, "overlay": "FROM b\n"})),
                "b"
            ),
            Ok(Some("FROM b\n".to_string()))
        );
    }
}
