//! Screenshots and recordings on castd's control socket, for the daemon's agent tools (voxl's):
//!
//! - `GET /screenshot`: the picture as a PNG.
//! - `POST /record/start` -> `{"id": n}`, then `POST /record/stop?id=n`: returns an MP4
//!   of everything in between.
//! - `POST /record/start?file=<name>`: the same, written to `<--record-dir>/<name>` as it is
//!   recorded (mdat first, moov at the stop), so neither castd nor the daemon ever holds the
//!   video; `stop` then answers `{"file", "bytes"}`. The name is a plain file name ending
//!   `.mp4`, never a path, and is never written over.
//!
//! A recording is the H.264 stream castd already encodes, rewrapped as MP4: the recorder
//! joins as one more viewer that acknowledges frames at once, so it costs almost no
//! CPU and never slows real viewers down. Like the stream, it holds frames only when
//! the screen changes, and it doesn't include the cursor (viewers draw it locally).

use crate::header::{FLAG_KEY, KIND_VIDEO};
use crate::hub::{Client, Hub, Out};
use crate::mp4;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// How long a started recording that ran into the length limit waits for its
/// `/record/stop` before it is discarded (the caller may have crashed or forgotten).
const UNCLAIMED: Duration = Duration::from_secs(60);

pub struct Recorder {
    pub hub: Arc<Hub>,
    /// Longest recording; a started one stops on its own after this.
    pub max: Duration,
    /// Where a recording named by `file=` is written (`--record-dir`); none takes only in-memory ones.
    pub dir: Option<PathBuf>,
    active: Mutex<HashMap<u64, Active>>,
    next: AtomicU64,
}

/// What a finished recording is: the MP4 itself, or the file it was written to and its length.
pub enum Recorded {
    Memory(Vec<u8>),
    File { path: PathBuf, bytes: u64 },
}

struct Active {
    stop: oneshot::Sender<()>,
    done: tokio::task::JoinHandle<Result<Recorded, String>>,
}

impl Recorder {
    pub fn new(hub: Arc<Hub>, max: Duration, dir: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Recorder {
            hub,
            max,
            dir,
            active: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        })
    }
}

/// A file name a recording may be written under: `[A-Za-z0-9._-]{1,128}` ending `.mp4`, not starting with a dot. No
/// path, so it lands in the recording directory and nowhere else.
pub fn recording_name_ok(name: &str) -> bool {
    (5..=128).contains(&name.len())
        && name.ends_with(".mp4")
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Where a recording's frames go as they arrive: kept for an MP4 written at the stop, or written to its file now.
enum Sink {
    Memory(Vec<mp4::Frame>),
    File {
        path: PathBuf,
        mp4: mp4::Streaming<BufWriter<std::fs::File>>,
    },
}

impl Sink {
    fn empty(&self) -> bool {
        match self {
            Sink::Memory(frames) => frames.is_empty(),
            Sink::File { mp4, .. } => mp4.is_empty(),
        }
    }
}

/// The screen as captured (BGRX, 4 bytes a pixel, rows packed), for a screenshot.
pub struct Snapshot {
    pub width: usize,
    pub height: usize,
    pub bgrx: Vec<u8>,
    /// The latest change (`/wait`) the pixels include.
    pub seq: u64,
}

impl Snapshot {
    /// RGB (8 bits per channel), exactly as on screen.
    fn to_rgb(&self) -> Vec<u8> {
        let mut out = vec![0u8; self.width * self.height * 3];
        for (o, p) in out
            .as_chunks_mut::<3>()
            .0
            .iter_mut()
            .zip(self.bgrx.as_chunks::<4>().0)
        {
            o.copy_from_slice(&[p[2], p[1], p[0]]);
        }
        out
    }
}

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (
        code,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "error": msg.into() }).to_string(),
    )
        .into_response()
}

fn video(mp4: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "video/mp4"),
            (
                header::CONTENT_DISPOSITION,
                "inline; filename=\"castd.mp4\"",
            ),
        ],
        mp4,
    )
        .into_response()
}

pub async fn screenshot(State(r): State<Arc<Recorder>>) -> Response {
    let (tx, rx) = oneshot::channel();
    r.hub.snapshots.lock().push(tx);
    r.hub.wake();
    let Ok(Ok(frame)) = tokio::time::timeout(Duration::from_secs(5), rx).await else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no frame from capture");
    };
    let seq = frame.seq;
    let png = tokio::task::spawn_blocking(move || {
        let (w, h) = (frame.width as u32, frame.height as u32);
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        enc.write_header()
            .and_then(|mut w| w.write_image_data(&frame.to_rgb()))
            .map(|_| out)
            .map_err(|e| e.to_string())
    })
    .await;
    match png {
        Ok(Ok(png)) => {
            let mut res = (
                [
                    (header::CONTENT_TYPE, "image/png"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                png,
            )
                .into_response();
            // For `/wait?change&since=`: changes after this screenshot.
            res.headers_mut()
                .insert("x-castd-seq", header::HeaderValue::from(seq));
            res
        }
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Opens the file a recording is written to: a new file in the recording directory, never one already there.
#[allow(clippy::result_large_err)]
fn open_file(r: &Recorder, name: &str) -> Result<Sink, Response> {
    let Some(dir) = r.dir.as_ref() else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "this castd writes no recording to a file (no --record-dir)",
        ));
    };
    if !recording_name_ok(name) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "file must be a plain name ending .mp4: [A-Za-z0-9._-]{5,128}, no leading dot",
        ));
    }
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(name);
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
    };
    let file = file.map_err(|e| err(StatusCode::CONFLICT, format!("{}: {e}", path.display())))?;
    let mp4 = mp4::Streaming::new(BufWriter::with_capacity(1 << 20, file)).map_err(|e| {
        let _ = std::fs::remove_file(&path);
        err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;
    Ok(Sink::File { path, mp4 })
}

/// Joins as a viewer and collects frames until `stop`, `max` or a geometry change.
#[allow(clippy::result_large_err)]
fn begin(
    r: &Arc<Recorder>,
    stop: oneshot::Receiver<()>,
    max: Duration,
    sink: Sink,
) -> Result<tokio::task::JoinHandle<Result<Recorded, String>>, Response> {
    if r.hub.stripes.lock().len() > 1 {
        return Err(err(
            StatusCode::CONFLICT,
            "recording needs a single-stripe stream (--stripes 1)",
        ));
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let client = r.hub.add_client(tx, true, true);
    client.video.store(true, Ordering::Relaxed);
    r.hub.wake();
    let hub = r.hub.clone();
    Ok(tokio::spawn(async move {
        let collected = collect(&hub, &client, rx, stop, max, sink).await;
        hub.remove_client(client.id);
        let (sink, size, end) = collected?;
        tokio::task::spawn_blocking(move || finish(sink, size, end))
            .await
            .map_err(|e| e.to_string())?
    }))
}

/// The recording made whole: the MP4 written from memory, or the file's moov written after its samples. A file that
/// came to nothing is removed.
fn finish(sink: Sink, size: (u32, u32), end: u64) -> Result<Recorded, String> {
    match sink {
        Sink::Memory(frames) => mp4::write(&frames, size.0, size.1, end).map(Recorded::Memory),
        Sink::File { path, mp4 } => match mp4.finish(size.0, size.1, end) {
            Ok((_, bytes)) => Ok(Recorded::File { path, bytes }),
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                Err(e)
            }
        },
    }
}

async fn collect(
    hub: &Hub,
    client: &Client,
    mut rx: mpsc::UnboundedReceiver<Out>,
    mut stop: oneshot::Receiver<()>,
    max: Duration,
    mut sink: Sink,
) -> Result<(Sink, (u32, u32), u64), String> {
    let start = Instant::now();
    let deadline = tokio::time::sleep(max);
    tokio::pin!(deadline);
    let mut size = (0, 0);
    let mut last_ms: Option<u64> = None;
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = &mut deadline => break,
            m = rx.recv() => match m {
                None => break,
                Some(Out::Media(m)) if m.header.kind == KIND_VIDEO => {
                    // Acknowledge at once, so the recorder never holds the stream back.
                    client.on_ack(m.header.id);
                    hub.wake();
                    if sink.empty() {
                        size = (hub.width.load(Ordering::Relaxed), hub.height.load(Ordering::Relaxed));
                    }
                    let ms = m.captured.saturating_duration_since(start).as_millis() as u64;
                    let ms = last_ms.map_or(ms, |l| ms.max(l + 1));
                    let key = m.header.flags & FLAG_KEY != 0;
                    match &mut sink {
                        Sink::Memory(frames) => frames.push(mp4::Frame { ms, key, data: m.payload.clone() }),
                        // Into the file's buffer now, and to the disk as it fills: nothing of the picture is kept.
                        Sink::File { mp4, path } => {
                            if let Err(e) = mp4.push(ms, key, &m.payload) {
                                let _ = std::fs::remove_file(&*path);
                                return Err(e);
                            }
                        }
                    }
                    if !sink.empty() {
                        last_ms = Some(ms);
                    }
                }
                // A capture restart (a new size) ends this recording.
                Some(Out::Hello(_)) if !sink.empty() => break,
                _ => {}
            },
        }
    }
    Ok((sink, size, start.elapsed().as_millis() as u64))
}

pub async fn start(
    State(r): State<Arc<Recorder>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let sink = match q.get("file") {
        Some(name) => match open_file(&r, name) {
            Ok(sink) => sink,
            Err(e) => return e,
        },
        None => Sink::Memory(Vec::new()),
    };
    let (stop_tx, stop) = oneshot::channel();
    let done = match begin(&r, stop, r.max, sink) {
        Ok(d) => d,
        Err(e) => return e,
    };
    let id = r.next.fetch_add(1, Ordering::Relaxed);
    r.active.lock().insert(
        id,
        Active {
            stop: stop_tx,
            done,
        },
    );
    log::info!("recording {id} started");
    // Nobody may ever stop it: once it has ended on its own, drop it after a grace period
    // instead of holding the clip in memory forever.
    let rec = r.clone();
    tokio::spawn(async move {
        tokio::time::sleep(rec.max + UNCLAIMED).await;
        let unclaimed = rec.active.lock().remove(&id);
        if let Some(a) = unclaimed {
            log::info!("recording {id} was never stopped; discarded");
            // A file nobody came for is not left in the recording directory either.
            if let Ok(Ok(Recorded::File { path, .. })) = a.done.await {
                let _ = std::fs::remove_file(path);
            }
        }
    });
    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "id": id, "max_seconds": r.max.as_secs() }).to_string(),
    )
        .into_response()
}

pub async fn stop(
    State(r): State<Arc<Recorder>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let id = q.get("id").and_then(|s| s.parse::<u64>().ok());
    let Some(a) = id.and_then(|id| r.active.lock().remove(&id)) else {
        return err(StatusCode::NOT_FOUND, "no such recording");
    };
    let _ = a.stop.send(());
    log::info!("recording {} stopped", id.unwrap_or(0));
    match a.done.await {
        Ok(Ok(Recorded::Memory(mp4))) => video(mp4),
        Ok(Ok(Recorded::File { path, bytes })) => (
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({ "file": path, "bytes": bytes }).to_string(),
        )
            .into_response(),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::recording_name_ok;

    #[test]
    fn a_recording_is_named_by_a_plain_mp4_file_name_and_nothing_that_leaves_its_directory() {
        for ok in ["rec-1.mp4", "a.b_c-D.mp4", "x.mp4"] {
            assert!(recording_name_ok(ok), "{ok}");
        }
        for bad in [
            "",
            ".mp4",
            ".hidden.mp4",
            "../x.mp4",
            "a/b.mp4",
            "/abs.mp4",
            "a.mp3",
            "a.mp4\0",
            "ą.mp4",
            "a b.mp4",
            &format!("{}.mp4", "a".repeat(125)),
        ] {
            assert!(!recording_name_ok(bad), "{bad}");
        }
    }
}
