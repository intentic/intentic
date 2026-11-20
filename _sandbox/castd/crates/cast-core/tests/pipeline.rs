//! The pipeline with no platform under it: a screen in memory the test paints, captured the way a DXGI backend's CPU
//! path does (a thread of the platform's own reports damage and signals a wake; `grab` copies the damaged rows), an
//! encoder that writes stand-in NAL units saying what picture it was handed, and a viewer read straight off the hub.
//! Runs where there is neither X nor x264 (Windows), on CPU I420 frames and on native frames.

use cast_core::capture::{Capture, Damage, ScreenSource};
use cast_core::encoder::{Encoded, EncoderConfig, EncoderKind, Encoders, VideoEncoder};
use cast_core::frame::{Frame, FrameFormat, NativeFrame, Picture};
use cast_core::geometry::{Band, Rect, ResizeLimits};
use cast_core::header::{FLAG_KEY, FLAG_REFINE, KIND_VIDEO};
use cast_core::hub::{Client, Hub, Joining, Out, WantSize};
use cast_core::video::{self, VideoConfig};
use cast_core::wake::{Waitable, Wake};
use std::any::Any;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The screen the test paints: BGRX rows, and what changed since the capture last pumped.
struct Screen {
    w: u32,
    h: u32,
    px: Vec<u8>,
    dirty: Vec<(u32, u32, u32, u32)>,
    resized: bool,
}

impl Screen {
    /// Fills rows [y0, y1) with grey `v` and says so.
    fn paint(&mut self, y0: u32, y1: u32, v: u8) {
        let row = self.w as usize * 4;
        self.px[y0 as usize * row..y1 as usize * row].fill(v);
        self.dirty.push((0, y0, self.w, y1));
    }
}

#[derive(Clone)]
struct Shared {
    screen: Arc<Mutex<Screen>>,
    /// Signalled whenever the screen changed: what the capture thread waits on (a DXGI thread's own wake).
    wake: Arc<Wake>,
    native: bool,
}

struct Source(Shared);

impl ScreenSource for Source {
    fn open(&mut self, crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
        assert!(crop.is_none());
        let s = self.0.screen.lock().unwrap();
        let (w, h) = (s.w, s.h);
        drop(s);
        Ok(Box::new(Memory {
            shared: self.0.clone(),
            w,
            h,
            frame: vec![0; (w * h * 4) as usize],
            damage: Damage::new(w, h),
            rebuild: false,
        }))
    }

    fn resize_limits(&self) -> Option<ResizeLimits> {
        Some(((32, 32), (256, 256)))
    }

    fn resize(&mut self, w: u32, h: u32) -> Result<(), String> {
        let mut s = self.0.screen.lock().unwrap();
        *s = Screen {
            w,
            h,
            px: vec![0x40; (w * h * 4) as usize],
            dirty: Vec::new(),
            resized: false,
        };
        Ok(())
    }
}

/// The capture: its own copy of the picture, brought up to date band by band.
struct Memory {
    shared: Shared,
    w: u32,
    h: u32,
    frame: Vec<u8>,
    damage: Damage,
    rebuild: bool,
}

/// A "GPU texture": the picture's bytes, filled by the capture and read by the encoder through downcasts.
struct Texture {
    w: u32,
    h: u32,
    bytes: Vec<u8>,
}

impl NativeFrame for Texture {
    fn width(&self) -> u32 {
        self.w
    }
    fn height(&self) -> u32 {
        self.h
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

impl Capture for Memory {
    fn area(&self) -> Rect {
        Rect {
            x: 0,
            y: 0,
            w: self.w,
            h: self.h,
        }
    }
    fn screen(&self) -> (u32, u32) {
        (self.w, self.h)
    }
    fn cropped(&self) -> bool {
        false
    }
    fn damage(&mut self) -> &mut Damage {
        &mut self.damage
    }
    fn waitable(&self) -> Option<Waitable<'_>> {
        Some(self.shared.wake.waitable())
    }
    fn pump(&mut self) -> Result<(), String> {
        self.shared.wake.drain();
        let mut s = self.shared.screen.lock().unwrap();
        if s.resized {
            self.rebuild = true;
        }
        for (x0, y0, x1, y1) in std::mem::take(&mut s.dirty) {
            self.damage.add(x0, y0, x1, y1);
        }
        Ok(())
    }
    fn needs_rebuild(&self) -> bool {
        self.rebuild
    }
    fn grab(&mut self, band: Band) -> Result<(), String> {
        let row = self.w as usize * 4;
        let s = self.shared.screen.lock().unwrap();
        let (a, b) = (band.y0 as usize * row, band.y1 as usize * row);
        if s.px.len() >= b {
            self.frame[a..b].copy_from_slice(&s.px[a..b]);
        }
        Ok(())
    }
    fn pixels(&self) -> Option<(&[u8], usize)> {
        Some((&self.frame, self.w as usize * 4))
    }
    fn formats(&self) -> &[FrameFormat] {
        if self.shared.native {
            &[FrameFormat::Native, FrameFormat::I420]
        } else {
            &[FrameFormat::I420, FrameFormat::Bgra]
        }
    }
    fn new_frame(&mut self, format: FrameFormat) -> Result<Frame, String> {
        match format {
            FrameFormat::Native => Ok(Frame::Native(Box::new(Texture {
                w: self.w,
                h: self.h,
                bytes: vec![0; self.frame.len()],
            }))),
            other => Frame::cpu(other, self.w as usize, self.h as usize).ok_or("no".into()),
        }
    }
    fn fill(
        &mut self,
        dst: &mut Frame,
        y0: usize,
        y1: usize,
        threads: usize,
    ) -> Result<(), String> {
        let Frame::Native(t) = dst else {
            let (px, stride) = (&self.frame, self.w as usize * 4);
            match dst {
                Frame::I420(buf) => {
                    cast_core::convert::convert_band(px, stride, buf, y0, y1, threads)
                }
                Frame::Bgra(buf) => buf.copy_rows(px, stride, y0, y1),
                Frame::Native(_) => unreachable!(),
            }
            return Ok(());
        };
        let t = t
            .as_any_mut()
            .downcast_mut::<Texture>()
            .ok_or("not my texture")?;
        let row = self.w as usize * 4;
        t.bytes[y0 * row..y1 * row].copy_from_slice(&self.frame[y0 * row..y1 * row]);
        Ok(())
    }
}

/// Writes an IDR (with SPS and PPS) or a delta slice, followed by the mean of the luma (or of the texture's bytes)
/// it was handed and what kind of frame it was.
struct Stand {
    formats: &'static [FrameFormat],
}

impl VideoEncoder for Stand {
    fn name(&self) -> &'static str {
        "stand-in"
    }
    fn threaded(&self) -> bool {
        false
    }
    fn formats(&self) -> &'static [FrameFormat] {
        self.formats
    }
    fn set_rate(&mut self, _crf: f32, _max_kbps: u32) {}
    fn set_rate_buf(&mut self, _crf: f32, _max_kbps: u32, _buf_kbit: u32) {}
    fn encode(
        &mut self,
        p: &Picture,
        _ts_ms: i64,
        force_idr: bool,
        _qp: Option<i32>,
        _mb_info: Option<&mut [u8]>,
        out: &mut Vec<u8>,
    ) -> Result<Encoded, String> {
        let (kind, mean) = match p {
            Picture::I420(planes) => (b'i', mean(planes.y)),
            Picture::Bgra { data, .. } => (b'b', mean(data)),
            Picture::Native(t) => {
                let t = t
                    .as_any()
                    .downcast_ref::<Texture>()
                    .ok_or("not a texture")?;
                (b'n', mean(&t.bytes))
            }
        };
        if force_idr {
            out.extend_from_slice(&self.headers());
            out.extend_from_slice(&[0, 0, 0, 1, 0x65]);
        } else {
            out.extend_from_slice(&[0, 0, 0, 1, 0x41]);
        }
        out.extend_from_slice(&[kind, mean]);
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

fn mean(b: &[u8]) -> u8 {
    (b.iter().map(|&x| u64::from(x)).sum::<u64>() / b.len().max(1) as u64) as u8
}

struct StandKind(&'static [FrameFormat]);

impl EncoderKind for StandKind {
    fn name(&self) -> &'static str {
        "stand-in"
    }
    fn hardware(&self) -> bool {
        true
    }
    fn open(&self, _cfg: &EncoderConfig) -> Result<Box<dyn VideoEncoder>, String> {
        Ok(Box::new(Stand { formats: self.0 }))
    }
}

fn config(encoder: Encoders) -> VideoConfig {
    VideoConfig {
        crop: None,
        fps: 60,
        preset: "ultrafast".into(),
        threads: 1,
        convert_threads: 1,
        crf: 24.0,
        max_kbps: 8000,
        paintover_crf: 16.0,
        paintover_burst: 3,
        paintover_delay_ms: 150,
        min_kbps: 500,
        local_crf: 18.0,
        local_max_kbps: 200_000,
        local_fps: 60,
        lossless: false,
        lossless_delay: Duration::from_millis(100),
        coalesce: Duration::ZERO,
        stripes: 1,
        adaptive_threads: true,
        encoder,
    }
}

/// A video message's payload and flags, or a hello's size, as the viewer reads them.
#[derive(Debug, PartialEq)]
enum Seen {
    Video {
        key: bool,
        refine: bool,
        tail: Vec<u8>,
    },
    Hello {
        width: u32,
        height: u32,
    },
}

/// The next video message or hello for `c`, its frames acknowledged at once.
fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Out>, c: &Client, hub: &Hub) -> Seen {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match rx.try_recv() {
            Ok(Out::Media(m)) if m.header.kind == KIND_VIDEO => {
                c.on_ack(m.header.id);
                hub.wake();
                let p = &m.payload;
                return Seen::Video {
                    key: m.header.flags & FLAG_KEY != 0,
                    refine: m.header.flags & FLAG_REFINE != 0,
                    tail: p[p.len() - 2..].to_vec(),
                };
            }
            Ok(Out::Hello(text)) => {
                let v: serde_json::Value = serde_json::from_str(&text).unwrap();
                return Seen::Hello {
                    width: v["width"].as_u64().unwrap() as u32,
                    height: v["height"].as_u64().unwrap() as u32,
                };
            }
            Ok(_) => {}
            Err(_) => {
                assert!(
                    Instant::now() < deadline,
                    "nothing from the pipeline within 10 s"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}

/// The next picture that is not a paint-over pass.
fn next_picture(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Out>, c: &Client, hub: &Hub) -> Seen {
    loop {
        match next(rx, c, hub) {
            Seen::Video { refine: true, .. } => {}
            seen => return seen,
        }
    }
}

fn run(native: bool, capture_native: bool) {
    let shared = Shared {
        screen: Arc::new(Mutex::new(Screen {
            w: 64,
            h: 48,
            px: vec![0x20; 64 * 48 * 4],
            dirty: Vec::new(),
            resized: false,
        })),
        wake: Arc::new(Wake::new().unwrap()),
        native: capture_native,
    };
    let formats: &'static [FrameFormat] = if native {
        &[FrameFormat::Native]
    } else {
        &[FrameFormat::I420]
    };
    let encoders = Encoders {
        primary: Arc::new(StandKind(formats)),
        fallback: Arc::new(StandKind(&[FrameFormat::I420])),
    };
    let hub = Hub::new(1.0, None);
    video::spawn(
        config(encoders),
        hub.clone(),
        Box::new(Source(shared.clone())),
    )
    .unwrap();
    assert_eq!(
        hub.resize_limits.lock().map(|(_, max)| max),
        Some((256, 256))
    );
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let c = hub.add_client(tx, Joining::default());
    c.video.store(true, Ordering::Relaxed);
    hub.wake();
    // The frames read are what the capture could fill of what the encoder takes.
    let kind = if native && capture_native { b'n' } else { b'i' };
    // What the encoder saw of a grey screen: the bytes themselves on a texture, else BT.601 luma (16 + v * 219 / 255,
    // which libyuv's SIMD rows and the portable ones round each their own way: a step either side).
    let grey = |bgrx: u8| -> u8 {
        if kind == b'n' {
            bgrx
        } else {
            ((u32::from(bgrx) * 220 + 0x1080) >> 8) as u8
        }
    };
    let close = |seen: Seen, key: bool, bgrx: u8| match seen {
        Seen::Video {
            key: k,
            refine: false,
            tail,
        } if k == key && tail[0] == kind && tail[1].abs_diff(grey(bgrx)) <= 1 => {}
        other => panic!(
            "expected a {} of grey {bgrx:#x} on {}, got {other:?}",
            if key { "keyframe" } else { "delta" },
            kind as char
        ),
    };
    // The first picture is a keyframe of the whole screen.
    close(next_picture(&mut rx, &c, &hub), true, 0x20);
    assert_eq!(*hub.encoder.lock(), "stand-in");
    assert_eq!(hub.codec.lock().as_str(), "avc1.64001f");
    // Paint the whole screen: the next picture is a delta of the new content.
    shared.screen.lock().unwrap().paint(0, 48, 0xa0);
    shared.wake.signal();
    close(next_picture(&mut rx, &c, &hub), false, 0xa0);
    // A screenshot is the picture as captured, and /wait has seen the change.
    let (shot_tx, shot_rx) = tokio::sync::oneshot::channel();
    hub.snapshots.lock().push(shot_tx);
    hub.wake();
    let shot = shot_rx.blocking_recv().unwrap();
    assert_eq!((shot.width, shot.height), (64, 48));
    assert!(shot.bgrx.iter().all(|&b| b == 0xa0));
    assert!(
        shot.seq >= 2,
        "the paint reached /wait's activity ({})",
        shot.seq
    );
    // The viewer's box asks for another size: the screen is resized between captures, and the viewer hears the new
    // geometry before a keyframe of it.
    hub.on_resize(
        &c,
        WantSize {
            width: 100,
            height: 60,
            scale: 1.0,
        },
    );
    loop {
        match next(&mut rx, &c, &hub) {
            Seen::Hello { width, height } => {
                assert_eq!((width, height), (100, 60));
                break;
            }
            Seen::Video { .. } => {}
        }
    }
    close(next_picture(&mut rx, &c, &hub), true, 0x40);
    assert_eq!(hub.width.load(Ordering::Relaxed), 100);
}

#[test]
fn a_painted_screen_streams_through_the_pipeline_on_cpu_frames() {
    run(false, false);
}

#[test]
fn a_native_capture_and_encoder_meet_on_native_frames() {
    run(true, true);
}

#[test]
fn an_encoder_of_native_frames_alone_falls_back_where_the_capture_makes_none() {
    run(true, false);
}
