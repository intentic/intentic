//! Where the ingress tunnel stands, kept in one place for the two that read it: Node, told on every change over the
//! control socket (`ToNode::Tunnel`), and the vitals (`TunnelVitals`), which count how often a held tunnel dropped. And
//! the pace each carrier redials at, decided from how its last dial ended.
//!
//! 2026-10-05: a tunnel dropped once a minute for four hours. Node logged "the ingress tunnel dropped" with no reason,
//! the front's reason went to stdout only, and nothing counted the drops. The same day showed what two copies of one
//! sandbox would do: each took the tunnel from the other, the loser standing back a flat 60 s and taking it again,
//! forever. Now the edge refuses the second copy while the first lives, and a refused front backs off with jitter, then
//! after three refusals in a row dials every 15 minutes and tells Node where the holder runs.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use browser_wire::{TunnelState, TunnelVitals};
use front_wire::{ToNode, TunnelRefusal};
use relay::Backoff;

/// Every carrier redials on this ladder: from a second to thirty, a minute held, or one answered ping or probe, counting
/// as working.
pub const REDIAL: Backoff = Backoff::new(
    Duration::from_secs(1),
    Duration::from_secs(30),
    Duration::from_secs(60),
);

/// How long a carrier stands back from a sandbox another party took or holds, drawn in this range so two parties never
/// return together: a flat 60 s, before 2026-10-05, had two copies trading the tunnel in lockstep.
pub const STAND_BACK: (Duration, Duration) = (Duration::from_secs(60), Duration::from_secs(120));

/// Refusals in a row, for another copy holding the sandbox, before the front slows to `ELSEWHERE_PACE` and tells Node.
pub const ELSEWHERE_LIMIT: u32 = 3;

/// How often a front another copy keeps refused dials once past `ELSEWHERE_LIMIT`: the copy may stop, and this one then
/// takes over within a quarter of an hour, without knocking every minute meanwhile.
pub const ELSEWHERE_PACE: (Duration, Duration) =
    (Duration::from_secs(15 * 60), Duration::from_secs(16 * 60));

/// How long a front waits before dialling again for a sandbox the platform deleted: no dial can succeed, and the daemon
/// hears the same at its next announce (410). Long rather than never, so a deletion recorded by mistake and undone heals.
pub const DELETED_PACE: Duration = Duration::from_secs(60 * 60);

// How far back the vitals count drops.
const DROP_WINDOW: Duration = Duration::from_secs(60 * 60);

/// How one dial of a carrier ended, which decides when it dials again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// It never registered, or it was held and dropped; `proven` when it carried an answered ping or probe first.
    Dropped { why: String, proven: bool },
    /// A newer tunnel took the slot: an older front of this sandbox, which the edge still lets win.
    Displaced,
    /// Another copy of this sandbox holds it and its carrier is alive; the edge named where it runs.
    Elsewhere(String),
    /// The platform deleted this sandbox.
    Deleted,
    /// The edge stopped trusting this QUIC connection: a probe or a request went unanswered on it.
    Demoted,
}

impl Outcome {
    /// The line Node logs and the front prints.
    pub fn reason(&self) -> String {
        match self {
            Self::Dropped { why, .. } => why.clone(),
            Self::Displaced => "a newer tunnel for this sandbox took its place".into(),
            Self::Elsewhere(host) => format!(
                "held by another copy of this sandbox on {}",
                tunnel::Identity::named_host(host)
            ),
            Self::Deleted => "the platform deleted this sandbox".into(),
            Self::Demoted => "the edge stopped trusting this QUIC connection".into(),
        }
    }
}

/// When a carrier dials next, and whether the front stopped redialling at its usual pace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Next {
    pub wait: Duration,
    pub refused: Option<TunnelRefusal>,
}

/// One carrier's redial pace: its ladder, and how many times in a row another copy refused it.
#[derive(Debug, Clone)]
pub struct Pace {
    backoff: Backoff,
    refusals: u32,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            backoff: REDIAL,
            refusals: 0,
        }
    }
}

impl Pace {
    /// The wait after a dial that lasted `lived` and ended as `outcome`.
    pub fn next(&mut self, outcome: &Outcome, lived: Duration) -> Next {
        self.drawing(outcome, lived, relay::between)
    }

    fn drawing(
        &mut self,
        outcome: &Outcome,
        lived: Duration,
        draw: impl Fn(Duration, Duration) -> Duration,
    ) -> Next {
        if !matches!(outcome, Outcome::Elsewhere(_)) {
            self.refusals = 0;
        }
        let (wait, refused) = match outcome {
            Outcome::Dropped { proven, .. } => (self.backoff.after_proven(lived, *proven), None),
            // Its age says nothing: a half-dead path holds a connection a long while, and must not redial at once.
            Outcome::Demoted => (self.backoff.after_proven(Duration::ZERO, false), None),
            Outcome::Displaced => (draw(STAND_BACK.0, STAND_BACK.1), None),
            Outcome::Elsewhere(host) => {
                self.refusals = self.refusals.saturating_add(1);
                if self.refusals >= ELSEWHERE_LIMIT {
                    (
                        draw(ELSEWHERE_PACE.0, ELSEWHERE_PACE.1),
                        Some(TunnelRefusal::Elsewhere { host: host.clone() }),
                    )
                } else {
                    (draw(STAND_BACK.0, STAND_BACK.1), None)
                }
            }
            Outcome::Deleted => (DELETED_PACE, Some(TunnelRefusal::Deleted)),
        };
        Next { wait, refused }
    }
}

/// The tunnel's standing, shared by the carriers that change it and the two that read it.
#[derive(Default)]
pub struct Standing {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    configured: bool,
    held: bool,
    reason: Option<String>,
    refused: Option<TunnelRefusal>,
    quic: bool,
    drops: VecDeque<Instant>,
}

impl Standing {
    /// A tunnel is configured, or none is; either way nothing is held yet.
    pub fn configure(&self, configured: bool) {
        let mut inner = self.lock();
        inner.configured = configured;
        inner.held = false;
        inner.quic = false;
        inner.reason = None;
        inner.refused = None;
    }

    /// The interactive socket registered.
    pub fn held(&self) {
        let mut inner = self.lock();
        inner.held = true;
        inner.reason = None;
        inner.refused = None;
    }

    /// The interactive socket is not held: it dropped after registering (`was_held`, a flap counted at `at`) or a dial
    /// failed, for `reason`; `refused` when the front stopped redialling at its usual pace.
    pub fn not_held(
        &self,
        was_held: bool,
        reason: String,
        refused: Option<TunnelRefusal>,
        at: Instant,
    ) {
        let mut inner = self.lock();
        inner.held = false;
        inner.reason = Some(reason);
        inner.refused = refused;
        if was_held {
            forget_before(&mut inner.drops, at);
            inner.drops.push_back(at);
        }
    }

    pub fn quic(&self, held: bool) {
        self.lock().quic = held;
    }

    /// What Node is told: now, and again whenever a Node says hello.
    pub fn report(&self) -> ToNode {
        let inner = self.lock();
        if inner.held {
            return ToNode::tunnel_held();
        }
        ToNode::Tunnel {
            connected: false,
            reason: inner.reason.clone(),
            refused: inner.refused.clone(),
        }
    }

    pub fn vitals(&self, now: Instant) -> Option<TunnelVitals> {
        let mut inner = self.lock();
        forget_before(&mut inner.drops, now);
        let (state, holder) = match (&inner.refused, inner.held, inner.configured) {
            (_, _, false) => (TunnelState::Off, None),
            (_, true, true) => (TunnelState::Held, None),
            (Some(TunnelRefusal::Elsewhere { host }), false, true) => {
                (TunnelState::Elsewhere, Some(host.clone()))
            }
            (Some(TunnelRefusal::Deleted), false, true) => (TunnelState::Deleted, None),
            (None, false, true) => (TunnelState::Dialling, None),
        };
        Some(TunnelVitals {
            state,
            drops_last_hour: u32::try_from(inner.drops.len()).unwrap_or(u32::MAX),
            holder,
            quic: inner.quic && inner.configured,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .expect("the tunnel's standing is never poisoned")
    }
}

// Oldest first, so what fell out of the window is always at the front.
fn forget_before(drops: &mut VecDeque<Instant>, now: Instant) {
    while drops
        .front()
        .is_some_and(|at| now.saturating_duration_since(*at) > DROP_WINDOW)
    {
        drops.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    fn top(low: Duration, high: Duration) -> Duration {
        assert!(low <= high);
        high
    }

    #[test]
    fn three_refusals_in_a_row_slow_the_front_and_name_the_holder() {
        let mut pace = Pace::default();
        let refused = Outcome::Elsewhere("omen (windows)".into());
        for _ in 1..ELSEWHERE_LIMIT {
            let next = pace.drawing(&refused, Duration::ZERO, top);
            assert_eq!(
                next,
                Next {
                    wait: STAND_BACK.1,
                    refused: None
                }
            );
        }
        let named = Some(TunnelRefusal::Elsewhere {
            host: "omen (windows)".into(),
        });
        for _ in 0..3 {
            let next = pace.drawing(&refused, Duration::ZERO, top);
            assert_eq!(
                next,
                Next {
                    wait: ELSEWHERE_PACE.1,
                    refused: named.clone()
                }
            );
        }
        // Held again: the count starts over, and the next refusal stands back the short way.
        pace.drawing(
            &Outcome::Dropped {
                why: "x".into(),
                proven: true,
            },
            SECOND,
            top,
        );
        assert_eq!(pace.drawing(&refused, Duration::ZERO, top).refused, None);
    }

    #[test]
    fn a_displacement_stands_back_a_drawn_while_and_a_deletion_an_hour() {
        let mut pace = Pace::default();
        for _ in 0..50 {
            let next = pace.next(&Outcome::Displaced, Duration::ZERO);
            assert!(
                (STAND_BACK.0..=STAND_BACK.1).contains(&next.wait),
                "{next:?}"
            );
            assert_eq!(next.refused, None);
        }
        assert_eq!(
            pace.next(&Outcome::Deleted, Duration::ZERO),
            Next {
                wait: DELETED_PACE,
                refused: Some(TunnelRefusal::Deleted)
            }
        );
    }

    // The 2026-10-05 shape: a carrier cut at 45 s by an idle timeout never reached the minute that counted it working.
    #[test]
    fn a_carrier_that_answered_a_ping_redials_from_the_floor_and_a_demoted_one_climbs() {
        let mut pace = Pace::default();
        let unproven = Outcome::Dropped {
            why: "idle".into(),
            proven: false,
        };
        for _ in 0..6 {
            pace.drawing(&unproven, 45 * SECOND, top);
        }
        let proven = Outcome::Dropped {
            why: "idle".into(),
            proven: true,
        };
        assert!(pace.next(&proven, 45 * SECOND).wait <= 2 * SECOND);
        // However long it lived, a demoted connection climbs the ladder: its last waits reach past the floor's double,
        // which a ladder started again at every demotion would never draw.
        let mut demoted = Pace::default();
        let waits: Vec<Duration> = (0..10)
            .map(|_| demoted.next(&Outcome::Demoted, 600 * SECOND).wait)
            .collect();
        assert!(waits.iter().all(|wait| *wait <= 30 * SECOND));
        assert!(
            waits[5..].iter().any(|wait| *wait > 2 * SECOND),
            "{waits:?}"
        );
    }

    #[test]
    fn the_report_and_the_vitals_follow_the_interactive_socket() {
        let standing = Standing::default();
        let start = Instant::now();
        assert_eq!(standing.vitals(start).unwrap().state, TunnelState::Off);
        standing.configure(true);
        assert_eq!(standing.vitals(start).unwrap().state, TunnelState::Dialling);
        standing.held();
        standing.quic(true);
        assert_eq!(standing.report(), ToNode::tunnel_held());
        let vitals = standing.vitals(start).unwrap();
        assert_eq!((vitals.state, vitals.quic), (TunnelState::Held, true));

        standing.not_held(true, "no frame from the far end in 46s".into(), None, start);
        assert_eq!(
            standing.report(),
            ToNode::Tunnel {
                connected: false,
                reason: Some("no frame from the far end in 46s".into()),
                refused: None
            }
        );
        standing.held();
        standing.not_held(true, "again".into(), None, start + 60 * SECOND);
        // A dial that never registered is no flap.
        standing.not_held(false, "could not dial".into(), None, start + 61 * SECOND);
        assert_eq!(
            standing
                .vitals(start + 61 * SECOND)
                .unwrap()
                .drops_last_hour,
            2
        );
        assert_eq!(
            standing
                .vitals(start + 3_630 * SECOND)
                .unwrap()
                .drops_last_hour,
            1,
            "the first fell out of the hour"
        );

        standing.not_held(
            false,
            "held by another copy".into(),
            Some(TunnelRefusal::Elsewhere {
                host: "rog (linux)".into(),
            }),
            start,
        );
        let vitals = standing.vitals(start).unwrap();
        assert_eq!(
            (vitals.state, vitals.holder.as_deref()),
            (TunnelState::Elsewhere, Some("rog (linux)"))
        );
        standing.not_held(false, "deleted".into(), Some(TunnelRefusal::Deleted), start);
        assert_eq!(standing.vitals(start).unwrap().state, TunnelState::Deleted);
        standing.configure(false);
        assert_eq!(standing.vitals(start).unwrap().state, TunnelState::Off);
    }
}
