use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use super::policy::{self, Baseline, Policy, Profile};
use super::render;

/* WHAT ic SAYS IT HOLDS AND ENFORCES, in the contract's `EgressStatus`. Assembled from three things: the policy the
sandbox's record holds, the machine's baseline, and what ic last did about them, which it keeps per sandbox under
`~/.intentic/egress/<slug>.json` so a listing can say it without asking the engine. The refused destinations come from
the table's own counters whenever ic reads them. */

/// What ic last did for a sandbox's rules, as it keeps it between runs.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Applied {
    /// The revision, effective profile and neverAllow the rules were put in for: a later change makes them `pending`.
    pub revision: String,
    pub effective: String,
    pub never_allow: Vec<String>,
    pub state: String,
    pub reason: Option<String>,
    pub matched: Option<String>,
    pub advisory: Option<bool>,
    pub applied_at: Option<u64>,
    pub resolved: Vec<(String, Vec<String>)>,
    pub blocked: Vec<Value>,
    /// The shared networks the sandbox was fenced on by subnet (facts.rs `Fence::networks`): kept here, never shown.
    pub fenced_networks: Vec<String>,
}

impl Applied {
    pub fn to_json(&self) -> Value {
        json!({
            "revision": self.revision,
            "effectiveProfile": self.effective,
            "neverAllow": self.never_allow,
            "state": self.state,
            "reason": self.reason,
            "match": self.matched,
            "advisory": self.advisory,
            "appliedAt": self.applied_at,
            "resolved": self.resolved.iter().map(|(to, addresses)| json!({ "to": to, "addresses": addresses })).collect::<Vec<_>>(),
            "blocked": self.blocked,
            "fencedNetworks": self.fenced_networks,
        })
    }

    pub fn from_json(value: &Value) -> Option<Applied> {
        let text = |key: &str| value[key].as_str().map(str::to_string);
        Some(Applied {
            revision: text("revision")?,
            effective: text("effectiveProfile")?,
            never_allow: strings(&value["neverAllow"]),
            state: text("state")?,
            reason: text("reason"),
            matched: text("match"),
            advisory: value["advisory"].as_bool(),
            applied_at: value["appliedAt"].as_u64(),
            resolved: value["resolved"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    Some((
                        entry["to"].as_str()?.to_string(),
                        strings(&entry["addresses"]),
                    ))
                })
                .collect(),
            blocked: value["blocked"].as_array().cloned().unwrap_or_default(),
            fenced_networks: strings(&value["fencedNetworks"]),
        })
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub fn applied_path(slug: &str) -> PathBuf {
    crate::logfile::intentic_home()
        .join("egress")
        .join(format!("{slug}.json"))
}

pub fn read_applied(slug: &str) -> Option<Applied> {
    let text = std::fs::read_to_string(applied_path(slug)).ok()?;
    Applied::from_json(&serde_json::from_str(&text).ok()?)
}

pub fn write_applied(slug: &str, applied: &Applied) {
    let path = applied_path(slug);
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    if let Ok(mut tmp) = tempfile::NamedTempFile::new_in(dir) {
        use std::io::Write as _;
        if tmp
            .write_all(applied.to_json().to_string().as_bytes())
            .is_ok()
        {
            let _ = tmp.persist(&path);
        }
    }
}

/// Every sandbox ic remembers putting rules in for.
pub fn remembered() -> Vec<String> {
    let dir = crate::logfile::intentic_home().join("egress");
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()?
                .strip_suffix(".json")
                .map(str::to_string)
        })
        .filter(|slug| crate::sandbox::is_slug(slug))
        .collect()
}

pub fn forget_applied(slug: &str) {
    let _ = std::fs::remove_file(applied_path(slug));
}

/// The status, as the contract spells it. `held` is what the record holds (None: nothing, read as open); `applied`
/// what ic last did; `advisory` the container's own answer when ic has one fresh. Pure.
pub fn assemble(
    held: Option<&Policy>,
    baseline: &Baseline,
    applied: Option<&Applied>,
    advisory: Option<bool>,
) -> Value {
    let policy_held = held.cloned().unwrap_or_else(Policy::open);
    let revision = policy::revision(held);
    let effective = policy::effective_profile(&policy_held, baseline);
    let mut status = Map::new();
    status.insert(
        "policy".into(),
        policy::to_json(&policy::canonical(&policy_held)),
    );
    status.insert("revision".into(), json!(revision));
    status.insert("effectiveProfile".into(), json!(effective.word()));
    status.insert("neverAllow".into(), json!(baseline.never_allow));
    // What ic last did counts only while it was done for exactly this policy and this baseline.
    let current = applied.filter(|applied| {
        applied.revision == revision
            && applied.effective == effective.word()
            && applied.never_allow == baseline.never_allow
    });
    let blocked = applied
        .map(|applied| applied.blocked.clone())
        .unwrap_or_default();
    if effective == Profile::Open {
        status.insert("state".into(), json!("off"));
    } else {
        match current {
            Some(applied) => {
                status.insert("state".into(), json!(applied.state));
                if let Some(reason) = &applied.reason {
                    status.insert("reason".into(), json!(reason));
                }
                if let Some(matched) = &applied.matched {
                    status.insert("match".into(), json!(matched));
                }
                if let Some(at) = applied.applied_at {
                    status.insert("appliedAt".into(), json!(at));
                }
                if !applied.resolved.is_empty() {
                    status.insert(
                        "resolved".into(),
                        Value::Array(
                            applied
                                .resolved
                                .iter()
                                .map(|(to, addresses)| json!({ "to": to, "addresses": addresses }))
                                .collect(),
                        ),
                    );
                }
                if let Some(advisory) = advisory.or(applied.advisory) {
                    status.insert("advisory".into(), json!(advisory));
                }
            }
            None => {
                status.insert("state".into(), json!("pending"));
                status.insert(
                    "reason".into(),
                    json!("the rules for this policy are not in yet: they go in when the sandbox next starts, or at ic's next round"),
                );
                if let Some(advisory) = advisory {
                    status.insert("advisory".into(), json!(advisory));
                }
            }
        }
    }
    status.insert(
        "blocked".into(),
        Value::Array(blocked.into_iter().take(100).collect()),
    );
    Value::Object(status)
}

/* ---- The refused destinations, from the table's own counters ---- */

/// Which sandboxes' chains the table holds, by id. Pure over `nft -j list table`.
pub fn ids_in(table: &Value) -> BTreeSet<String> {
    table["nftables"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["chain"]["name"].as_str())
        .filter_map(|name| name.strip_prefix("sbx_"))
        .filter_map(|rest| rest.split_once('_').map(|(id, _)| id.to_string()))
        .collect()
}

fn protocol_word(value: &Value) -> &'static str {
    match value {
        Value::String(word) if word == "tcp" => "tcp",
        Value::String(word) if word == "udp" => "udp",
        Value::Number(number) if number.as_u64() == Some(6) => "tcp",
        Value::Number(number) if number.as_u64() == Some(17) => "udp",
        _ => "other",
    }
}

/// How long a refused destination is remembered, in seconds (render.rs `MEMORY`).
const MEMORY_SECS: u64 = 3600;

/// One sandbox's refused destinations, newest first: each set element's address, protocol and port with its packet
/// count. An element's timer restarts with each packet (`update`), so the time it has left says when it was last
/// refused. Pure.
pub fn blocked(table: &Value, slug: &str, now_ms: u64) -> Vec<Value> {
    let id = render::id(slug);
    let mut rows: Vec<(Option<u64>, u64, Value)> = Vec::new();
    for set in table["nftables"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| &item["set"])
    {
        let Some(name) = set["name"].as_str() else {
            continue;
        };
        let Some(suffix) = name.strip_prefix(&format!("sbx_{id}_")) else {
            continue;
        };
        if !render::SETS.iter().any(|(known, _)| *known == suffix) {
            continue;
        }
        for element in set["elem"].as_array().into_iter().flatten() {
            let element = &element["elem"];
            let Some(parts) = element["val"]["concat"].as_array() else {
                continue;
            };
            let Some(to) = parts.first().and_then(Value::as_str) else {
                continue;
            };
            let protocol = parts.get(1).map(protocol_word).unwrap_or("other");
            let packets = element["counter"]["packets"].as_u64().unwrap_or(0);
            let mut row = Map::new();
            row.insert("to".into(), json!(to));
            if protocol != "other" {
                if let Some(port) = parts.get(2).and_then(Value::as_u64) {
                    row.insert("port".into(), json!(port));
                }
            }
            row.insert("protocol".into(), json!(protocol));
            row.insert("packets".into(), json!(packets));
            let seen = element["expires"]
                .as_u64()
                .map(|left| now_ms.saturating_sub(MEMORY_SECS.saturating_sub(left) * 1000));
            if let Some(seen) = seen {
                row.insert("lastSeenAt".into(), json!(seen));
            }
            rows.push((seen, packets, Value::Object(row)));
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    rows.into_iter().take(100).map(|(_, _, row)| row).collect()
}

#[cfg(test)]
mod tests {
    use super::super::policy::Allow;
    use super::*;

    fn fenced() -> Policy {
        Policy {
            profile: Profile::InternetOnly,
            allow: vec![Allow {
                to: "host".into(),
                ports: None,
                protocol: None,
                note: None,
                from: None,
            }],
        }
    }

    #[test]
    fn nothing_held_is_open_and_off_with_no_revision() {
        let status = assemble(None, &Baseline::default(), None, None);
        assert_eq!(
            status,
            json!({ "policy": { "allow": [], "profile": "open" }, "revision": "none", "effectiveProfile": "open", "neverAllow": [], "state": "off", "blocked": [] })
        );
    }

    #[test]
    fn a_policy_held_but_not_applied_is_pending_and_one_applied_says_what_ic_did() {
        let held = fenced();
        let pending = assemble(Some(&held), &Baseline::default(), None, Some(true));
        assert_eq!(pending["state"], "pending");
        assert_eq!(pending["advisory"], true);
        assert_eq!(pending["revision"], policy::revision(Some(&held)));
        let applied = Applied {
            revision: policy::revision(Some(&held)),
            effective: "internet-only".into(),
            never_allow: vec![],
            state: "enforced".into(),
            matched: Some("network".into()),
            applied_at: Some(5),
            resolved: vec![("nas.lan".into(), vec!["192.168.1.20".into()])],
            blocked: vec![json!({ "to": "10.0.0.1", "protocol": "tcp", "port": 22, "packets": 3 })],
            ..Applied::default()
        };
        let status = assemble(Some(&held), &Baseline::default(), Some(&applied), None);
        assert_eq!(status["state"], "enforced");
        assert_eq!(status["match"], "network");
        assert_eq!(status["appliedAt"], 5);
        assert_eq!(
            status["resolved"],
            json!([{ "to": "nas.lan", "addresses": ["192.168.1.20"] }])
        );
        assert_eq!(status["blocked"][0]["port"], 22);
        // The same rules under a baseline that has changed since are not what is enforced now.
        let stricter = Baseline {
            never_allow: vec!["10.0.0.0/8".into()],
            ..Baseline::default()
        };
        assert_eq!(
            assemble(Some(&held), &stricter, Some(&applied), None)["state"],
            "pending"
        );
        // The record of what was applied round-trips.
        assert_eq!(Applied::from_json(&applied.to_json()), Some(applied));
    }

    #[test]
    fn the_baseline_minimum_fences_a_sandbox_that_holds_nothing() {
        let baseline = Baseline {
            minimum: Profile::InternetOnly,
            never_allow: vec![],
        };
        let status = assemble(None, &baseline, None, None);
        assert_eq!(status["effectiveProfile"], "internet-only");
        assert_eq!(status["revision"], "none");
        assert_eq!(status["state"], "pending");
    }

    #[test]
    fn the_counters_read_back_as_refused_destinations_newest_first() {
        let id = render::id("work");
        let table = json!({ "nftables": [
            { "metainfo": { "version": "1.1.3" } },
            { "table": { "family": "inet", "name": "intentic_egress" } },
            { "set": { "family": "inet", "name": format!("sbx_{id}_b4p"), "table": "intentic_egress", "elem": [
                { "elem": { "val": { "concat": ["10.1.2.3", "tcp", 445] }, "expires": 3598, "counter": { "packets": 6, "bytes": 360 } } },
                { "elem": { "val": { "concat": ["192.168.1.1", "udp", 53] }, "expires": 3000, "counter": { "packets": 2, "bytes": 120 } } },
            ] } },
            { "set": { "family": "inet", "name": format!("sbx_{id}_b6o"), "table": "intentic_egress", "elem": [
                { "elem": { "val": { "concat": ["fe80::1", "ipv6-icmp"] }, "counter": { "packets": 1, "bytes": 64 } } },
            ] } },
            { "set": { "family": "inet", "name": "sbx_000000000000_b4p", "table": "intentic_egress", "elem": [
                { "elem": { "val": { "concat": ["10.9.9.9", "tcp", 80] }, "expires": 3599, "counter": { "packets": 1, "bytes": 60 } } },
            ] } },
            { "chain": { "family": "inet", "table": "intentic_egress", "name": format!("sbx_{id}_forward") } },
            { "chain": { "family": "inet", "table": "intentic_egress", "name": "sbx_000000000000_refuse" } },
        ] });
        let rows = blocked(&table, "work", 10_000_000);
        assert_eq!(
            rows,
            vec![
                json!({ "to": "10.1.2.3", "port": 445, "protocol": "tcp", "packets": 6, "lastSeenAt": 10_000_000 - 2_000 }),
                json!({ "to": "192.168.1.1", "port": 53, "protocol": "udp", "packets": 2, "lastSeenAt": 10_000_000 - 600_000 }),
                json!({ "to": "fe80::1", "protocol": "other", "packets": 1 }),
            ]
        );
        assert_eq!(
            ids_in(&table),
            [id, "000000000000".to_string()].into_iter().collect()
        );
    }
}
