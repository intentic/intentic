//! The screens' registry with a platform of the test's own: a picture in memory and a stand-in encoder, so it runs
//! where there is neither a display nor an H.264 encoder.

use super::*;
use cast_core::capture::{Capture, Damage, ScreenSource};
use cast_core::encoder::Encoded;
use cast_core::frame::Picture;
use cast_core::hub::{Joining, Out};
use cast_core::wake::Waitable;
use std::sync::atomic::AtomicBool;

#[derive(Default)]
struct Counts {
    opened: AtomicUsize,
    stopped: AtomicUsize,
    /// Every capture opened from now on fails at its next pump.
    fail: AtomicBool,
}

struct Memory {
    counts: Arc<Counts>,
    px: Vec<u8>,
    damage: Damage,
}

const W: u32 = 64;
const H: u32 = 48;

impl Capture for Memory {
    fn area(&self) -> cast_core::geometry::Rect {
        cast_core::geometry::Rect {
            x: 0,
            y: 0,
            w: W,
            h: H,
        }
    }
    fn screen(&self) -> (u32, u32) {
        (W, H)
    }
    fn cropped(&self) -> bool {
        false
    }
    fn damage(&mut self) -> &mut Damage {
        &mut self.damage
    }
    fn waitable(&self) -> Option<Waitable<'_>> {
        None
    }
    fn pump(&mut self) -> Result<(), String> {
        if self.counts.fail.load(Ordering::SeqCst) {
            return Err("the test pulled the monitor out".into());
        }
        Ok(())
    }
    fn needs_rebuild(&self) -> bool {
        false
    }
    fn pixels(&self) -> Option<(&[u8], usize)> {
        Some((&self.px, W as usize * 4))
    }
}

struct Source(Arc<Counts>);

impl ScreenSource for Source {
    fn open(
        &mut self,
        _crop: Option<cast_core::geometry::Rect>,
    ) -> Result<Box<dyn Capture>, String> {
        Ok(Box::new(Memory {
            counts: self.0.clone(),
            px: vec![0x80; (W * H * 4) as usize],
            damage: Damage::new(W, H),
        }))
    }
}

struct Stand;

impl VideoEncoder for Stand {
    fn name(&self) -> &'static str {
        "stand-in"
    }
    fn threaded(&self) -> bool {
        false
    }
    fn set_rate(&mut self, _crf: f32, _max_kbps: u32) {}
    fn set_rate_buf(&mut self, _crf: f32, _max_kbps: u32, _buf_kbit: u32) {}
    fn encode(
        &mut self,
        _p: &Picture,
        _ts_ms: i64,
        force_idr: bool,
        _qp: Option<i32>,
        _mb_info: Option<&mut [u8]>,
        out: &mut Vec<u8>,
    ) -> Result<cast_core::encoder::Encoded, String> {
        if force_idr {
            out.extend_from_slice(&self.headers());
        }
        out.extend_from_slice(&[0, 0, 0, 1, if force_idr { 0x65 } else { 0x41 }, 1]);
        Ok(Encoded {
            keyframe: force_idr,
            qp: None,
            crf_avg: 0.0,
        })
    }
    fn headers(&mut self) -> Vec<u8> {
        vec![0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 0, 1, 0x68, 0xee]
    }
}

struct StandKind;

impl EncoderKind for StandKind {
    fn name(&self) -> &'static str {
        "stand-in"
    }
    fn hardware(&self) -> bool {
        false
    }
    fn open(&self, _cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        Ok(Box::new(Stand))
    }
}

struct Painted(Arc<Counts>);

impl Platform for Painted {
    fn monitors(&self) -> Vec<Monitor> {
        vec![Monitor {
            id: "one".into(),
            name: "One".into(),
            x: 0,
            y: 0,
            width: W,
            height: H,
            scale: 1.0,
            primary: true,
        }]
    }
    fn encoders(&self) -> Vec<String> {
        vec!["stand-in".into()]
    }
    fn describe(&self) -> serde_json::Value {
        serde_json::json!({ "mode": "painted" })
    }
    fn open(&self, monitor: &str, _hub: &Arc<Hub>, base: VideoConfig) -> Result<Opened, String> {
        if monitor != "one" {
            return Err(format!("no {monitor}"));
        }
        self.0.opened.fetch_add(1, Ordering::SeqCst);
        let counts = self.0.clone();
        Ok(Opened {
            source: Box::new(Source(self.0.clone())),
            video: VideoConfig {
                encoder: Encoders {
                    primary: Arc::new(StandKind),
                    fallback: Arc::new(StandKind),
                },
                ..base
            },
            input: None,
            audio: None,
            stops: vec![Box::new(move || {
                counts.stopped.fetch_add(1, Ordering::SeqCst);
            })],
        })
    }
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !check() {
        assert!(tokio::time::Instant::now() < deadline, "{what} within 5 s");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_screen_opens_once_for_its_viewers_and_stops_after_the_last_lingered_out() {
    let counts = Arc::new(Counts::default());
    let screens = Screens::new(
        Arc::new(Painted(counts.clone())),
        Duration::from_millis(200),
    );
    let (a, b) = tokio::join!(screens.join("one"), screens.join("one"));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert!(
        Arc::ptr_eq(a.screen(), b.screen()),
        "both viewers share one pipeline"
    );
    assert_eq!(counts.opened.load(Ordering::SeqCst), 1);
    let running: Vec<_> = screens
        .running()
        .into_iter()
        .map(|r| (r.monitor, r.viewers))
        .collect();
    assert_eq!(running, vec![("one".to_owned(), 2)]);
    assert!(
        screens.join("two").await.is_err(),
        "a monitor the platform refuses"
    );

    drop(a);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        counts.stopped.load(Ordering::SeqCst),
        0,
        "one viewer still watches"
    );

    // The last leaves and another comes back within the linger: the same pipeline, warm.
    drop(b);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let c = screens.join("one").await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(counts.opened.load(Ordering::SeqCst), 1);
    assert_eq!(counts.stopped.load(Ordering::SeqCst), 0);

    drop(c);
    eventually("the screen stopped after its linger", || {
        counts.stopped.load(Ordering::SeqCst) == 1
    })
    .await;
    assert!(screens.running().is_empty());
    let d = screens.join("one").await.unwrap();
    assert_eq!(counts.opened.load(Ordering::SeqCst), 2, "opened afresh");
    drop(d);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_capture_ends_its_screen_alone_and_tells_its_viewers_why() {
    let counts = Arc::new(Counts::default());
    let screens = Screens::new(Arc::new(Painted(counts.clone())), Duration::from_secs(60));
    let seat = screens.join("one").await.unwrap();
    let hub = seat.screen().hub.clone();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = hub.add_client(
        tx,
        Joining {
            read_only: true,
            internal: false,
            local: false,
            lossless: false,
        },
    );
    client.video.store(true, Ordering::Relaxed);
    hub.wake();
    // A frame reaches the viewer: the pipeline runs.
    let got_frame = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(out) = rx.recv().await {
            if matches!(out, Out::Media(_)) {
                return true;
            }
        }
        false
    })
    .await;
    assert_eq!(got_frame, Ok(true));

    counts.fail.store(true, Ordering::SeqCst);
    hub.wake();
    eventually("the viewer was ended", || client.ended().is_some()).await;
    let (code, words) = client.ended().unwrap();
    assert_eq!(code, SCREEN_FAILED);
    assert!(words.contains("the test pulled the monitor out"), "{words}");
    eventually("the screen's stops ran", || {
        counts.stopped.load(Ordering::SeqCst) == 1
    })
    .await;
    assert!(!seat.screen().alive());

    // The process lives on, and the next viewer opens the screen again.
    counts.fail.store(false, Ordering::SeqCst);
    let again = screens.join("one").await.unwrap();
    assert!(again.screen().alive());
    assert_eq!(counts.opened.load(Ordering::SeqCst), 2);
    drop(seat);
    drop(again);
}

#[test]
fn a_session_names_a_screen_only_when_the_platform_lists_it() {
    let painted = Painted(Arc::new(Counts::default()));
    assert_eq!(monitor_of(&painted, "screen-one").as_deref(), Some("one"));
    assert_eq!(monitor_of(&painted, "screen-two"), None);
    assert_eq!(monitor_of(&painted, "one"), None);
}

#[test]
fn a_stun_url_names_its_host_and_port() {
    assert_eq!(
        stun_host("stun:stun.cloudflare.com:3478").as_deref(),
        Some("stun.cloudflare.com:3478")
    );
    assert_eq!(
        stun_host("stun:stun.example").as_deref(),
        Some("stun.example:3478")
    );
    assert_eq!(
        stun_host("stun:stun.example:19302?transport=udp").as_deref(),
        Some("stun.example:19302")
    );
    assert_eq!(
        stun_host("stun:[2001:db8::1]").as_deref(),
        Some("[2001:db8::1]:3478")
    );
    assert_eq!(
        stun_host("stun:[2001:db8::1]:5000").as_deref(),
        Some("[2001:db8::1]:5000")
    );
    assert_eq!(stun_host("turn:relay.example:3478"), None);
    assert_eq!(stun_host("stuns:secure.example"), None);
    assert_eq!(stun_host("stun:"), None);
}
