use std::time::Duration;

use serde_json::Value;

use crate::docker;
use crate::logfile::Log;
use crate::util::{plural, Fail, Result};

/* BEFORE A SWAP TOUCHES THE CONTAINER, THE TARGET IMAGE SAYS WHAT ITS STATE CONVERSIONS WOULD DO TO THIS SANDBOX'S DATA. */

/// The image's own planner: the daemon's conversion engine, run against the data without writing to it. An image
/// built before the engine has no such file.
const SCRIPT: &str = "/opt/sandbox/dist/state-plan.js";

/// The one plan format this binary reads. Any other is "no plan" rather than a guess at what its fields mean.
const FORMAT: u64 = 1;

/// A plan reads a few JSON documents, so two minutes is a hang rather than a big workspace. The bound is the
/// point: every other capture in docker.rs waits for as long as its child runs, and a planner that never exits
/// would hold the update with it.
const LIMIT: Duration = Duration::from_secs(120);

/// Where a sandbox's stored data lives in its container, the planner's flag for each, and whether a container
/// always has it: the run contract's `DATA_MOUNTS` (_shared/sandbox-run), which this binary cannot import, so a
/// test holds this copy to the contract's golden/data-mounts.json. `/agent-auth` rides only where the container has
/// it (a dev sandbox sharing AI logins); without it the planner looked for those vaults in the workspace.
const DATA_MOUNTS: [(&str, &str, bool); 3] = [
    ("/work", "--workspace", true),
    ("/history", "--history", true),
    ("/agent-auth", "--auth", false),
];

/// The probe container's name, `<prefix><slug>`. Named at all so a probe that outlives its deadline can be
/// removed (killing the CLI leaves the container running), and never under CONTAINER_PREFIX: every listing of
/// the sandboxes on this machine is keyed on that prefix, and a probe must not read as a sandbox called
/// `preflight-<slug>`.
const NAME_PREFIX: &str = "intentic-preflight-";

/// One document the plan names, and what it says about it: a step's change, a failure's detail.
#[derive(Debug, PartialEq)]
struct Entry {
    document: String,
    text: String,
}

impl Entry {
    fn line(&self) -> String {
        let document = if self.document.is_empty() {
            "(unnamed document)"
        } else {
            &self.document
        };
        if self.text.is_empty() {
            document.to_string()
        } else {
            format!("{document}: {}", self.text)
        }
    }
}

/// What the target image answered.
#[derive(Debug, PartialEq)]
enum Plan {
    /// Every conversion goes through. `steps` is what its first boot changes, and `downgrade` says a newer
    /// version already converted this data: the image opens those files read-only, which is not a failure.
    Clear { steps: Vec<Entry>, downgrade: bool },
    /// The conversions that would throw on this sandbox's data.
    Refused(Vec<Entry>),
    /// No plan to be had, and why: an image from before the engine, a planner that failed or hung, or an answer
    /// this binary cannot read.
    Unknown(String),
}

/// Ask `image` what its state conversions would do to the data `container` runs on, and act on the answer:
/// carry on (saying what the first boot changes), or refuse before anything is touched. `extra` is the -v
/// specs the new container gets beyond its data (the dev loop's compiled trees, which replace the image's own
/// copy of the engine); `verb` names the re-run.
///
/// Only an explicit `ok:false` stops the flow. Every other way this can go wrong is one warning and then the
/// swap exactly as it ran before the pre-flight existed: a question an image cannot answer must not cost an
/// update that would have worked.
pub fn check(
    container: &str,
    slug: &str,
    image: &str,
    extra: &[String],
    verb: &str,
    log: &Log,
) -> Result<()> {
    println!("intentic: pre-flighting the state conversions of {image} on this sandbox's data (read-only)…");
    let (plan, _) = probe(container, slug, image, extra, log);
    log.line(&format!("state pre-flight: {plan:?}"));
    report(plan, image, verb)
}

/// The plan for the staged marker (`/history/update-staged.json`), which the update card shows before the owner
/// accepts: what the staged build's first boot converts, or which conversions would refuse the update. None when no
/// plan could be had, which leaves the card as it always was. Same probe, same bounds, as `check`.
pub fn staged_plan(
    container: &str,
    slug: &str,
    image: &str,
    extra: &[String],
    log: &Log,
) -> Option<String> {
    let (plan, line) = probe(container, slug, image, extra, log);
    log.line(&format!("state pre-flight for the staged build: {plan:?}"));
    marker_json(&plan, line)
}

/// The plan for the marker: the planner's own line, verbatim (the contract's StatePlanSchema, which the daemon reads
/// the marker with), so nothing it says is lost on the way, a step's `detail` included. None when there is no plan.
fn marker_json(plan: &Plan, line: Option<String>) -> Option<String> {
    match plan {
        Plan::Unknown(_) => None,
        Plan::Clear { .. } | Plan::Refused(_) => line,
    }
}

/// Run the planner once, against read-only mounts of the running container's data (DATA_MOUNTS). Answers the plan,
/// and the planner's line itself when it gave one.
fn probe(
    container: &str,
    slug: &str,
    image: &str,
    extra: &[String],
    log: &Log,
) -> (Plan, Option<String>) {
    let mut mounts: Vec<Mount> = Vec::new();
    for (destination, flag, required) in DATA_MOUNTS {
        match docker::mount_source(container, destination) {
            Some(source) => mounts.push(Mount {
                source,
                destination,
                flag,
            }),
            None if required => {
                return (
                    Plan::Unknown(format!(
                        "{container} has no mount at {destination} to show the planner"
                    )),
                    None,
                )
            }
            None => {}
        }
    }
    let name = format!("{NAME_PREFIX}{slug}");
    let args = probe_argv(&name, image, &mounts, extra);
    log.section("state pre-flight");
    log.line(&format!("docker {}", args.join(" ")));
    // A probe that an interrupted run left behind still holds the name, and would fail this one for a reason
    // that has nothing to do with the image.
    docker::quiet(&["rm", "-f", &name]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let ran = match docker::capture_bounded(&arg_refs, LIMIT) {
        Ok(ran) => ran,
        Err(Fail(reason)) => return (Plan::Unknown(reason), None),
    };
    log.line(&ran.stdout);
    log.line(&ran.stderr);
    if ran.timed_out {
        docker::quiet(&["rm", "-f", &name]);
    }
    let plan = verdict(&ran, image);
    (plan, last_line(&ran.stdout).map(str::to_string))
}

/// One data volume as the planner sees it: the running container's source, where it is mounted, and the planner's
/// flag naming that place.
struct Mount {
    source: String,
    destination: &'static str,
    flag: &'static str,
}

/// The planner's `docker run`. Split out so it is asserted without a daemon, because each flag is a promise
/// about the owner's data: `:ro` on every data mount is what makes asking harmless, `--network none` keeps a
/// planner from reaching anything but those files, and `--rm` leaves nothing behind.
fn probe_argv(name: &str, image: &str, mounts: &[Mount], extra: &[String]) -> Vec<String> {
    let mut args: Vec<String> = [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        // The image's own entrypoint is the daemon, which would boot and convert for real.
        "--entrypoint",
        "node",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    for mount in mounts {
        args.push("-v".to_string());
        args.push(format!("{}:{}:ro", mount.source, mount.destination));
    }
    for mount in extra {
        args.push("-v".to_string());
        args.push(mount.clone());
    }
    args.push(image.to_string());
    args.push(SCRIPT.to_string());
    for mount in mounts {
        args.push(mount.flag.to_string());
        args.push(mount.destination.to_string());
    }
    args
}

/// What a finished probe means. Pure, so every way it can end is asserted without a daemon.
fn verdict(ran: &docker::Bounded, image: &str) -> Plan {
    if ran.timed_out {
        return Plan::Unknown(format!(
            "the planner did not answer within {}s",
            LIMIT.as_secs()
        ));
    }
    match ran.code {
        Some(0) => read_plan(&ran.stdout),
        _ if predates_engine(&ran.stderr) => {
            Plan::Unknown(format!("{image} predates the state-conversion engine"))
        }
        Some(code) => Plan::Unknown(match error_line(&ran.stderr) {
            Some(line) => format!("the planner exited with status {code}: {line}"),
            None => format!("the planner exited with status {code}"),
        }),
        None => Plan::Unknown("the planner was stopped before it answered".to_string()),
    }
}

/// node's words for an entry script that is not there: every image built before the engine.
fn predates_engine(stderr: &str) -> bool {
    stderr.contains("Cannot find module") && stderr.contains(SCRIPT)
}

/// The line of the planner's stderr worth quoting in one warning: the last one naming an error (node's
/// `TypeError: …` comes after the source excerpt that threw it, docker's refusal after its own chatter). The
/// log holds the rest.
fn error_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|line| line.contains("Error"))
        .map(|line| clip(line, 200))
}

/// The planner's one JSON line → a plan. Pure, and tolerant where tolerance is safe: anything unreadable is
/// Unknown (the swap proceeds as it always did), and only a document that says `"ok": false` in so many words
/// becomes a refusal.
/// The last line: a runtime that prints a notice to stdout before the plan must not cost the answer.
fn last_line(stdout: &str) -> Option<&str> {
    stdout.lines().map(str::trim).rfind(|line| !line.is_empty())
}

fn read_plan(stdout: &str) -> Plan {
    let Some(line) = last_line(stdout) else {
        return Plan::Unknown("the planner answered nothing".to_string());
    };
    let Ok(plan) = serde_json::from_str::<Value>(line) else {
        return Plan::Unknown(format!(
            "the planner's answer is not a plan: {}",
            clip(line, 120)
        ));
    };
    match plan.get("plan").and_then(Value::as_u64) {
        Some(FORMAT) => {}
        Some(other) => {
            return Plan::Unknown(format!(
                "the planner answered plan format {other}, which only a newer ic reads"
            ));
        }
        None => return Plan::Unknown("the planner's answer names no plan format".to_string()),
    }
    match plan.get("ok").and_then(Value::as_bool) {
        Some(false) => Plan::Refused(entries(&plan, "failures", "detail")),
        Some(true) => Plan::Clear {
            steps: entries(&plan, "steps", "change"),
            downgrade: plan.get("downgrade").and_then(Value::as_bool) == Some(true),
        },
        None => {
            Plan::Unknown("the planner's plan does not say whether it would succeed".to_string())
        }
    }
}

/// The plan's list under `key`, every entry with whatever of `document` and `text_key` it carries. An entry
/// with neither says nothing a person could act on and is dropped; one with either is kept, because a refusal
/// that lost a failure to a missing field would stop an update for a reason it cannot show.
fn entries(plan: &Value, key: &str, text_key: &str) -> Vec<Entry> {
    let field = |item: &Value, name: &str| {
        item.get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    plan.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| Entry {
            document: field(item, "document"),
            text: field(item, text_key),
        })
        .filter(|entry| !entry.document.is_empty() || !entry.text.is_empty())
        .collect()
}

/// What the flow prints for a plan, and the one outcome that stops it.
fn report(plan: Plan, image: &str, verb: &str) -> Result<()> {
    match plan {
        Plan::Refused(failures) => Err(Fail(refusal(&failures, image, verb))),
        Plan::Clear { steps, downgrade } => {
            if !steps.is_empty() {
                println!("intentic: {}", summary(&steps));
                for step in &steps {
                    // A settled line under the summary. `ui::detail` alone would show nothing here: it
                    // decorates a running step's live line, and a recreate never starts one.
                    crate::ui::note(&format!("  {}", step.line()));
                }
            }
            if downgrade {
                crate::ui::warn(&format!("a newer version already converted some of this sandbox's state files, so {image} opens them read-only until the sandbox is updated again."));
            }
            Ok(())
        }
        Plan::Unknown(reason) => {
            crate::ui::warn(&format!("could not pre-flight state conversions: {reason}"));
            Ok(())
        }
    }
}

/// "this swap converts 2 state files when the sandbox starts:" — documents, not steps: two changes to one file
/// are one file a person has to think about.
fn summary(steps: &[Entry]) -> String {
    let mut documents: Vec<&str> = steps.iter().map(|step| step.document.as_str()).collect();
    documents.sort_unstable();
    documents.dedup();
    format!(
        "this swap converts {} when the sandbox starts:",
        plural(documents.len(), "state file")
    )
}

/// The refusal: what failed, that nothing changed, and the one way past it. The image is named rather than
/// called "the new version", because a rollback's target is the older one.
fn refusal(failures: &[Entry], image: &str, verb: &str) -> String {
    let mut message = format!(
        "{image} cannot convert this sandbox's state, so the swap was stopped before it began — the sandbox is untouched."
    );
    if failures.is_empty() {
        message.push_str("\n       (the planner reported a failure without naming a document)");
    }
    for failure in failures {
        message.push_str(&format!("\n       {}", failure.line()));
    }
    message.push_str(&format!(
        "\n       To swap anyway, re-run `ic sandbox {verb}` with --skip-preflight: the image then meets the same failures as it boots."
    ));
    message
}

/// At most `limit` characters of `text`, marked when cut. Characters, not bytes: a cut through a multi-byte
/// character would panic.
fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}…")
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

    fn entry(document: &str, text: &str) -> Entry {
        Entry {
            document: document.to_string(),
            text: text.to_string(),
        }
    }

    /// The contract's examples (the daemon's StatePlanSchema, spelled once in its test and written to golden/), which
    /// this reader must keep reading.
    const GOLDEN_CLEAR: &str =
        include_str!("../../../../_shared/sandbox-contract/golden/state-plan-clear.json");
    const GOLDEN_REFUSED: &str =
        include_str!("../../../../_shared/sandbox-contract/golden/state-plan-refused.json");
    const GOLDEN_MOUNTS: &str =
        include_str!("../../../../_shared/sandbox-run/golden/data-mounts.json");

    /// The planner prints its plan as one line; the golden files are pretty-printed.
    fn one_line(golden: &str) -> String {
        serde_json::from_str::<Value>(golden)
            .expect("a golden file is JSON")
            .to_string()
    }

    #[test]
    fn the_contracts_plans_read_as_what_they_say() {
        assert_eq!(
            read_plan(&one_line(GOLDEN_CLEAR)),
            Plan::Clear {
                steps: vec![
                    entry(
                        "conversations-db-schema",
                        "upgrades the conversations database schema"
                    ),
                    entry(
                        ".intentic/config/personas.json",
                        "moves it from .intentic/identities.json"
                    ),
                ],
                downgrade: false,
            }
        );
        assert_eq!(
            read_plan(&one_line(GOLDEN_REFUSED)),
            Plan::Refused(vec![entry(
                ".intentic/config/automations.json",
                "conversion \"converts numbered kinds\" failed: no such kind"
            )])
        );
    }

    #[test]
    fn the_staged_marker_gets_the_planners_line_verbatim() {
        let line = one_line(GOLDEN_CLEAR);
        let plan = read_plan(&line);
        // Every field the planner said, a conversion's `detail` included, which the marker once dropped.
        assert_eq!(marker_json(&plan, Some(line.clone())), Some(line));
        let refused = one_line(GOLDEN_REFUSED);
        assert_eq!(
            marker_json(&read_plan(&refused), Some(refused.clone())),
            Some(refused)
        );
        // No plan to be had leaves the marker as it always was.
        assert_eq!(
            marker_json(
                &Plan::Unknown("predates the engine".to_string()),
                Some("garbage".to_string())
            ),
            None
        );
    }

    #[test]
    fn the_probe_mounts_what_the_run_contract_says_data_lives_on() {
        let golden: Vec<Value> = serde_json::from_str(GOLDEN_MOUNTS).expect("JSON");
        let contract: Vec<(String, String, bool)> = golden
            .iter()
            .map(|mount| {
                (
                    mount["destination"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    mount["planner"].as_str().unwrap_or_default().to_string(),
                    mount["required"].as_bool().unwrap_or_default(),
                )
            })
            .collect();
        let ours: Vec<(String, String, bool)> = DATA_MOUNTS
            .iter()
            .map(|(destination, flag, required)| {
                (destination.to_string(), flag.to_string(), *required)
            })
            .collect();
        assert_eq!(ours, contract);
    }

    fn mounts(work: &str, history: &str, auth: Option<&str>) -> Vec<Mount> {
        let mut list = vec![
            Mount {
                source: work.to_string(),
                destination: "/work",
                flag: "--workspace",
            },
            Mount {
                source: history.to_string(),
                destination: "/history",
                flag: "--history",
            },
        ];
        if let Some(auth) = auth {
            list.push(Mount {
                source: auth.to_string(),
                destination: "/agent-auth",
                flag: "--auth",
            });
        }
        list
    }

    #[test]
    fn the_planner_runs_on_read_only_mounts_with_no_network_and_leaves_nothing_behind() {
        let argv = probe_argv(
            "intentic-preflight-abc123",
            "ghcr.io/intentic/sandbox:stable",
            &mounts("intentic-workspace-abc123", "intentic-history-abc123", None),
            &[],
        );
        assert_eq!(
            argv,
            [
                "run",
                "--rm",
                "--name",
                "intentic-preflight-abc123",
                "--network",
                "none",
                "--entrypoint",
                "node",
                "-v",
                "intentic-workspace-abc123:/work:ro",
                "-v",
                "intentic-history-abc123:/history:ro",
                "ghcr.io/intentic/sandbox:stable",
                "/opt/sandbox/dist/state-plan.js",
                "--workspace",
                "/work",
                "--history",
                "/history",
            ]
        );
    }

    #[test]
    fn a_dev_sandboxs_shared_logins_ride_read_only_and_the_planner_is_told_where() {
        let argv = probe_argv(
            "n",
            "intentic-sandbox:dev",
            &mounts("w", "h", Some("intentic-dev-agent-auth")),
            &[],
        );
        assert!(argv.contains(&"intentic-dev-agent-auth:/agent-auth:ro".to_string()));
        let auth = argv.iter().position(|arg| arg == "--auth").expect("--auth");
        assert_eq!(argv[auth + 1], "/agent-auth");
        let image = argv
            .iter()
            .position(|arg| arg == "intentic-sandbox:dev")
            .unwrap();
        assert!(auth > image);
    }

    #[test]
    fn a_bind_source_and_the_dev_loops_trees_ride_before_the_image() {
        let extra = vec!["/src/_sandbox/sandbox/dist:/opt/sandbox/dist".to_string()];
        let argv = probe_argv(
            "n",
            "intentic-sandbox:dev",
            &mounts("/srv/work", "/srv/history", None),
            &extra,
        );
        assert!(argv.contains(&"/srv/work:/work:ro".to_string()));
        assert!(argv.contains(&"/srv/history:/history:ro".to_string()));
        let mount = argv.iter().position(|arg| arg == &extra[0]).expect(
            "the dev tree is mounted, or the planner runs the image's stale copy of the engine",
        );
        assert_eq!(argv[mount - 1], "-v");
        // Docker stops reading options at the image name: a -v after it would be an argument to node.
        let image = argv
            .iter()
            .position(|arg| arg == "intentic-sandbox:dev")
            .unwrap();
        assert!(mount < image);
        assert_eq!(argv[image + 1], SCRIPT);
    }

    #[test]
    fn a_probe_container_is_never_listed_as_a_sandbox() {
        assert!(!NAME_PREFIX.starts_with(crate::sandbox::CONTAINER_PREFIX));
    }

    #[test]
    fn a_clean_plan_lists_its_steps_and_counts_files_not_changes() {
        let plan = read_plan(
            r#"{"plan":1,"engine":7,"ok":true,"downgrade":false,"failures":[],"steps":[{"document":".intentic/config/settings.json","change":"renames agentRunModel to agentRunModels"},{"document":".intentic/config/settings.json","change":"drops the retired theme key"},{"document":"fleet/registry.json","change":"adds the engine stamp"}]}"#,
        );
        let Plan::Clear { steps, downgrade } = plan else {
            panic!("a plan that says ok is clear, got {plan:?}")
        };
        assert!(!downgrade);
        assert_eq!(steps.len(), 3);
        assert_eq!(
            steps[0],
            entry(
                ".intentic/config/settings.json",
                "renames agentRunModel to agentRunModels"
            )
        );
        assert_eq!(
            summary(&steps),
            "this swap converts 2 state files when the sandbox starts:"
        );
        assert_eq!(
            read_plan(r#"{"plan":1,"ok":true,"steps":[]}"#),
            Plan::Clear {
                steps: vec![],
                downgrade: false
            }
        );
    }

    #[test]
    fn only_an_explicit_ok_false_refuses_and_every_failure_is_named_with_the_way_past_it() {
        let plan = read_plan(
            r#"{"plan":1,"engine":7,"ok":false,"downgrade":false,"failures":[{"document":".intentic/config/settings.json","detail":"agentRunModel is not a string"},{"document":"fleet/registry.json","detail":"duplicate id 4"}],"steps":[]}"#,
        );
        let Plan::Refused(failures) = &plan else {
            panic!("ok:false is a refusal, got {plan:?}")
        };
        assert_eq!(
            failures,
            &vec![
                entry(
                    ".intentic/config/settings.json",
                    "agentRunModel is not a string"
                ),
                entry("fleet/registry.json", "duplicate id 4"),
            ]
        );
        let Err(Fail(message)) = report(plan, "ghcr.io/intentic/sandbox:stable", "update") else {
            panic!("a refusal must stop the flow")
        };
        assert!(
            message.starts_with("ghcr.io/intentic/sandbox:stable cannot convert"),
            "{message}"
        );
        assert!(message.contains("the sandbox is untouched"), "{message}");
        assert!(
            message
                .contains("\n       .intentic/config/settings.json: agentRunModel is not a string"),
            "{message}"
        );
        assert!(
            message.contains("\n       fleet/registry.json: duplicate id 4"),
            "{message}"
        );
        assert!(
            message.contains("re-run `ic sandbox update` with --skip-preflight"),
            "{message}"
        );
    }

    #[test]
    fn a_refusal_that_names_no_document_still_refuses_and_says_so() {
        // Contradicting the contract (ok:false, nothing listed) is still an explicit "no" from the image.
        let plan = read_plan(r#"{"plan":1,"ok":false}"#);
        assert_eq!(plan, Plan::Refused(vec![]));
        let Err(Fail(message)) = report(plan, "img", "rollback") else {
            panic!("a refusal must stop the flow")
        };
        assert!(message.contains("without naming a document"), "{message}");
        assert!(message.contains("`ic sandbox rollback`"), "{message}");
    }

    #[test]
    fn a_downgrade_is_a_warning_and_never_a_refusal() {
        let plan = read_plan(
            r#"{"plan":1,"engine":6,"ok":true,"downgrade":true,"failures":[],"steps":[]}"#,
        );
        assert_eq!(
            plan,
            Plan::Clear {
                steps: vec![],
                downgrade: true
            }
        );
        assert!(report(plan, "img", "rollback").is_ok());
    }

    #[test]
    fn garbage_is_no_plan_and_the_swap_goes_ahead() {
        for garbage in [
            "",
            "   \n",
            "Segmentation fault",
            "{not json",
            "[1,2]",
            "\"ok\"",
            "42",
        ] {
            let plan = read_plan(garbage);
            assert!(
                matches!(plan, Plan::Unknown(_)),
                "{garbage:?} read as {plan:?}"
            );
            assert!(
                report(plan, "img", "update").is_ok(),
                "{garbage:?} must not stop the swap"
            );
        }
        // A notice printed ahead of the plan does not cost the answer; the plan is the last line.
        assert_eq!(
            read_plan("(node:12) ExperimentalWarning: something\n{\"plan\":1,\"ok\":true}\n"),
            Plan::Clear {
                steps: vec![],
                downgrade: false
            }
        );
    }

    #[test]
    fn a_plan_missing_what_it_must_say_is_no_plan_and_missing_extras_default() {
        // No format, a format from the future, no verdict: none of these may be read as a refusal.
        for unreadable in [
            r#"{"ok":false,"failures":[{"document":"a","detail":"b"}]}"#,
            r#"{"plan":2,"ok":false,"failures":[{"document":"a","detail":"b"}]}"#,
            r#"{"plan":"1","ok":false}"#,
            r#"{"plan":1,"failures":[{"document":"a","detail":"b"}]}"#,
            r#"{"plan":1,"ok":"false"}"#,
        ] {
            assert!(
                matches!(read_plan(unreadable), Plan::Unknown(_)),
                "{unreadable} must not be read as a verdict"
            );
        }
        let Plan::Unknown(reason) = read_plan(r#"{"plan":2,"ok":true}"#) else {
            panic!("a newer format is no plan")
        };
        assert!(reason.contains("plan format 2"), "{reason}");
        // `steps` and `downgrade` absent read as none and false; malformed entries keep what they carry.
        assert_eq!(
            read_plan(
                r#"{"plan":1,"ok":true,"steps":[{"document":"a.json"},{"change":"renames x"},{},"stray",{"document":7,"change":null}]}"#
            ),
            Plan::Clear {
                steps: vec![entry("a.json", ""), entry("", "renames x")],
                downgrade: false
            }
        );
        assert_eq!(entry("a.json", "").line(), "a.json");
        assert_eq!(
            entry("", "renames x").line(),
            "(unnamed document): renames x"
        );
    }

    #[test]
    fn how_the_planner_ended_decides_before_what_it_printed() {
        let clean = r#"{"plan":1,"ok":true,"steps":[]}"#;
        assert_eq!(
            verdict(&finished(0, clean, ""), "img"),
            Plan::Clear {
                steps: vec![],
                downgrade: false
            }
        );
        // A plan printed by a planner that then failed is not a plan the image stands behind.
        assert!(matches!(
            verdict(&finished(1, clean, ""), "img"),
            Plan::Unknown(_)
        ));
        let hung = docker::Bounded {
            code: None,
            timed_out: true,
            stdout: r#"{"plan":1,"ok":false}"#.to_string(),
            stderr: String::new(),
        };
        assert_eq!(
            verdict(&hung, "img"),
            Plan::Unknown("the planner did not answer within 120s".to_string())
        );
    }

    #[test]
    fn an_image_from_before_the_engine_is_named_as_such() {
        // Verbatim node, for an entry script the image does not carry.
        let stderr = concat!(
            "node:internal/modules/cjs/loader:1228\n",
            "  throw err;\n",
            "  ^\n",
            "\n",
            "Error: Cannot find module '/opt/sandbox/dist/state-plan.js'\n",
            "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n",
            "    at node:internal/main/run_main_module:28:49 {\n",
            "  code: 'MODULE_NOT_FOUND',\n",
            "  requireStack: []\n",
            "}\n",
            "\n",
            "Node.js v20.11.1",
        );
        assert_eq!(
            verdict(&finished(1, "", stderr), "ghcr.io/intentic/sandbox:1.4.0"),
            Plan::Unknown(
                "ghcr.io/intentic/sandbox:1.4.0 predates the state-conversion engine".to_string()
            )
        );
    }

    #[test]
    fn a_crashed_planner_is_quoted_by_its_error_line_not_its_trailer() {
        // The source excerpt that threw also spells "Error"; the message node prints after it is the one to quote.
        let stderr = concat!(
            "file:///opt/sandbox/dist/state-plan.js:40\n",
            "        throw new Error(`cannot read ${path}`);\n",
            "        ^\n",
            "\n",
            "Error: cannot read /work/.intentic/config/settings.json\n",
            "    at plan (file:///opt/sandbox/dist/state-plan.js:40:15)\n",
            "\n",
            "Node.js v20.11.1",
        );
        assert_eq!(
            verdict(&finished(1, "", stderr), "img"),
            Plan::Unknown(
                "the planner exited with status 1: Error: cannot read /work/.intentic/config/settings.json"
                    .to_string()
            )
        );
        // Docker refusing the run itself (an image without node) is quoted the same way.
        assert_eq!(
            verdict(
                &finished(
                    127,
                    "",
                    concat!(
                        "docker: Error response from daemon: exec: \"node\": executable file not found in $PATH\n",
                        "\n",
                        "Run 'docker run --help' for more information",
                    )
                ),
                "img"
            ),
            Plan::Unknown("the planner exited with status 127: docker: Error response from daemon: exec: \"node\": executable file not found in $PATH".to_string())
        );
        assert_eq!(
            verdict(&finished(2, "", ""), "img"),
            Plan::Unknown("the planner exited with status 2".to_string())
        );
    }

    #[test]
    fn a_long_line_is_clipped_on_a_character_boundary() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("ééééé", 3), "ééé…");
    }
}
