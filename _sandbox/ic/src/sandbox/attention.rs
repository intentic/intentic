use std::time::Duration;

use serde_json::{json, Value};

use crate::docker;
use crate::sandbox::listing::{self, Seen};
use crate::sandbox::loopback;
use crate::sandbox::session::{self, HostSession};
use crate::util::{Fail, Result};

/* `ic sandbox attention --json` — how many conversations on this machine's sandboxes need the person, and how many are
working, read from each sandbox over its loopback port with no network (the status bar of the desktop app and of
Intentic OS draws it).

Each running sandbox is asked `GET /agents/attention`, which counts with the editor's own rules (the contract's
models/agent-standing.ts: the Attention lane's cards as the board folds them, plus held wakes; and the turns producing
something), so the bar and the board cannot disagree. It is asked with a session the machine minted
(session.rs), cached per sandbox and minted again when the daemon refuses it or it nears its end. Every sandbox is asked
at once, each with a short deadline: a sandbox that does not answer is `reachable: false` with zeros, never a wait. */

/// A loopback answer takes milliseconds; a daemon that has not answered by now is busy or gone.
const ASK_LIMIT: Duration = Duration::from_secs(3);
const CONNECT_LIMIT: Duration = Duration::from_secs(1);

/// The route, as the contract names it (agents.contract.ts `attention`).
const ROUTE: &str = "/agents/attention";

/// One sandbox's counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    needs_you: u64,
    working: u64,
}

/// What one sandbox answered, or why it did not.
#[derive(Debug, PartialEq)]
enum Asked {
    Counted(Counts),
    /// 401/403: the session is no longer good (re-keyed, a new owner). Worth one fresh mint.
    Refused,
    Silent,
}

/// The daemon's answer, read leniently: a count it did not give is zero rather than the whole answer lost. Pure.
fn counts_from(body: &Value) -> Option<Counts> {
    let count = |key: &str| body[key].as_u64();
    Some(Counts {
        needs_you: count("needsYou")?,
        working: count("working").unwrap_or(0),
    })
}

fn ask(port: u16, token: &str) -> Asked {
    // No proxy: a loopback address is this machine's own, whatever HTTP_PROXY says about the rest of the world.
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(ASK_LIMIT))
        .timeout_connect(Some(CONNECT_LIMIT))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent();
    let Ok(mut response) = agent
        .get(format!("http://127.0.0.1:{port}{ROUTE}"))
        .header("authorization", format!("Bearer {token}"))
        .call()
    else {
        return Asked::Silent;
    };
    match response.status().as_u16() {
        401 | 403 => Asked::Refused,
        200..=299 => response
            .body_mut()
            .read_json::<Value>()
            .ok()
            .as_ref()
            .and_then(counts_from)
            .map_or(Asked::Silent, Asked::Counted),
        _ => Asked::Silent,
    }
}

/// One sandbox, asked with its cached session, and once more with a fresh one if the daemon refused that.
fn counted(slug: &str, port: u16) -> Option<Counts> {
    let first: HostSession = session::cached_or_minted(slug).ok()?;
    match ask(port, &first.token) {
        Asked::Counted(counts) => Some(counts),
        Asked::Silent => None,
        Asked::Refused => {
            session::forget(slug);
            match ask(port, &session::mint(slug).ok()?.token) {
                Asked::Counted(counts) => Some(counts),
                Asked::Refused | Asked::Silent => None,
            }
        }
    }
}

/// One row of the answer: the sandbox, its names, and its counts or why it has none. Pure.
fn row(
    seen: &Seen,
    inspected: Option<&Value>,
    platform_id: Option<&str>,
    counts: Option<Counts>,
) -> Value {
    let sandbox_id = inspected.and_then(|inspected| loopback::addressing(inspected).0);
    let name = inspected
        .and_then(|inspected| loopback::env_of(inspected, "SANDBOX_NAME"))
        .unwrap_or(&seen.slug);
    let counts_or_zero = counts.unwrap_or_default();
    json!({
        "slug": seen.slug,
        "name": name,
        "sandboxId": sandbox_id,
        "platformId": platform_id,
        "needsYou": counts_or_zero.needs_you,
        "working": counts_or_zero.working,
        "reachable": counts.is_some(),
    })
}

/// The whole answer: every sandbox's row, and the machine's totals over the ones that answered. Pure.
fn answer(rows: Vec<Value>) -> Value {
    let total = |key: &str| rows.iter().filter_map(|row| row[key].as_u64()).sum::<u64>();
    json!({ "needsYou": total("needsYou"), "working": total("working"), "sandboxes": rows })
}

/// `ic sandbox attention --json`: one line of JSON on stdout, and nothing else there.
pub fn run_json() -> Result<()> {
    docker::require_daemon()?;
    let sandboxes = listing::seen_inspected()?;
    let rows: Vec<Value> = std::thread::scope(|scope| {
        let asks: Vec<_> = sandboxes
            .iter()
            .map(|(seen, inspected)| {
                scope.spawn(move || {
                    let port = inspected
                        .as_ref()
                        .and_then(|inspected| loopback::addressing(inspected).1);
                    // Asleep, stopped, parked or publishing no loopback port: nothing to ask, and nothing to mint for.
                    let counts = match port {
                        Some(port) if seen.running => counted(&seen.slug, port),
                        _ => None,
                    };
                    // The session minted for it knows the platform's id already; only a sandbox with none is read.
                    let platform_id = session::cached(&seen.slug)
                        .and_then(|minted| minted.platform_id)
                        .or_else(|| loopback::platform_id(&seen.container, inspected.as_ref()));
                    row(seen, inspected.as_ref(), platform_id.as_deref(), counts)
                })
            })
            .collect();
        asks.into_iter().filter_map(|ask| ask.join().ok()).collect()
    });
    // allow(terminal-output): the --json answer, one line the desktop app's status bar reads.
    println!(
        "{}",
        serde_json::to_string(&answer(rows)).map_err(|err| Fail(err.to_string()))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(slug: &str, running: bool) -> Seen {
        Seen {
            slug: slug.to_string(),
            container: format!("intentic-sandbox-{slug}"),
            running,
        }
    }

    #[test]
    fn a_count_is_read_off_the_daemons_answer_and_a_missing_one_is_no_answer() {
        assert_eq!(
            counts_from(&json!({ "needsYou": 2, "working": 1 })),
            Some(Counts {
                needs_you: 2,
                working: 1
            })
        );
        assert_eq!(
            counts_from(&json!({ "needsYou": 2 })),
            Some(Counts {
                needs_you: 2,
                working: 0
            })
        );
        assert_eq!(counts_from(&json!({ "error": "no" })), None);
        assert_eq!(counts_from(&json!({ "needsYou": -1 })), None);
    }

    #[test]
    fn the_answer_is_the_interface_the_status_bar_reads() {
        let inspected = json!({ "Config": { "Env": ["CONNECT_TOKEN=token", "SANDBOX_NAME=Lab"] } });
        let rows = vec![
            row(
                &seen("lab", true),
                Some(&inspected),
                Some("cm1"),
                Some(Counts {
                    needs_you: 2,
                    working: 1,
                }),
            ),
            // Asleep or unreachable: listed, with zeros, and named by its slug when it carries no name.
            row(&seen("nap", false), None, None, None),
            row(
                &seen("busy", true),
                Some(&json!({ "Config": { "Env": [] } })),
                None,
                Some(Counts {
                    needs_you: 1,
                    working: 3,
                }),
            ),
        ];
        assert_eq!(
            answer(rows),
            json!({
                "needsYou": 3,
                "working": 4,
                "sandboxes": [
                    { "slug": "lab", "name": "Lab", "sandboxId": "3c469e9d6c58", "platformId": "cm1", "needsYou": 2, "working": 1, "reachable": true },
                    { "slug": "nap", "name": "nap", "sandboxId": null, "platformId": null, "needsYou": 0, "working": 0, "reachable": false },
                    { "slug": "busy", "name": "busy", "sandboxId": null, "platformId": null, "needsYou": 1, "working": 3, "reachable": true },
                ],
            })
        );
    }

    #[test]
    fn a_machine_with_no_sandboxes_answers_zeros() {
        assert_eq!(
            answer(Vec::new()),
            json!({ "needsYou": 0, "working": 0, "sandboxes": [] })
        );
    }

    /// A port nothing listens on answers at once: refused, which is silence, not a wait for the deadline.
    #[test]
    fn a_port_nothing_listens_on_is_silent() {
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let started = std::time::Instant::now();
        assert_eq!(ask(port, "t"), Asked::Silent);
        assert!(started.elapsed() < ASK_LIMIT);
    }

    /// The daemon's own refusal is told apart from silence, so the session is minted again once.
    #[test]
    fn a_refused_session_and_an_answer_are_read_from_the_status() {
        use std::io::{Read, Write};
        let serve = |status: &'static str, body: &'static str| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 2048];
                let read = stream.read(&mut request).unwrap();
                let text = String::from_utf8_lossy(&request[..read]).to_lowercase();
                assert!(text.starts_with("get /agents/attention "), "{text}");
                assert!(text.contains("authorization: bearer t"), "{text}");
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
            port
        };
        assert_eq!(ask(serve("401 Unauthorized", "{}"), "t"), Asked::Refused);
        assert_eq!(
            ask(serve("200 OK", "{\"needsYou\":4,\"working\":2}"), "t"),
            Asked::Counted(Counts {
                needs_you: 4,
                working: 2
            })
        );
        assert_eq!(
            ask(serve("500 Internal Server Error", "{}"), "t"),
            Asked::Silent
        );
    }
}
