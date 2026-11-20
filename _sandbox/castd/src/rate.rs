//! Bitrate and flow control over viewers' acks. One encoder serves every viewer, so one viewer's link sets the bitrate:
//! the one driving the window (the latest to send input), else the fastest. voxl took the slowest (`rate.min(r)` over
//! every viewer), which let a phone on a train blur the picture for the person typing. A viewer that cannot keep up
//! with the steering one is skipped (`lagging`): it gets no frames until what it has drains, then a keyframe.

use std::time::{Duration, Instant};

/// A viewer as the policy sees it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Viewer {
    pub id: u64,
    /// Has received a keyframe since its video (re)started.
    pub started: bool,
    /// castd's own (a recording): acks at once, so it is never a measure of anyone's link.
    pub internal: bool,
    /// When it last sent input, in ms since castd started; 0 if never.
    pub last_input: u64,
    pub delivered_kbps: f64,
    pub queue_ms: f64,
    /// Age of its oldest unacknowledged frame.
    pub backlog_age_ms: f64,
    pub rtt_ms: f64,
}

/// The viewer the bitrate follows: the latest to send input, else the one delivering the most (fewest queued ms on a
/// tie). Viewers yet to start and castd's own are never it.
pub fn steering(viewers: &[Viewer]) -> Option<&Viewer> {
    let live = || viewers.iter().filter(|v| v.started && !v.internal);
    if let Some(driver) = live()
        .filter(|v| v.last_input > 0)
        .max_by_key(|v| v.last_input)
    {
        return Some(driver);
    }
    live().max_by(|a, b| {
        a.delivered_kbps
            .total_cmp(&b.delivered_kbps)
            .then(b.queue_ms.total_cmp(&a.queue_ms))
    })
}

/// How many frames may be in flight to a viewer, and for how long, before it is behind: enough to cover one RTT plus
/// decode, never more than about rtt + 120 ms of queue.
pub fn backlog_limits(rtt_ms: f64, interval_ms: f64) -> (usize, f64) {
    let max_n = (((rtt_ms + 40.0) / interval_ms).ceil() as usize + 2).clamp(3, 40);
    (max_n, rtt_ms + 120.0)
}

/// Whether a viewer with `n` frames in flight, the oldest `age_ms` old, is behind.
pub fn behind(n: usize, age_ms: f64, rtt_ms: f64, interval_ms: f64) -> bool {
    let (max_n, max_age) = backlog_limits(rtt_ms, interval_ms);
    n >= max_n || age_ms > max_age
}

/// Delay-based bitrate adaptation on the steering viewer's acks: back off toward the measured delivery rate when acks
/// show queueing, probe upward slowly when the path is clear. voxl's controller, fed one viewer instead of the minimum
/// of all.
pub struct RateCtl {
    pub target: f64,
    max: f64,
    min: f64,
    last_eval: Instant,
    last_dec: Instant,
    last_inc: Instant,
    /// Ramp multiplicatively until the first sign of congestion (like TCP slow start), so a session neither starts by
    /// flooding a slow link nor crawls up on a fast one.
    slow_start: bool,
    /// Delivery rate observed at the last congestion: the path's likely capacity.
    ceiling: f64,
    ceiling_at: Instant,
    /// The viewer the estimate belongs to; another one starts over from where the bitrate stands.
    following: Option<u64>,
}

/// Starting point for a new session's bitrate cap (kbit/s).
const START_KBPS: f64 = 8000.0;

impl RateCtl {
    pub fn new(max: f64, min: f64) -> Self {
        let past = Instant::now() - Duration::from_secs(10);
        RateCtl {
            target: START_KBPS.min(max).max(min),
            max,
            min,
            last_eval: past,
            last_dec: past,
            last_inc: past,
            slow_start: true,
            ceiling: f64::MAX,
            ceiling_at: past,
            following: None,
        }
    }

    /// Re-evaluates at most every 100 ms against `steer`, the steering viewer (None: nobody to follow, hold).
    pub fn update(&mut self, steer: Option<&Viewer>) {
        if self.last_eval.elapsed() < Duration::from_millis(100) {
            return;
        }
        self.last_eval = Instant::now();
        let Some(v) = steer else {
            return;
        };
        if self.following != Some(v.id) {
            // A new viewer's link says nothing the old one's ceiling knew.
            self.following = Some(v.id);
            self.ceiling = f64::MAX;
            self.slow_start = true;
        }
        let congested = v.queue_ms > 30.0 || v.backlog_age_ms > v.rtt_ms + 80.0;
        let clear = v.queue_ms <= 15.0;
        let rate = if congested && v.delivered_kbps > 0.0 {
            v.delivered_kbps
        } else {
            f64::MAX
        };
        let delivered = v.delivered_kbps;
        let now = Instant::now();
        if congested && self.last_dec.elapsed() >= Duration::from_millis(300) {
            let mut t = self.target * 0.85;
            // Delivery rate only says something about capacity when we were actually pushing near the target;
            // congestion from one big frame on an idle screen would otherwise pin the ceiling at a few kbps.
            if rate.is_finite() && rate >= self.target * 0.5 {
                self.ceiling = rate;
                self.ceiling_at = now;
                t = t.min(rate * 0.85);
            }
            self.target = t.max(self.min);
            self.last_dec = now;
            self.slow_start = false;
        } else if self.slow_start
            && !congested
            && clear
            && self.last_inc.elapsed() >= Duration::from_millis(250)
        {
            // Only probe upward once the content actually presses against the cap.
            if delivered >= self.target * 0.5 {
                self.target = (self.target * 1.5).min(self.max);
                self.last_inc = now;
            }
        } else if !congested
            && clear
            && self.last_dec.elapsed() >= Duration::from_secs(1)
            && delivered >= self.target * 0.5
        {
            // Paths change; forget a capacity estimate that has not been confirmed lately.
            if self.ceiling_at.elapsed() >= Duration::from_secs(15) {
                self.ceiling = f64::MAX;
            }
            // Recover quickly to just under the known capacity, then probe past it gently so a busy link is not
            // driven into the queue every couple of seconds.
            if self.target < self.ceiling * 0.9
                && self.last_inc.elapsed() >= Duration::from_millis(200)
            {
                self.target = (self.target * 1.06 + 100.0)
                    .min(self.ceiling * 0.9)
                    .min(self.max);
                self.last_inc = now;
            } else if self.target >= self.ceiling * 0.9
                && self.last_inc.elapsed() >= Duration::from_millis(1000)
            {
                self.target = (self.target * 1.02).min(self.max);
                self.last_inc = now;
            }
        }
    }

    /// Lets the next `update` run now, for tests that step the controller.
    #[cfg(test)]
    fn rewind(&mut self) {
        let past = Instant::now() - Duration::from_secs(10);
        self.last_eval = past;
        self.last_dec = past;
        self.last_inc = past;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer(id: u64, last_input: u64, kbps: f64, queue_ms: f64) -> Viewer {
        Viewer {
            id,
            started: true,
            internal: false,
            last_input,
            delivered_kbps: kbps,
            queue_ms,
            backlog_age_ms: 0.0,
            rtt_ms: 20.0,
        }
    }

    #[test]
    fn the_driver_steers_even_when_it_is_slower() {
        let fast_watcher = viewer(1, 0, 20_000.0, 0.0);
        let slow_driver = viewer(2, 500, 3_000.0, 40.0);
        let earlier_driver = viewer(3, 100, 9_000.0, 0.0);
        let all = [fast_watcher, slow_driver, earlier_driver];
        assert_eq!(steering(&all).map(|v| v.id), Some(2));
    }

    #[test]
    fn without_a_driver_the_fastest_steers() {
        let all = [
            viewer(1, 0, 3_000.0, 0.0),
            viewer(2, 0, 20_000.0, 5.0),
            viewer(3, 0, 20_000.0, 1.0),
        ];
        assert_eq!(steering(&all).map(|v| v.id), Some(3));
    }

    #[test]
    fn a_recording_or_a_viewer_yet_to_start_never_steers() {
        let mut recorder = viewer(1, 0, 1e9, 0.0);
        recorder.internal = true;
        let mut joining = viewer(2, 900, 0.0, 0.0);
        joining.started = false;
        let watcher = viewer(3, 0, 5_000.0, 0.0);
        assert_eq!(
            steering(&[recorder, joining, watcher]).map(|v| v.id),
            Some(3)
        );
        assert_eq!(steering(&[recorder, joining]), None);
    }

    #[test]
    fn a_slow_watcher_never_lowers_the_drivers_bitrate() {
        let mut rc = RateCtl::new(30_000.0, 1_000.0);
        let start = rc.target;
        let driver = viewer(1, 10, 9_000.0, 0.0);
        let mut congested_watcher = viewer(2, 0, 500.0, 400.0);
        congested_watcher.backlog_age_ms = 2_000.0;
        for _ in 0..10 {
            rc.rewind();
            let all = [driver, congested_watcher];
            rc.update(steering(&all));
        }
        assert!(
            rc.target >= start,
            "the target fell to {} from {start} for a watcher's congestion",
            rc.target
        );
        // The same congestion on the driver's own link does bring it down.
        let mut congested_driver = driver;
        congested_driver.queue_ms = 400.0;
        congested_driver.delivered_kbps = 2_000.0;
        let before = rc.target;
        rc.rewind();
        rc.update(Some(&congested_driver));
        assert!(rc.target < before);
    }

    #[test]
    fn behind_means_too_many_frames_or_too_old_a_frame() {
        let interval = 1000.0 / 60.0;
        let (max_n, max_age) = backlog_limits(20.0, interval);
        assert_eq!(max_n, 6);
        assert_eq!(max_age, 140.0);
        assert!(!behind(max_n - 1, max_age, 20.0, interval));
        assert!(behind(max_n, 0.0, 20.0, interval));
        assert!(behind(1, max_age + 1.0, 20.0, interval));
    }
}
