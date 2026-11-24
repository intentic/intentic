//! The desktop bar's i3bar stream. Reads fail closed to an absent block so an older `ic` is quiet.

use std::io::{BufRead, Write};
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::util::Result;

#[derive(Default)]
struct Snapshot {
    attention: Option<Value>,
    network: Option<Value>,
    sound: Option<Value>,
    system: Option<Value>,
    clock: String,
}

/// Only JSON values enter the formatter; it never reads the machine or writes a protocol delimiter.
fn blocks(snapshot: &Snapshot) -> Value {
    let mut blocks = Vec::new();
    let mut block = |name: &str, text: String, color: &str| {
        blocks.push(json!({"name": name, "full_text": text, "color": color,
            "separator": false, "separator_block_width": 20}));
    };
    let count = |key| {
        snapshot
            .attention
            .as_ref()
            .and_then(|a| a[key].as_u64())
            .unwrap_or(0)
    };
    if count("needsYou") > 0 {
        block(
            "attention",
            format!("{} need you", count("needsYou")),
            "#f2b86b",
        );
    }
    if count("working") > 0 {
        block(
            "working",
            format!("{} working", count("working")),
            "#a6a8b6",
        );
    }
    if let Some(network) = &snapshot.network {
        if let Some(connected) = network["connected"].as_bool() {
            let text = if !connected {
                "Offline"
            } else if network["kind"] == "ethernet" {
                "Wired"
            } else {
                network["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .unwrap_or("Wi-Fi")
            };
            block("network", text.to_string(), "#e6e6ef");
        }
    }
    if let Some(sound) = &snapshot.sound {
        if let (Some(volume), Some(muted)) = (sound["volume"].as_f64(), sound["muted"].as_bool()) {
            block(
                "sound",
                if muted {
                    "Muted".into()
                } else {
                    format!("Sound {}%", volume.clamp(0.0, 100.0).round() as u8)
                },
                "#e6e6ef",
            );
        }
    }
    if snapshot
        .system
        .as_ref()
        .is_some_and(|s| s.get("staged").is_some_and(Value::is_object))
    {
        block("update", "Update ready".into(), "#b6a0ff");
    }
    block("clock", snapshot.clock.clone(), "#e6e6ef");
    Value::Array(blocks)
}

fn click_link(snapshot: &Snapshot, name: &str) -> Option<String> {
    match name {
        "attention" => {
            let row = snapshot.attention.as_ref()?["sandboxes"]
                .as_array()?
                .iter()
                .find(|row| {
                    row["needsYou"].as_u64().unwrap_or(0) > 0 && row["platformId"].is_string()
                })?;
            let id = row["platformId"].as_str()?;
            // The shell link carries a platform id, never a URL or command supplied by a sandbox.
            if id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            {
                return None;
            }
            Some(format!("intentic://shell?open=sandbox&id={id}&at=agents"))
        }
        "network" | "sound" | "update" => Some("intentic://shell?open=device".into()),
        _ => None,
    }
}

enum Event {
    Read(&'static str, Option<Value>),
    Clock(String),
    Click(Value),
}

fn poll(tx: mpsc::Sender<Event>, name: &'static str, args: &'static [&'static str], seconds: u64) {
    std::thread::spawn(move || loop {
        let answer = std::env::current_exe().ok().and_then(|ic| {
            let mut command = Command::new(ic);
            command.args(args);
            let ran = intentic_bounded::capture(
                command,
                Duration::from_secs(20),
                intentic_bounded::Reach::Tree,
            )
            .ok()?;
            ran.success()
                .then(|| serde_json::from_str(&ran.stdout).ok())
                .flatten()
        });
        if tx.send(Event::Read(name, answer)).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_secs(seconds));
    });
}

pub fn run() -> Result<()> {
    let (tx, rx) = mpsc::channel();
    poll(
        tx.clone(),
        "attention",
        &["sandbox", "attention", "--json"],
        10,
    );
    poll(
        tx.clone(),
        "network",
        &["os", "network", "status", "--json"],
        5,
    );
    poll(tx.clone(), "sound", &["os", "sound", "status", "--json"], 5);
    poll(tx.clone(), "system", &["os", "status", "--json"], 180);
    let clock_tx = tx.clone();
    std::thread::spawn(move || loop {
        let mut command = Command::new("date");
        command.arg("+%a %H:%M");
        let clock = intentic_bounded::capture(
            command,
            Duration::from_secs(2),
            intentic_bounded::Reach::Child,
        )
        .ok()
        .filter(|ran| ran.success())
        .map(|ran| ran.stdout.trim().to_string())
        .unwrap_or_default();
        if clock_tx.send(Event::Clock(clock)).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_secs(15));
    });
    std::thread::spawn(move || {
        for line in std::io::stdin()
            .lock()
            .lines()
            .map_while(std::result::Result::ok)
        {
            if let Ok(click) = serde_json::from_str(line.trim().trim_start_matches(',')) {
                if tx.send(Event::Click(click)).is_err() {
                    break;
                }
            }
        }
    });
    let mut out = std::io::stdout().lock();
    writeln!(out, "{{\"version\":1,\"click_events\":true}}\n[\n[]")?;
    out.flush()?;
    let mut snapshot = Snapshot::default();
    for event in rx {
        match event {
            Event::Read("attention", value) => snapshot.attention = value,
            Event::Read("network", value) => snapshot.network = value,
            Event::Read("sound", value) => snapshot.sound = value,
            Event::Read("system", value) => snapshot.system = value,
            Event::Read(_, _) => {}
            Event::Clock(value) => snapshot.clock = value,
            Event::Click(click) => {
                if click["button"] == 1 {
                    if let Some(link) = click["name"]
                        .as_str()
                        .and_then(|name| click_link(&snapshot, name))
                    {
                        let mut command = Command::new("xdg-open");
                        command.arg(link);
                        // Reap the launcher without delaying the status stream.
                        std::thread::spawn(move || {
                            let _ = intentic_bounded::capture(
                                command,
                                Duration::from_secs(10),
                                intentic_bounded::Reach::Tree,
                            );
                        });
                    }
                }
                continue;
            }
        }
        writeln!(out, ",{}", blocks(&snapshot))?;
        out.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_answers_become_ordered_plain_blocks() {
        let snapshot = Snapshot {
            attention: Some(json!({"needsYou":2,"working":3})),
            network: Some(json!({"connected":true,"kind":"wifi","name":"<Home>","signal":80})),
            sound: Some(json!({"volume":42,"muted":false,"output":null})),
            system: Some(json!({"staged":{"version":"next"}})),
            clock: "Fri 12:34".into(),
        };
        assert_eq!(
            blocks(&snapshot),
            json!([
                {"name":"attention","full_text":"2 need you","color":"#f2b86b","separator":false,"separator_block_width":20},
                {"name":"working","full_text":"3 working","color":"#a6a8b6","separator":false,"separator_block_width":20},
                {"name":"network","full_text":"<Home>","color":"#e6e6ef","separator":false,"separator_block_width":20},
                {"name":"sound","full_text":"Sound 42%","color":"#e6e6ef","separator":false,"separator_block_width":20},
                {"name":"update","full_text":"Update ready","color":"#b6a0ff","separator":false,"separator_block_width":20},
                {"name":"clock","full_text":"Fri 12:34","color":"#e6e6ef","separator":false,"separator_block_width":20}
            ])
        );
    }

    #[test]
    fn zero_counts_and_missing_verbs_are_quiet() {
        let snapshot = Snapshot {
            attention: Some(json!({"needsYou":0,"working":0})),
            clock: "12:34".into(),
            ..Snapshot::default()
        };
        assert_eq!(
            blocks(&snapshot),
            json!([{ "name":"clock","full_text":"12:34","color":"#e6e6ef","separator":false,"separator_block_width":20 }])
        );
        let snapshot = Snapshot {
            network: Some(json!({"connected":false,"kind":"none","name":null})),
            sound: Some(json!({"volume":0,"muted":true})),
            system: Some(json!({"staged":null})),
            ..snapshot
        };
        let texts: Vec<_> = blocks(&snapshot)
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["full_text"].clone())
            .collect();
        assert_eq!(
            texts,
            vec![json!("Offline"), json!("Muted"), json!("12:34")]
        );
    }

    #[test]
    fn numeric_volume_is_rounded_and_malformed_answers_are_absent() {
        let snapshot = Snapshot {
            sound: Some(json!({"volume":41.6,"muted":false})),
            system: Some(json!({"staged":false})),
            clock: "12:34".into(),
            ..Snapshot::default()
        };
        assert_eq!(
            blocks(&snapshot),
            json!([
                {"name":"sound","full_text":"Sound 42%","color":"#e6e6ef","separator":false,"separator_block_width":20},
                {"name":"clock","full_text":"12:34","color":"#e6e6ef","separator":false,"separator_block_width":20}
            ])
        );
        let malformed = Snapshot {
            attention: Some(json!({"needsYou":"2","working":-1})),
            network: Some(json!({"connected":"yes"})),
            sound: Some(json!({"volume":null,"muted":true})),
            system: None,
            clock: "12:34".into(),
        };
        assert_eq!(
            blocks(&malformed),
            json!([{ "name":"clock","full_text":"12:34","color":"#e6e6ef","separator":false,"separator_block_width":20 }])
        );
    }

    #[test]
    fn clicks_only_navigate_to_a_known_surface() {
        let snapshot = Snapshot {
            attention: Some(
                json!({"sandboxes":[{"needsYou":0,"platformId":"a"},{"needsYou":1,"platformId":null},{"needsYou":2,"platformId":"b_2"}]}),
            ),
            ..Snapshot::default()
        };
        assert_eq!(
            click_link(&snapshot, "attention"),
            Some("intentic://shell?open=sandbox&id=b_2&at=agents".into())
        );
        assert_eq!(
            click_link(&snapshot, "update"),
            Some("intentic://shell?open=device".into())
        );
        assert_eq!(click_link(&snapshot, "clock"), None);
        assert_eq!(click_link(&snapshot, "working"), None);
    }
}
