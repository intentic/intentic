//! The redial ladder: each failure doubles the ceiling up to a cap, a life past `stable_after` starts it again, and the
//! wait is drawn between the floor and the ceiling so a fleet dropped at once does not return in lockstep. A carrier
//! that proved itself (a ping or probe answered) starts it again however short its life: a tunnel cut every 45 s by an
//! idle timeout never reached the minute's mark, and its redials climbed to thirty seconds apart (2026-10-05).

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Backoff {
    floor: Duration,
    cap: Duration,
    stable_after: Duration,
    rung: Duration,
}

impl Backoff {
    pub const fn new(floor: Duration, cap: Duration, stable_after: Duration) -> Self {
        Self {
            floor,
            cap,
            stable_after,
            rung: floor,
        }
    }

    /// How long to wait before the next attempt, after one that lasted `lived`.
    pub fn after(&mut self, lived: Duration) -> Duration {
        self.after_drawing(lived, false, jitter())
    }

    /// The same, for an attempt that may have proved itself before it ended: `proven` when it carried at least one
    /// answered liveness round, which counts it as working whatever its age.
    pub fn after_proven(&mut self, lived: Duration, proven: bool) -> Duration {
        self.after_drawing(lived, proven, jitter())
    }

    // `draw` in [0, 1) places the wait between the floor and this rung's ceiling.
    fn after_drawing(&mut self, lived: Duration, proven: bool, draw: f64) -> Duration {
        if proven || lived >= self.stable_after {
            self.rung = self.floor;
        }
        let ceiling = (self.rung * 2).min(self.cap);
        self.rung = ceiling;
        self.floor + (ceiling - self.floor).mul_f64(draw)
    }
}

/// A wait drawn between `low` and `high`: for standing back from something another party holds, where two parties
/// waiting the same flat time would come back together (two copies of one sandbox took its tunnel from each other
/// every 60 s, exactly, until 2026-10-05).
pub fn between(low: Duration, high: Duration) -> Duration {
    drawn_between(low, high, jitter())
}

fn drawn_between(low: Duration, high: Duration, draw: f64) -> Duration {
    low + high.saturating_sub(low).mul_f64(draw)
}

// Spread, not secrecy: the clock's nanoseconds are unpredictable enough between machines.
fn jitter() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.subsec_nanos());
    f64::from(nanos) / 1e9
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn the_ceiling_doubles_to_the_cap_and_a_stable_life_starts_it_again() {
        let mut backoff = Backoff::new(SECOND, 30 * SECOND, 60 * SECOND);
        let ceilings: Vec<Duration> = (0..6)
            .map(|_| backoff.after_drawing(Duration::ZERO, false, 1.0))
            .collect();
        assert_eq!(
            ceilings,
            [2, 4, 8, 16, 30, 30].map(|seconds| seconds * SECOND)
        );
        assert_eq!(backoff.after_drawing(60 * SECOND, false, 1.0), 2 * SECOND);
        assert_eq!(backoff.after_drawing(Duration::ZERO, false, 0.0), SECOND);
    }

    #[test]
    fn a_short_life_that_answered_a_liveness_round_starts_the_ladder_again() {
        let mut backoff = Backoff::new(SECOND, 30 * SECOND, 60 * SECOND);
        for _ in 0..5 {
            backoff.after_drawing(45 * SECOND, false, 1.0);
        }
        assert_eq!(backoff.after_drawing(45 * SECOND, false, 1.0), 30 * SECOND);
        assert_eq!(backoff.after_drawing(45 * SECOND, true, 1.0), 2 * SECOND);
    }

    #[test]
    fn a_drawn_wait_falls_between_its_bounds() {
        assert_eq!(drawn_between(60 * SECOND, 120 * SECOND, 0.0), 60 * SECOND);
        assert_eq!(drawn_between(60 * SECOND, 120 * SECOND, 0.5), 90 * SECOND);
        for _ in 0..50 {
            let wait = between(60 * SECOND, 120 * SECOND);
            assert!((60 * SECOND..=120 * SECOND).contains(&wait), "{wait:?}");
        }
    }

    #[test]
    fn a_wait_is_never_under_the_floor_nor_over_the_cap() {
        let mut backoff = Backoff::new(SECOND, 30 * SECOND, 60 * SECOND);
        for _ in 0..50 {
            let wait = backoff.after(Duration::ZERO);
            assert!((SECOND..=30 * SECOND).contains(&wait), "{wait:?}");
        }
    }
}
