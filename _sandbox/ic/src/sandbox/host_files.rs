//! The files ic and the daemon share across the container's edge, held to the daemon's own definitions. Each is
//! defined on the daemon's side and only spelled again here, so a renamed file or field would otherwise go unseen until a
//! sandbox stopped hearing what ic said or ic stopped reading what the sandbox said. The daemon's golden/host-files.json
//! gives each file's path and, where the daemon defines its shape, an example (its system/host-files.test.ts writes it
//! from the daemon's documents); the contract's golden/update-outcome.json and golden/update-preparing.json are the
//! examples of the two update markers.

use std::path::Path;

use serde_json::Value;

use super::fix::chain;
use super::outcome::{self, Kind, Outcome};
use super::preparing::{self, Phase};
use super::{inside, intent, probation, resume};

const HOST_FILES: &str = include_str!("../../../sandbox/golden/host-files.json");
const UPDATE_OUTCOME: &str =
    include_str!("../../../../_shared/sandbox-contract/golden/update-outcome.json");
const UPDATE_PREPARING: &str =
    include_str!("../../../../_shared/sandbox-contract/golden/update-preparing.json");

fn json(text: &str) -> Value {
    serde_json::from_str(text).expect("JSON")
}

fn number(value: &Value) -> u64 {
    value.as_u64().expect("a number")
}

#[test]
fn every_path_ic_reads_or_writes_is_the_one_the_daemon_uses() {
    let files = json(HOST_FILES);
    assert_eq!(files["restartResume"]["path"], resume::FILE);
    assert_eq!(files["updateOutcome"]["path"], outcome::FILE);
    assert_eq!(files["updatePreparing"]["path"], preparing::MARKER);
    assert_eq!(files["bootFailure"]["path"], probation::BOOT_FAILURE_FILE);
    assert_eq!(files["daemonExit"]["path"], probation::DAEMON_EXIT_FILE);
    assert_eq!(files["workSignal"]["path"], chain::WORK_SIGNAL);
}

/// The restart intent (intent.rs), held to the contract's RestartIntentSchema through the daemon's golden file: the path, an
/// example ic's body reproduces field for field, and the words (who acts, what it does, which side it runs on) every writer
/// of the file shares. The device keeper's writer is held to the same entry by its own test.
#[test]
fn the_restart_intent_ic_writes_is_the_contracts_example() {
    let files = json(HOST_FILES);
    let entry = &files["restartIntent"];
    assert_eq!(entry["path"], intent::FILE);
    let example = &entry["example"];
    let text = |field: &str| example[field].as_str().expect("a string field");
    let checks: Vec<String> = example["checks"]
        .as_array()
        .expect("the example names checks")
        .iter()
        .map(|check| check.as_str().expect("a check").to_string())
        .collect();
    let action = intent::Action::ALL
        .into_iter()
        .find(|action| action.wire() == text("action"))
        .expect("an action ic writes");
    let body = intent::body(
        action,
        text("reason"),
        &checks,
        text("by"),
        text("host"),
        text("side"),
    );
    let at = crate::sandbox::fix::clock::rfc3339_ms(text("at")).expect("an ISO moment");
    assert_eq!(&json(&inside::stamp(&body.to_string(), at)), example);
}

#[test]
fn every_word_ic_puts_in_a_restart_intent_is_one_the_contract_enumerates() {
    let files = json(HOST_FILES);
    let entry = &files["restartIntent"];
    let words = |field: &str| -> Vec<String> {
        entry[field]
            .as_array()
            .unwrap_or_else(|| panic!("the golden enumerates {field}"))
            .iter()
            .map(|word| word.as_str().expect("a word").to_string())
            .collect()
    };
    let (initiators, actions, sides) = (words("initiators"), words("actions"), words("sides"));
    for who in [intent::BY_IC, intent::BY_KEEPER] {
        assert!(initiators.iter().any(|word| word == who), "{who}");
    }
    for action in intent::Action::ALL {
        assert!(
            actions.iter().any(|word| word == action.wire()),
            "{}",
            action.wire()
        );
    }
    // Every side the platform and environment names ic can run on, as the file says it.
    for (platform, env) in [
        ("windows", None),
        ("linux", Some("macos")),
        ("linux", Some("linux")),
        ("linux", Some("archlinux")),
        ("linux", None),
        ("macos", None),
    ] {
        let side = intent::side_word(platform, env);
        assert!(
            sides.iter().any(|word| word == side),
            "{platform} {env:?} -> {side}"
        );
    }
}

#[test]
fn what_ic_writes_is_the_daemons_example_field_for_field() {
    let files = json(HOST_FILES);
    let asked = &files["restartResume"]["example"];
    let written = inside::stamp(&resume::body(true).to_string(), number(&asked["askedAt"]));
    assert_eq!(&json(&written), asked);

    let expected = json(UPDATE_OUTCOME);
    let text = |field: &str| expected[field].as_str();
    let log = text("log").map(Path::new);
    let outcome = Outcome {
        result: Kind::RolledBack,
        verb: text("verb").expect("a verb"),
        from: text("from"),
        to: text("to"),
        reason: text("reason"),
        log,
        keep_until: expected["keepUntil"].as_u64(),
    };
    assert_eq!(
        json(&outcome::json_of(&outcome, number(&expected["at"]))),
        expected
    );

    let expected = json(UPDATE_PREPARING);
    assert_eq!(expected["phase"], "download");
    let percent = u32::try_from(number(&expected["percent"])).expect("a percent");
    let marker = preparing::marker(
        expected["channel"].as_str().expect("a channel"),
        u128::from(number(&expected["startedAt"])),
        u128::from(number(&expected["at"])),
        Phase::Download,
        Some(percent),
    );
    assert_eq!(json(&marker), expected);
}

#[test]
fn what_ic_reads_it_finds_in_the_daemons_example() {
    let files = json(HOST_FILES);

    let failure = &files["bootFailure"]["example"];
    let at = number(&failure["at"]);
    let first_line = failure["error"]
        .as_str()
        .and_then(|error| error.lines().next())
        .expect("an error");
    assert_eq!(
        probation::boot_failure_of(failure, at).as_deref(),
        Some(first_line)
    );
    assert_eq!(probation::boot_failure_of(failure, at + 1), None);

    let marker = &files["daemonExit"]["example"];
    assert_eq!(
        probation::daemon_started_of(marker),
        Some(number(&marker["startedAt"]))
    );

    let signal = &files["workSignal"]["example"];
    let turns = u32::try_from(number(&signal["liveTurns"])).expect("a count");
    let read = chain::WorkSignal::parse(&signal.to_string()).expect("the signal");
    assert_eq!(read.turns(number(&signal["at"])), Some(turns));
    // What the keeper's sleep decides on (sleep.rs), read from the same example.
    assert_eq!(
        read,
        chain::WorkSignal {
            at: number(&signal["at"]),
            live_turns: turns,
            quiet_since: Some(number(&signal["quietSince"])),
            next_wake_at: Some(number(&signal["nextWakeAt"])),
            person_at: None,
            keep_awake: false,
        }
    );
}
