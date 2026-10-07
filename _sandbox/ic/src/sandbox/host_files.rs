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
use super::{inside, probation, resume};

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
    assert_eq!(
        chain::live_turns(&signal.to_string(), number(&signal["at"])),
        Some(turns)
    );
}
