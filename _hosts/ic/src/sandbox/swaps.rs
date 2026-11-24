use serde_json::{json, Map, Value};

use crate::record::{self, ChannelRecord, Phase};
use crate::sandbox::now_ms;
use crate::sandbox::probation::cutover_in_progress;
use crate::util::Result;

/* WHICH SWAPS ARE IN FLIGHT, answered without Docker.

`ic` is the one reader of its own swap records: whether a cutover is in progress is `probation::cutover_in_progress`
(its heartbeat, `swap_alive`, is fresh), and every other process on this computer (the machine agent deferring its own
restart and upgrade, the keeper skipping a sandbox, the sync pause) asks this command rather than parsing the record and
judging it again. They used to, and they believed a record's start time for half an hour after an ic killed mid-swap,
which ic itself calls interrupted after 90 seconds.

It reads the records under the state home and nothing else, so it answers while Docker is down, which is exactly when
the machine agent needs it (a sandbox mid-swap is a parked container, and Docker being down is no reason to restart the
agent under it). The answer is `DeviceSwapSchema` in the contract; golden/swap-verdicts.json is each record's row. */

/// One sandbox's swap, as a row of the answer: None when its record names no swap in flight or on probation. The
/// verdict (`cutoverInProgress`) is ic's rule at `now`, never the caller's. Pure.
pub fn row(slug: &str, record: &ChannelRecord, now: u64) -> Option<Value> {
    let swap = record.swap.as_ref()?;
    let mut row = Map::new();
    row.insert("slug".into(), json!(slug));
    row.insert("phase".into(), json!(swap.phase.as_str()));
    row.insert("at".into(), json!(swap.at));
    if let Some(alive) = swap.alive {
        row.insert("alive".into(), json!(alive));
    }
    if let Some(until) = swap.until.filter(|_| swap.phase == Phase::Probation) {
        row.insert("probationUntil".into(), json!(until));
    }
    row.insert(
        "cutoverInProgress".into(),
        json!(cutover_in_progress(swap, now)),
    );
    Some(Value::Object(row))
}

/// The slugs this home holds a channel record for, sorted. A record the other side of a computer copied here is
/// listed too: its swap is as real as any, and the caller holds its own restarts for it.
fn record_slugs() -> Vec<String> {
    let mut slugs: Vec<String> = std::fs::read_dir(crate::logfile::intentic_home())
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    name.strip_prefix("sandbox-")
                        .and_then(|rest| rest.strip_suffix(".channel"))
                        .filter(|slug| !slug.is_empty())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    slugs.sort();
    slugs
}

/// `ic sandbox swaps [--json]` — every swap in flight or on probation on this device, and whether each cutover is
/// being done right now. Read-only and docker-free. `--json` is one line, an array with a row per swap.
pub fn run(as_json: bool) -> Result<()> {
    let now = now_ms();
    let mut rows: Vec<Value> = Vec::new();
    for slug in record_slugs() {
        // A record that is there and cannot be read says nothing either way; the verbs that write it refuse it by name.
        match record::read(&slug) {
            Ok(record) => rows.extend(row(&slug, &record, now)),
            Err(error) => crate::ui::warn(&format!("{slug}: {}", error.0)),
        }
    }
    if as_json {
        // allow(terminal-output): the --json answer, one line the machine agent reads.
        println!("{}", Value::Array(rows));
        return Ok(());
    }
    if rows.is_empty() {
        crate::ui::quiet("no swap is in flight or on probation on this device.");
    }
    for row in &rows {
        let slug = row["slug"].as_str().unwrap_or_default();
        let sentence = match (row["phase"].as_str(), row["cutoverInProgress"].as_bool()) {
            (Some("cutover"), Some(true)) => "a swap is being done right now".to_string(),
            (Some("cutover"), _) => {
                "a swap was interrupted; the next `ic sandbox watch` settles it".to_string()
            }
            _ => "on probation".to_string(),
        };
        crate::ui::quiet(&format!("{slug}: {sentence}."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The contract's records and the rows they must give (golden/swap-verdicts.json). The machine agent's fallback for an
    /// ic without this command is tested against the same file.
    const VERDICTS: &str =
        include_str!("../../../../_shared/sandbox-contract/golden/swap-verdicts.json");

    #[test]
    fn every_record_in_the_contracts_verdicts_gives_the_row_it_names() {
        let golden: Value = serde_json::from_str(VERDICTS).expect("JSON");
        let slug = golden["slug"].as_str().expect("slug");
        let cases = golden["cases"].as_array().expect("cases");
        assert!(cases.len() >= 10, "the file holds the cases it should");
        for case in cases {
            let record = record::parse(case["record"].as_str().expect("record"));
            let now = case["now"].as_u64().expect("now");
            let expected = if case["swap"].is_null() {
                None
            } else {
                Some(case["swap"].clone())
            };
            assert_eq!(row(slug, &record, now), expected, "{}", case["name"]);
        }
    }

    #[test]
    fn the_contracts_constants_are_the_ones_the_heartbeat_and_the_rule_use() {
        let golden: Value = serde_json::from_str(VERDICTS).expect("JSON");
        assert_eq!(
            golden["heartbeatSecs"].as_u64(),
            Some(crate::sandbox::probation::HEARTBEAT_SECS)
        );
        assert_eq!(
            golden["staleMs"].as_u64(),
            Some(crate::sandbox::probation::STALE_MS)
        );
    }
}
