use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::model::Stage;
use crate::util::{bail, Result};

/* REPORTING TO THE PAGE THAT ASKED — the recovery panel, where the owner is looking while this runs in a terminal or
in the machine agent. The platform keeps only the latest report per sandbox (`POST /host-report`, bearer the sandbox's
report key); a run with no key reports nothing and works the same. */

/// `HOST_REPORT_KEY_LABEL` in @intentic/api-contract: the message the report key is the HMAC of.
pub const KEY_LABEL: &str = "intentic/host-report/v1";

/// The sandbox's report key: HMAC-SHA256 over [`KEY_LABEL`], keyed with its connect token, in lowercase hex. The
/// platform derives the same from the token it holds, and the key grants nothing but the one write. Pure.
pub fn report_key(connect_token: &str) -> String {
    hex(&hmac_sha256(connect_token.as_bytes(), KEY_LABEL.as_bytes()))
}

/// RFC 2104 over sha2, which this binary already carries: twenty lines against a crate every shim re-downloads.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| -> Vec<u8> { block.iter().map(|b| b ^ byte).collect() };
    let mut inner = Sha256::new();
    inner.update(pad(0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(pad(0x5c));
    outer.update(inner.finalize());
    let mut mac = [0u8; 32];
    mac.copy_from_slice(&outer.finalize());
    mac
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The 12-hex tunnel id a `sandbox-<id>` slug carries: what the platform's hostname and `sandbox` field name. None
/// for a slug that carries none (a dev sandbox named by hand), which cannot be reported.
pub fn tunnel_id(slug: &str) -> Option<String> {
    let id = slug.strip_prefix("sandbox-").unwrap_or(slug);
    (id.len() == 12
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)))
    .then(|| id.to_string())
}

/// A container's `PLATFORM_URL` is spelled from inside it; on a dev machine that is host.docker.internal, which
/// resolves nowhere out here.
pub fn from_host(platform_url: &str) -> String {
    platform_url
        .trim_end_matches('/')
        .replace("//host.docker.internal", "//localhost")
}

/// Derive the key from a container's env and keep it in the sandbox's channel record: what every verb that reads
/// the env calls, so a later run (the machine agent's, while Docker is down) can report with no code at all.
pub fn remember(slug: &str, connect_token: Option<&str>, platform_url: Option<&str>) {
    let Some(token) = connect_token.filter(|token| !token.is_empty()) else {
        return;
    };
    let platform = platform_url.filter(|url| !url.is_empty()).map(from_host);
    crate::record::remember_report(slug, &report_key(token), platform.as_deref());
}

/// The same for a reader that may be looking at another side's sandbox (`created_by`, off its env): a record that
/// already exists here is kept current, but none is made for a sandbox another side keeps, whose own home holds its
/// record. `ic sandbox list --json` and an attended `fix` made one for every container on the engine before
/// (2026-10-05), so every side ended up holding records of every other side's sandboxes.
pub fn remember_unless_elsewhere(
    slug: &str,
    connect_token: Option<&str>,
    platform_url: Option<&str>,
    created_by: Option<&crate::sandbox::side::Side>,
) {
    let theirs =
        crate::sandbox::side::elsewhere(created_by, &crate::sandbox::side::here()).is_some();
    if theirs && !crate::record::record_path(slug).exists() {
        return;
    }
    remember(slug, connect_token, platform_url);
}

/// The same, off the NUL-framed env `docker::container_env_nul` reads.
pub fn remember_from_env(slug: &str, env: &[u8]) {
    let text = String::from_utf8_lossy(env);
    let value = |name: &str| {
        text.split('\0')
            .find_map(|pair| pair.strip_prefix(&format!("{name}=")).map(str::to_string))
    };
    remember(
        slug,
        value("CONNECT_TOKEN").as_deref(),
        value("PLATFORM_URL").as_deref(),
    );
}

/// What a claimed fix code bought: the sandbox it was minted for, and that sandbox's report key.
pub struct Claimed {
    pub sandbox: String,
    pub key: String,
}

/// `POST {platform}/host-report/claim` with the code the recovery panel handed out. `Ok(None)` for a code the
/// platform does not know (expired or already gone): the run goes on without reporting.
pub fn claim(platform_url: &str, code: &str) -> Result<Option<Claimed>> {
    let agent = agent(platform_url, Duration::from_secs(15));
    let url = format!("{platform_url}/host-report/claim");
    match agent
        .post(&url)
        .send_json(serde_json::json!({ "code": code }))
    {
        Ok(mut response) => {
            let body: serde_json::Value = response.body_mut().read_json().map_err(|err| {
                crate::util::Fail(format!(
                    "the platform's answer to the fix code could not be read: {err}"
                ))
            })?;
            let sandbox = body["sandbox"].as_str().unwrap_or_default().to_string();
            let key = body["key"].as_str().unwrap_or_default().to_string();
            if tunnel_id(&sandbox).is_none() || key.is_empty() {
                bail!("the platform answered the fix code with something ic cannot use ({body}).");
            }
            Ok(Some(Claimed { sandbox, key }))
        }
        Err(ureq::Error::StatusCode(404 | 410)) => Ok(None),
        Err(ureq::Error::StatusCode(status)) => {
            bail!("the platform answered HTTP {status} to the fix code.")
        }
        Err(err) => {
            bail!("could not reach the platform at {platform_url} with the fix code: {err}")
        }
    }
}

fn agent(platform_url: &str, limit: Duration) -> ureq::Agent {
    crate::platform::agent_within(platform_url, limit)
}

/// The platform ic talks to when nothing names another.
pub const DEFAULT_PLATFORM: &str = "https://api.intentic.dev";

/// Where one sandbox's reports go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub platform: String,
    pub key: String,
    /// The 12-hex tunnel id.
    pub sandbox: String,
}

/// Where a sandbox's reports go, for a verb outside the fix engine (sleep.rs), read the way the engine reads it: the
/// platform PLATFORM_URL forces, else the one its container names, else the one kept for it, else the default; the key
/// its connect token yields, else the one kept for it. None for a slug that carries no tunnel id, or a sandbox with no
/// key at all. Pure.
pub fn target_of(
    slug: &str,
    token: Option<&str>,
    container_platform: Option<&str>,
    record: &crate::record::ChannelRecord,
    forced: Option<&str>,
) -> Option<Target> {
    let sandbox = tunnel_id(slug)?;
    let key = token
        .filter(|token| !token.is_empty())
        .map(report_key)
        .or_else(|| record.report_key.clone())?;
    let platform = forced
        .filter(|url| !url.is_empty())
        .map(|url| url.trim_end_matches('/').to_string())
        .or_else(|| {
            container_platform
                .filter(|url| !url.is_empty())
                .map(from_host)
        })
        .or_else(|| record.report_platform.clone())
        .unwrap_or_else(|| DEFAULT_PLATFORM.to_string());
    Some(Target {
        platform,
        key,
        sandbox,
    })
}

/// PLATFORM_URL, when it is set: it wins over what a container or a record says.
pub fn forced_platform() -> Option<String> {
    std::env::var("PLATFORM_URL")
        .ok()
        .filter(|url| !url.is_empty())
}

/// One report, sent now and waited for (bounded): for a verb that reports once and is done, where the poster's
/// coalescing has nothing to coalesce. A failure is ignored, as every post's is.
pub fn post_now(target: &Target, body: serde_json::Value) {
    post(&Pending {
        target: target.clone(),
        stage: Stage::Done,
        body,
    });
}

/* THE WAKES THE PLATFORM HOLDS. Somebody opening a sandbox that sleeps on this computer (`ic sandbox sleep`) leaves a
wake request on the platform, which has no way to reach this machine; the machine agent asks for them instead (`ic
sandbox wakes`, every few seconds while anything here sleeps): `POST /host-report/wakes` with each sleeping sandbox's
report key, which proves the asker is the host that runs it, answered with the ones somebody asked to wake. The platform
clears each request as it answers it, so an answer is acted on once. Anything but a 200 with a body that reads is
"nothing to wake": a wake missed now is asked for again at the next poll, and a sandbox started that nobody asked for is
not. */

/// How many sandboxes one ask may carry (the platform's cap).
pub const WAKES_MAX: usize = 64;
/// How long one ask may take: the poll comes round again in seconds.
const WAKES_LIMIT: Duration = Duration::from_secs(10);

/// The ask's body. Pure.
pub fn wakes_body(asks: &[Target]) -> serde_json::Value {
    let asks: Vec<serde_json::Value> = asks
        .iter()
        .map(|ask| serde_json::json!({ "sandbox": ask.sandbox, "key": ask.key }))
        .collect();
    serde_json::json!({ "asks": asks })
}

/// The tunnel ids an answer names, among the ones asked about, each once: an answer is never a licence to start a
/// sandbox nobody asked about. Pure.
pub fn woken_of(answer: &serde_json::Value, asked: &[Target]) -> Vec<String> {
    let mut woken: Vec<String> = Vec::new();
    for id in answer["wake"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
    {
        if asked.iter().any(|ask| ask.sandbox == id) && !woken.iter().any(|seen| seen == id) {
            woken.push(id.to_string());
        }
    }
    woken
}

/// Ask one platform which of `asks` (all reporting to it) somebody asked to wake, at most [`WAKES_MAX`] to an ask.
pub fn wakes(platform: &str, asks: &[Target]) -> Vec<String> {
    let mut woken = Vec::new();
    for chunk in asks.chunks(WAKES_MAX) {
        let Ok(mut response) = agent(platform, WAKES_LIMIT)
            .post(format!("{platform}/host-report/wakes"))
            .send_json(wakes_body(chunk))
        else {
            continue;
        };
        if response.status().as_u16() != 200 {
            continue;
        }
        if let Ok(answer) = response.body_mut().read_json::<serde_json::Value>() {
            woken.extend(woken_of(&answer, chunk));
        }
    }
    woken
}

struct Pending {
    target: Target,
    stage: Stage,
    body: serde_json::Value,
}

/// The poster: one thread, so a slow platform never stalls the run it narrates. Per sandbox, a report that changes
/// the stage goes out at once; one within the same stage is COALESCED, the latest kept and sent once two seconds
/// have passed since the last post (the platform skips a same-stage write under two seconds old, so sending sooner
/// would lose it). The last report, `done`, always goes: it changes the stage.
pub struct Poster {
    tx: Option<Sender<Pending>>,
    done: Option<std::sync::mpsc::Receiver<()>>,
}

/// The least time between two posts of the same stage for one sandbox.
const SAME_STAGE_GAP: Duration = Duration::from_secs(2);
/// How long one post may take; a failure is ignored.
const POST_LIMIT: Duration = Duration::from_secs(5);

impl Poster {
    pub fn start() -> Poster {
        let (tx, rx) = channel::<Pending>();
        let (finished, done) = channel::<()>();
        std::thread::spawn(move || {
            let mut waiting: HashMap<String, Pending> = HashMap::new();
            let mut last: HashMap<String, (Instant, Stage)> = HashMap::new();
            let mut open = true;
            while open || !waiting.is_empty() {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(report) => {
                        waiting.insert(report.target.sandbox.clone(), report);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => open = false,
                }
                let due: Vec<String> = waiting
                    .iter()
                    .filter(|(sandbox, report)| match last.get(*sandbox) {
                        None => true,
                        Some((at, stage)) => {
                            *stage != report.stage || at.elapsed() >= SAME_STAGE_GAP
                        }
                    })
                    .map(|(sandbox, _)| sandbox.clone())
                    .collect();
                for sandbox in due {
                    if let Some(report) = waiting.remove(&sandbox) {
                        post(&report);
                        last.insert(sandbox, (Instant::now(), report.stage));
                    }
                }
            }
            let _ = finished.send(());
        });
        Poster {
            tx: Some(tx),
            done: Some(done),
        }
    }

    pub fn send(&self, target: &Target, stage: Stage, body: serde_json::Value) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Pending {
                target: target.clone(),
                stage,
                body,
            });
        }
    }

    /// Deliver what is waiting, bounded: the run is over, and a platform that does not answer must not hold it.
    pub fn finish(&mut self) {
        self.tx = None;
        if let Some(done) = self.done.take() {
            let _ = done.recv_timeout(SAME_STAGE_GAP + POST_LIMIT + Duration::from_secs(1));
        }
    }
}

fn post(report: &Pending) {
    let body = serde_json::json!({ "sandbox": report.target.sandbox, "report": report.body });
    let _ = agent(&report.target.platform, POST_LIMIT)
        .post(format!("{}/host-report", report.target.platform))
        .header("Authorization", &format!("Bearer {}", report.target.key))
        .send_json(&body);
}

/* THE MACHINE-READABLE HALF, for `--json` (the machine agent reads it): progress as `intentic-fix: {json}` lines,
then one bare JSON line per sandbox, `{"slug": …, "report": HostReportInput}`. Written straight to stdout: in a `--json`
run every human line has been sent to stderr (ui::send_human_to_stderr), so nothing else lands between them. */

/// The marker a progress line carries: a prefix of its own, like `intentic-requirement:`, so no reader takes it
/// for a step (`intentic: [phase]`) or for a result.
pub const MARKER: &str = "intentic-fix:";

pub fn progress_line(slug: Option<&str>, stage: Stage, doing: Option<&str>) -> String {
    let line = serde_json::json!({ "slug": slug, "stage": stage.wire(), "doing": doing });
    format!("{MARKER} {line}")
}

pub fn result_line(slug: &str, report: &serde_json::Value) -> String {
    serde_json::json!({ "slug": slug, "report": report }).to_string()
}

pub fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    /* RFC 4231's own vectors: a hand-rolled HMAC is only as good as the test that pins it. */
    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2: a short key.
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Test case 1: twenty 0x0b bytes.
        assert_eq!(
            hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // Test case 6: a key longer than the block, which is hashed first.
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn the_report_key_is_the_hmac_of_the_contracts_label_under_the_token() {
        assert_eq!(KEY_LABEL, "intentic/host-report/v1");
        let key = report_key("token");
        assert_eq!(key, hex(&hmac_sha256(b"token", KEY_LABEL.as_bytes())));
        assert_eq!(key.len(), 64);
        assert!(key
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(report_key("token"), report_key("other"));
    }

    #[test]
    fn only_a_slug_that_carries_a_tunnel_id_can_be_reported() {
        assert_eq!(
            tunnel_id("sandbox-0123456789ab").as_deref(),
            Some("0123456789ab")
        );
        assert_eq!(tunnel_id("0123456789ab").as_deref(), Some("0123456789ab"));
        assert_eq!(
            tunnel_id("sandbox-0123456789AB"),
            None,
            "the platform's ids are lowercase"
        );
        assert_eq!(tunnel_id("work"), None);
        assert_eq!(tunnel_id("sandbox-0123456789abc"), None);
    }

    fn record_with(key: Option<&str>, platform: Option<&str>) -> crate::record::ChannelRecord {
        crate::record::ChannelRecord {
            report_key: key.map(str::to_string),
            report_platform: platform.map(str::to_string),
            ..crate::record::ChannelRecord::default()
        }
    }

    #[test]
    fn a_report_goes_where_the_fix_engine_would_send_it() {
        let slug = "sandbox-0123456789ab";
        let kept = record_with(Some("kept"), Some("https://kept.example"));
        let from_token = target_of(
            slug,
            Some("token"),
            Some("http://host.docker.internal:6480/"),
            &kept,
            None,
        )
        .expect("a target");
        assert_eq!(
            from_token,
            Target {
                platform: "http://localhost:6480".to_string(),
                key: report_key("token"),
                sandbox: "0123456789ab".to_string(),
            }
        );
        let from_record = target_of(slug, None, None, &kept, None).expect("a target");
        assert_eq!(
            (from_record.platform.as_str(), from_record.key.as_str()),
            ("https://kept.example", "kept")
        );
        let forced = target_of(
            slug,
            None,
            Some("https://c.example"),
            &kept,
            Some("https://f.example/"),
        )
        .expect("a target");
        assert_eq!(forced.platform, "https://f.example");
        let defaulted =
            target_of(slug, None, None, &record_with(Some("k"), None), None).expect("a target");
        assert_eq!(defaulted.platform, DEFAULT_PLATFORM);
        assert_eq!(
            target_of(
                slug,
                None,
                None,
                &record_with(None, Some("https://p")),
                None
            ),
            None,
            "no key, no report"
        );
        assert_eq!(
            target_of("work", Some("token"), None, &kept, None),
            None,
            "no tunnel id, no report"
        );
    }

    #[test]
    fn a_wake_is_asked_with_each_key_and_only_what_was_asked_about_is_woken() {
        let ask = |id: &str| Target {
            platform: "https://p".to_string(),
            key: format!("key-{id}"),
            sandbox: id.to_string(),
        };
        let asked = vec![ask("0123456789ab"), ask("ba9876543210")];
        assert_eq!(
            wakes_body(&asked),
            serde_json::json!({ "asks": [
                { "sandbox": "0123456789ab", "key": "key-0123456789ab" },
                { "sandbox": "ba9876543210", "key": "key-ba9876543210" },
            ] })
        );
        assert_eq!(
            woken_of(
                &serde_json::json!({ "wake": ["ba9876543210", "ffffffffffff", "ba9876543210", 7] }),
                &asked
            ),
            vec!["ba9876543210".to_string()],
            "never one nobody asked about, and each once"
        );
        assert!(woken_of(&serde_json::json!({ "wake": [] }), &asked).is_empty());
        assert!(woken_of(&serde_json::json!({ "error": "nope" }), &asked).is_empty());
        assert!(woken_of(&serde_json::json!(["0123456789ab"]), &asked).is_empty());
    }

    #[test]
    fn a_containers_own_spelling_of_the_platform_is_turned_into_this_machines() {
        assert_eq!(
            from_host("http://host.docker.internal:6480/"),
            "http://localhost:6480"
        );
        assert_eq!(
            from_host("https://api.intentic.dev"),
            "https://api.intentic.dev"
        );
    }

    #[test]
    fn progress_lines_carry_their_own_marker_and_results_are_bare_json() {
        let line = progress_line(
            Some("sandbox-abc"),
            Stage::Fixing,
            Some("Starting Docker Desktop"),
        );
        let json = line
            .strip_prefix("intentic-fix: ")
            .expect("the marker, then one space");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(json).expect("one JSON object"),
            serde_json::json!({ "slug": "sandbox-abc", "stage": "fixing", "doing": "Starting Docker Desktop" })
        );
        let result = result_line("sandbox-abc", &serde_json::json!({ "stage": "done" }));
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("one JSON object");
        assert_eq!(parsed["slug"], "sandbox-abc");
        assert_eq!(parsed["report"]["stage"], "done");
    }
}
