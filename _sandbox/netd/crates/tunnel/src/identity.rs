//! Who dialled a tunnel, and whether its carrier still hears it: the two facts the edge's one-holder rule reads. Before
//! 2026-10-05 nothing told two netd instances of one sandbox apart, so two containers holding one grant (started from both
//! Windows and WSL, say) took the tunnel from each other every minute for as long as both ran: the edge let the newest
//! registration win, and the loser came back after a flat 60 s.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::DEAD_AFTER;

/// netd's instance, on a tunnel's upgrade: random, minted once per netd process, which lives as long as its
/// container. A netd naming none predates instances, and the edge lets its newest registration win as it always did.
pub const INSTANCE_HEADER: &str = "x-intentic-instance";

/// Where that netd runs, as a person reads it (`HOST_LABEL`, then `HOST_PLATFORM` and `HOST_ENV` in brackets), for the
/// edge to name when it refuses another copy.
pub const HOST_HEADER: &str = "x-intentic-host";

/// On an upgrade the edge refused with 409 because another copy holds the sandbox: where that copy runs.
pub const HOLDER_HEADER: &str = "x-intentic-holder";

// A header value is visible ASCII, and a host's description is a line, not a document.
const HOST_BYTES: usize = 120;

/// A netd as its tunnels present it: its instance, and where it runs. Carried in the upgrade's headers on a socket and
/// in the hello on QUIC, in the same words.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub instance: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host: String,
}

impl Identity {
    /// `host` describes the machine as the container's environment names it: `rog (linux, Ubuntu)`, `rog (windows)`,
    /// `rog`, or nothing when it names nothing.
    pub fn new(instance: String, label: &str, platform: &str, environment: &str) -> Self {
        let details: Vec<&str> = [platform, environment]
            .into_iter()
            .map(str::trim)
            .filter(|detail| !detail.is_empty())
            .collect();
        let label = label.trim();
        let host = match (label.is_empty(), details.is_empty()) {
            (_, true) => label.to_owned(),
            (true, false) => details.join(", "),
            (false, false) => format!("{label} ({})", details.join(", ")),
        };
        Self {
            instance: header_safe(&instance),
            host: header_safe(&host),
        }
    }

    /// The identity a request's two headers carry; none without an instance, which is a netd from before instances.
    pub fn of_headers(instance: Option<&str>, host: Option<&str>) -> Option<Self> {
        let instance = header_safe(instance?.trim());
        (!instance.is_empty()).then(|| Self {
            instance,
            host: host.map(header_safe).unwrap_or_default(),
        })
    }

    /// How a refusal names the holder's machine.
    pub fn named_host(host: &str) -> &str {
        if host.is_empty() {
            "an unnamed machine"
        } else {
            host
        }
    }
}

/// Visible ASCII only, at most `HOST_BYTES`: a machine's name may be anything its owner typed, and a header carries
/// bytes a proxy may refuse otherwise. What is not visible ASCII becomes `?`.
pub fn header_safe(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character == ' ' || character.is_ascii_graphic() {
                character
            } else {
                '?'
            }
        })
        .take(HOST_BYTES)
        .collect()
}

/// When a carrier last heard its far end, and whether a liveness round (a ping answered, a probe answered) ever
/// completed on it. Shared: the carrier marks it, and the edge's registry reads it to tell a live holder from one that
/// went silent without a FIN.
#[derive(Debug)]
pub struct Heard {
    epoch: Instant,
    last_ms: AtomicU64,
    answered: AtomicBool,
}

impl Default for Heard {
    fn default() -> Self {
        Self {
            epoch: Instant::now(),
            last_ms: AtomicU64::new(0),
            answered: AtomicBool::new(false),
        }
    }
}

impl Heard {
    /// Something arrived from the far end now.
    pub fn mark(&self) {
        let since = u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_ms.fetch_max(since, Ordering::Relaxed);
    }

    /// A liveness round completed: the far end answered something this end asked. Marks it heard too.
    pub fn answer(&self) {
        self.mark();
        self.answered.store(true, Ordering::Relaxed);
    }

    /// How long since the far end was last heard (since this was made, before anything was).
    pub fn silent(&self) -> Duration {
        self.epoch
            .elapsed()
            .saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)))
    }

    /// Whether the far end was heard within the dead window both ends drop a silent peer after.
    pub fn alive(&self) -> bool {
        self.silent() <= DEAD_AFTER
    }

    /// Whether a liveness round ever completed: the carrier worked, whatever ended it later.
    pub fn answered(&self) -> bool {
        self.answered.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_is_its_label_and_whatever_else_the_environment_names() {
        let named = |label, platform, environment| {
            Identity::new("a1".into(), label, platform, environment).host
        };
        assert_eq!(named("rog", "linux", "Ubuntu"), "rog (linux, Ubuntu)");
        assert_eq!(named("rog", "windows", ""), "rog (windows)");
        assert_eq!(named(" rog ", "", ""), "rog");
        assert_eq!(named("", "linux", ""), "linux");
        assert_eq!(named("", "", ""), "");
        assert_eq!(Identity::named_host(""), "an unnamed machine");
    }

    #[test]
    fn what_a_header_cannot_carry_is_replaced_and_a_long_name_cut() {
        assert_eq!(header_safe("Caf\u{e9}-PC\n"), "Caf?-PC?");
        assert_eq!(header_safe(&"x".repeat(500)).len(), HOST_BYTES);
        assert_eq!(
            Identity::of_headers(Some(" 0af3 "), Some("rog")),
            Some(Identity {
                instance: "0af3".into(),
                host: "rog".into()
            })
        );
        assert_eq!(Identity::of_headers(Some(""), Some("rog")), None);
        assert_eq!(Identity::of_headers(None, Some("rog")), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_carrier_is_alive_until_silent_past_the_dead_window() {
        let heard = Heard::default();
        assert!(heard.alive());
        assert!(!heard.answered());
        tokio::time::advance(DEAD_AFTER - Duration::from_secs(1)).await;
        heard.answer();
        assert!(heard.answered());
        tokio::time::advance(DEAD_AFTER).await;
        assert!(heard.alive());
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(!heard.alive());
        assert!(heard.silent() > DEAD_AFTER);
    }
}
