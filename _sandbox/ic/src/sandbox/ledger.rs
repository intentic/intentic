use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::sandbox::inside::{self, Read};

/* WHAT ic HAS DONE TO A SANDBOX, REMEMBERED WHERE EVERY SIDE CAN READ IT. The keeper's memory of a repair used to last
one ic run (audit 2026-10, class 5), and a restart made through ic does not raise Docker's own restart count, so a
sandbox that came up, died and was restarted every five minutes looked to every sweep like a sandbox restarted once.
`/history/.ic/repairs.json` keeps, per kind of repair, how many were made through ic, when the last one was, and the
moments of the automatic ones within the last two hours. After three automatic restarts in that window the keeper stops
restarting by itself and asks a person instead: a fourth restart of something three did not fix is a loop, and its
cause is an update to roll back or a log to read. A person's own restart is counted, and never held against them. */

pub const FILE: &str = "/history/.ic/repairs.json";

/// The window the automatic restarts are counted in, and how many of them it takes to stop.
pub const WINDOW_MS: u64 = 2 * 60 * 60_000;
pub const AUTO_RESTARTS_MAX: usize = 3;

/// The kinds a ledger counts.
pub const RESTART: &str = "restart";
pub const START: &str = "start";

/// One kind of repair: how many were made through ic, the last one's moment, and the automatic ones still inside the
/// window.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Entry {
    pub count: u64,
    pub last: u64,
    pub auto: Vec<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub entries: BTreeMap<String, Entry>,
}

/// The automatic restarts that stopped the keeper's own: how many, and the first of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exhausted {
    pub count: usize,
    pub since: u64,
}

impl Ledger {
    /// The file's JSON read; anything this build does not understand is left out rather than refused. Pure.
    pub fn parse(value: &Value) -> Ledger {
        let mut entries = BTreeMap::new();
        if let Some(object) = value.as_object() {
            for (kind, entry) in object {
                let auto = entry["auto"]
                    .as_array()
                    .map(|moments| moments.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default();
                entries.insert(
                    kind.clone(),
                    Entry {
                        count: entry["count"].as_u64().unwrap_or(0),
                        last: entry["last"].as_u64().unwrap_or(0),
                        auto,
                    },
                );
            }
        }
        Ledger { entries }
    }

    /// The file's JSON, and what `--json` reports. Pure.
    pub fn json(&self) -> Value {
        let mut object = Map::new();
        for (kind, entry) in &self.entries {
            object.insert(
                kind.clone(),
                json!({ "count": entry.count, "last": entry.last, "auto": entry.auto }),
            );
        }
        Value::Object(object)
    }

    /// The ledger with one more repair of `kind` at `at`; an automatic one is also remembered in the window, and the
    /// moments that left it are dropped. Pure.
    pub fn noted(&self, kind: &str, at: u64, auto: bool) -> Ledger {
        let mut next = self.clone();
        let entry = next.entries.entry(kind.to_string()).or_default();
        entry.count += 1;
        entry.last = entry.last.max(at);
        if auto {
            entry.auto.push(at);
        }
        entry
            .auto
            .retain(|moment| at.saturating_sub(*moment) < WINDOW_MS);
        next
    }

    /// Whether the keeper has restarted this sandbox by itself often enough, recently enough, to stop. Pure.
    pub fn restarts_exhausted(&self, now: u64) -> Option<Exhausted> {
        let entry = self.entries.get(RESTART)?;
        let recent: Vec<u64> = entry
            .auto
            .iter()
            .copied()
            .filter(|moment| now.saturating_sub(*moment) < WINDOW_MS)
            .collect();
        (recent.len() >= AUTO_RESTARTS_MAX).then(|| Exhausted {
            count: recent.len(),
            since: recent.iter().copied().min().unwrap_or(now),
        })
    }
}

/// The ledger on this container's volume; an absent or unreadable one is an empty ledger, which only ever errs
/// toward the keeper doing what it did before the ledger existed.
pub fn read(container: &str) -> Ledger {
    match inside::read(container, FILE) {
        Read::Found(value) => Ledger::parse(&value),
        Read::Missing | Read::Unreadable(_) => Ledger::default(),
    }
}

/// Count one repair of `kind` made to `slug` through ic, at the container's own moment. Best-effort: the repair is
/// what matters, and its count is only a guard on the next one. The caller holds the sandbox's lock, which orders the
/// read and the write on this side.
pub fn note(slug: &str, kind: &str, auto: bool) {
    let Some(holder) = inside::holder(slug) else {
        return;
    };
    let now = inside::now_for(&holder);
    let next = read(&holder).noted(kind, now, auto);
    let _ = inside::write_stamped(&holder, FILE, &next.json());
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;
    const NOW: u64 = 1_791_240_330_000;

    #[test]
    fn three_automatic_restarts_in_two_hours_stop_the_keeper_and_a_persons_never_count() {
        let mut ledger = Ledger::default();
        for minutes_ago in [100, 50, 10] {
            ledger = ledger.noted(RESTART, NOW - minutes_ago * MIN, true);
        }
        assert_eq!(
            ledger.restarts_exhausted(NOW),
            Some(Exhausted {
                count: 3,
                since: NOW - 100 * MIN
            })
        );
        // Two hours on from the first, it has left the window.
        assert_eq!(ledger.restarts_exhausted(NOW + 21 * MIN), None);
        // A person's restarts are counted, and stop nothing.
        let mut by_hand = Ledger::default();
        for minutes_ago in [30, 20, 10, 5] {
            by_hand = by_hand.noted(RESTART, NOW - minutes_ago * MIN, false);
        }
        assert_eq!(by_hand.restarts_exhausted(NOW), None);
        assert_eq!(by_hand.entries[RESTART].count, 4);
        assert_eq!(by_hand.entries[RESTART].last, NOW - 5 * MIN);
    }

    #[test]
    fn the_window_forgets_and_the_count_does_not() {
        let ledger = Ledger::default()
            .noted(RESTART, NOW - 300 * MIN, true)
            .noted(RESTART, NOW - 200 * MIN, true)
            .noted(RESTART, NOW, true)
            .noted(START, NOW, true);
        let restart = &ledger.entries[RESTART];
        assert_eq!(restart.count, 3);
        assert_eq!(
            restart.auto,
            vec![NOW],
            "the moments older than two hours are dropped"
        );
        assert_eq!(ledger.entries[START].count, 1);
        assert_eq!(ledger.restarts_exhausted(NOW), None);
    }

    #[test]
    fn the_file_round_trips_and_a_stranger_one_reads_as_what_it_can() {
        let ledger =
            Ledger::default()
                .noted(RESTART, NOW, true)
                .noted("rollback", NOW - MIN, false);
        assert_eq!(Ledger::parse(&ledger.json()), ledger);
        assert_eq!(
            ledger.json()[RESTART],
            json!({ "count": 1, "last": NOW, "auto": [NOW] })
        );
        let odd = json!({ "restart": { "count": "many", "auto": [1, "x", 2] }, "other": 5 });
        let parsed = Ledger::parse(&odd);
        assert_eq!(parsed.entries[RESTART].count, 0);
        assert_eq!(parsed.entries[RESTART].auto, vec![1, 2]);
        assert_eq!(Ledger::parse(&json!([1, 2])), Ledger::default());
    }
}
