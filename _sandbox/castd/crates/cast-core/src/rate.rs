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
    /// What its pictures' video track's congestion control estimates the link carries (kbit/s), less the part copies
    /// of its packets take while they go out twice (`Feedback::media_kbps`), for a viewer whose pictures ride a track:
    /// it sends no acks, and the estimate is the bitrate's measure instead. None otherwise.
    pub estimate_kbps: Option<f64>,
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

/// The frames per second the capture aims at: `fps`, or while a viewer on this computer drives, its display's rate
/// (`display_hz`, 0 when it never said) up to `local_fps`. Never below `fps`, which every viewer is served at, and a
/// display that never said is taken at `fps`: a faster screen makes Chromium draw that much more often.
pub fn frame_rate(fps: u32, local_fps: u32, display_hz: Option<u32>) -> u32 {
    match display_hz {
        Some(hz) if hz > 0 && local_fps > fps => hz.clamp(fps, local_fps),
        _ => fps,
    }
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
    /// What the encoder put out lately (kbit/s), and the cumulative bytes and time it was last read at.
    encoded_kbps: Option<f64>,
    encoded_at: Option<(u64, Instant)>,
    /// How much of a track's share the encoder is asked for, so that what it puts out is the share: an encoder that
    /// overshoots its target (openh264 at its QP ceiling on content too busy for the cap) is asked for less.
    track_scale: f64,
}

/// Starting point for a new session's bitrate cap (kbit/s).
const START_KBPS: f64 = 8000.0;

/// The share of a track's congestion estimate the encoder is given (rtc's): the rest is room for retransmissions.
use crate::rtc::TRACK_SHARE;
/// Past this far ahead of its share (ms), the encoder is given less until what it sent drains.
const TRACK_QUEUE_MS: f64 = 60.0;

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
            encoded_kbps: None,
            encoded_at: None,
            track_scale: 1.0,
        }
    }

    /// The encoder's cumulative output, in bytes, as of `now`: what a track's bitrate checks its target against.
    pub fn note_encoded(&mut self, bytes: u64, now: Instant) {
        let Some((b0, t0)) = self.encoded_at else {
            self.encoded_at = Some((bytes, now));
            return;
        };
        let secs = now.saturating_duration_since(t0).as_secs_f64();
        if secs < 0.25 {
            return;
        }
        let kbps = bytes.saturating_sub(b0) as f64 * 8.0 / 1000.0 / secs;
        self.encoded_kbps = Some(self.encoded_kbps.map_or(kbps, |k| k * 0.5 + kbps * 0.5));
        self.encoded_at = Some((bytes, now));
    }

    /// Moves the ceiling: the local one while a viewer on this computer drives, the network's otherwise. `open`: the
    /// target goes straight to the new ceiling (a loopback has no capacity to probe for); else it only comes down to it.
    pub fn set_ceiling(&mut self, max: f64, open: bool) {
        self.max = max.max(self.min);
        self.target = if open {
            self.max
        } else {
            self.target.min(self.max)
        };
        self.ceiling = f64::MAX;
        self.slow_start = !open;
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
        // A track's congestion control (delay and loss over transport-wide feedback, with its own probing) already says
        // what the link carries: the bitrate follows it, and what waits for the link is drained.
        if let Some(estimate) = v.estimate_kbps {
            let drain = if v.queue_ms > TRACK_QUEUE_MS {
                0.7
            } else {
                1.0
            };
            let share = estimate * TRACK_SHARE * drain;
            // Only output past the share loads the link: an encoder putting out less (content that needs less, or a
            // target it undershoots) is left its share.
            if let Some(out) = self.encoded_kbps.filter(|k| *k > 0.0) {
                if out > share * 1.05 {
                    self.track_scale = (self.track_scale * share / out).max(0.3);
                } else if out < share * 0.95 {
                    self.track_scale = (self.track_scale * 1.1).min(1.0);
                }
            }
            self.target = (share * self.track_scale).clamp(self.min, self.max);
            self.slow_start = false;
            return;
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
            estimate_kbps: None,
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
    fn a_local_driver_opens_the_ceiling_at_once_and_a_remote_one_closes_it() {
        let mut rc = RateCtl::new(30_000.0, 500.0);
        assert_eq!(rc.target, START_KBPS);
        rc.set_ceiling(200_000.0, true);
        assert_eq!(rc.target, 200_000.0);
        // Congestion still brings it down: a loopback forwarded somewhere slow is still a link.
        let mut congested = viewer(1, 10, 20_000.0, 400.0);
        congested.backlog_age_ms = 500.0;
        rc.rewind();
        rc.update(Some(&congested));
        assert_eq!(rc.target, 200_000.0 * 0.85);
        // A remote driver brings the target down to its ceiling, and starts probing from there.
        rc.set_ceiling(30_000.0, false);
        assert_eq!(rc.target, 30_000.0);
    }

    #[test]
    fn a_track_steers_by_its_estimate_and_drains_its_queue() {
        let mut rc = RateCtl::new(30_000.0, 500.0);
        let mut track = viewer(1, 10, 0.0, 0.0);
        track.estimate_kbps = Some(4_000.0);
        rc.rewind();
        rc.update(Some(&track));
        assert_eq!(rc.target, 4_000.0 * TRACK_SHARE);
        // Waiting in front of the link: less until it drains.
        track.queue_ms = TRACK_QUEUE_MS + 1.0;
        rc.rewind();
        rc.update(Some(&track));
        assert_eq!(rc.target, 4_000.0 * TRACK_SHARE * 0.7);
        // An encoder that puts out more than it is asked is asked for less, until it puts out its share.
        track.queue_ms = 0.0;
        let t0 = Instant::now();
        rc.note_encoded(0, t0);
        rc.note_encoded(1_000_000, t0 + Duration::from_secs(1));
        rc.rewind();
        rc.update(Some(&track));
        assert!(rc.target < 4_000.0 * TRACK_SHARE, "{}", rc.target);
        // One that puts out less than its share (content that needs less) is given all of it back.
        for _ in 0..20 {
            rc.encoded_kbps = Some(1_000.0);
            rc.rewind();
            rc.update(Some(&track));
        }
        assert_eq!(rc.target, 4_000.0 * TRACK_SHARE);
        // Within the bounds whatever the estimate.
        track.estimate_kbps = Some(1e9);
        rc.rewind();
        rc.update(Some(&track));
        assert_eq!(rc.target, 30_000.0);
        track.estimate_kbps = Some(10.0);
        rc.rewind();
        rc.update(Some(&track));
        assert_eq!(rc.target, 500.0);
    }

    #[test]
    fn the_frame_rate_follows_a_local_display_within_the_bounds() {
        // No local driver, or no faster local rate allowed: --fps.
        assert_eq!(frame_rate(60, 60, Some(240)), 60);
        assert_eq!(frame_rate(60, 120, None), 60);
        // A display that never said is taken at --fps.
        assert_eq!(frame_rate(60, 120, Some(0)), 60);
        assert_eq!(frame_rate(60, 120, Some(144)), 120);
        assert_eq!(frame_rate(60, 240, Some(144)), 144);
        // A slower display never takes the screen below what every viewer is served at.
        assert_eq!(frame_rate(60, 240, Some(30)), 60);
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
