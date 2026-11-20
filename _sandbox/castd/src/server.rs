//! HTTP/1.1 on castd's Unix socket: the media socket's upgrade, which needs a token (token.rs), and the control
//! endpoints the Node daemon calls, which need none: the socket file's permissions are their guard.
//!
//! - `GET /system/browser-media/<session>?token=…`: a viewer's media socket (media.rs).
//! - `GET /health`: `{"ok":true,…}` once castd serves.
//! - `GET /geometry`: the picture's size and scale, the screen's, the crop, the resize limits and any pin.
//! - `POST /pin?width=&height=&scale=`: holds the screen at that box (CSS pixels times `scale`) whatever viewers ask,
//!   for an emulated phone; their boxes are remembered and `POST /unpin` goes back to the driving viewer's. Both answer
//!   once the new size is in effect (`applied`), at most 3 s later.
//! - `POST /crop?x=&y=&w=&h=`: moves a `--crop` castd's region (screen pixels) without a restart: viewers get a new
//!   `hello` and a keyframe; answered once in effect. Refused (400) by a castd that serves the whole screen.
//! - `GET /screenshot`: the picture as a PNG (record.rs).
//! - `GET /wait?quiet_ms=&timeout_ms=`: answers once nothing changed for `quiet_ms` (wait.rs).
//! - `POST /record/start`, `POST /record/stop?id=`: an MP4 of the stream in between, not re-encoded (record.rs).
//! - `GET /stats`: the pipeline's counters and each viewer's flow state, for debugging and benches.
//! - `POST /viewers/drop[?read_write=1][&reason=]`: ends every viewer's socket (or only the read-write ones) with
//!   browser-wire's `dropped` close code and refuses every such token minted before it: a member's access revoked, a
//!   desktop's control handed back.

use crate::capture::Rect;
use crate::hub::{Hub, WantSize};
use crate::record::Recorder;
use crate::token;
use axum::Router;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

#[derive(Clone)]
pub struct App {
    pub hub: Arc<Hub>,
    /// The HMAC key tokens are signed with.
    pub key: Arc<Vec<u8>>,
    pub session: Arc<String>,
    pub recorder: Arc<Recorder>,
}

/// A media socket's largest message from a viewer: a clipboard image (15 MiB of PNG) in base64.
const MAX_MESSAGE: usize = 24 << 20;

pub fn router(app: App) -> Router {
    let record = Router::new()
        .route("/screenshot", get(crate::record::screenshot))
        .route("/record/start", post(crate::record::start))
        .route("/record/stop", post(crate::record::stop))
        .with_state(app.recorder.clone());
    let wait = Router::new()
        .route("/wait", get(crate::wait::wait))
        .with_state(app.hub.clone());
    Router::new()
        .route(
            &format!("{}/{{session}}", browser_wire::BROWSER_MEDIA_PATH),
            get(media),
        )
        .route("/health", get(health))
        .route("/geometry", get(geometry))
        .route("/pin", post(pin))
        .route("/unpin", post(unpin))
        .route("/crop", post(crop))
        .route("/stats", get(stats))
        .route("/viewers/drop", post(drop_viewers))
        .with_state(app)
        .merge(record)
        .merge(wait)
}

fn json(code: StatusCode, body: serde_json::Value) -> Response {
    (
        code,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

async fn media(
    State(app): State<App>,
    Path(session): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    // Taken as a Result so a request with no token or a bad one hears that, before whether it was an upgrade at all.
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    if session != *app.session {
        return json(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "no such session" }),
        );
    }
    let Some(t) = q.get("token") else {
        return json(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": "a token is required" }),
        );
    };
    let claims = match token::verify(&app.key, &app.session, t, token::now_ms()) {
        Ok(c) => c,
        Err(refused) => {
            log::info!("media socket refused: {}", refused.words());
            return json(
                StatusCode::FORBIDDEN,
                serde_json::json!({ "error": refused.words() }),
            );
        }
    };
    // A token minted before the daemon last dropped the viewers it covers is dead, however long it has left.
    if !app.hub.token_allowed(&claims) {
        log::info!("media socket refused: a token minted before the viewers were dropped");
        return json(
            StatusCode::FORBIDDEN,
            serde_json::json!({ "error": "token revoked" }),
        );
    }
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    // netd says which upgrades arrived on the sandbox's loopback port, and strips that header from everything else.
    let local = headers
        .get(browser_wire::MEDIA_LISTENER_HEADER)
        .is_some_and(|v| v.as_bytes() == browser_wire::MEDIA_LOOPBACK.as_bytes());
    let lossless = q
        .get(browser_wire::MEDIA_LOSSLESS_QUERY)
        .is_some_and(|v| matches!(v.as_str(), "1" | "true"));
    let reach = crate::media::Reach { local, lossless };
    ws.max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| crate::media::serve(socket, app, claims, reach))
}

/// `POST /viewers/drop[?read_write=1][&reason=…]`: ends every viewer's media socket (and with it any peer connection
/// it carries), or only the read-write ones, with the `dropped` close code, and refuses every token of that kind minted
/// before now. What the daemon asks when a member's access is revoked, or a desktop's control is handed back; the
/// viewers still entitled dial again with fresh tokens.
async fn drop_viewers(
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let read_write = q
        .get("read_write")
        .is_some_and(|v| matches!(v.as_str(), "1" | "true"));
    let reason = q
        .get("reason")
        .map_or("the daemon dropped this window's viewers", String::as_str);
    let dropped = app.hub.drop_viewers(read_write, reason);
    log::info!(
        "dropped {dropped} {}viewer(s): {reason}",
        if read_write { "read-write " } else { "" }
    );
    json(
        StatusCode::OK,
        serde_json::json!({ "ok": true, "dropped": dropped }),
    )
}

async fn health(State(app): State<App>) -> Response {
    let hub = &app.hub;
    json(
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "session": *app.session,
            "viewers": hub.clients.lock().iter().filter(|c| !c.internal).count(),
            "width": hub.width.load(Ordering::Relaxed),
            "height": hub.height.load(Ordering::Relaxed),
        }),
    )
}

async fn geometry(State(app): State<App>) -> Response {
    let hub = &app.hub;
    let limits = *hub.resize_limits.lock();
    json(
        StatusCode::OK,
        serde_json::json!({
            "width": hub.width.load(Ordering::Relaxed),
            "height": hub.height.load(Ordering::Relaxed),
            "scale": hub.scale(),
            "codec": hub.codec.lock().clone(),
            "encoder": *hub.encoder.lock(),
            "screen": { "width": hub.screen_width.load(Ordering::Relaxed), "height": hub.screen_height.load(Ordering::Relaxed) },
            "crop": *hub.crop.lock(),
            // castd resizes the toplevels that covered the screen with it (screen.rs), as a window manager would.
            "fitsWindows": limits.is_some(),
            "pinned": hub.pinned.lock().map(|p| serde_json::json!({ "width": p.width, "height": p.height, "scale": p.scale })),
            "resizable": limits.is_some(),
            "min": limits.map(|(min, _)| serde_json::json!({ "width": min.0, "height": min.1 })),
            "max": limits.map(|(_, max)| serde_json::json!({ "width": max.0, "height": max.1 })),
        }),
    )
}

/// Reads a box (`width`, `height` in CSS pixels, `scale`) from a query, as a viewer's `resize` would be checked.
fn want_size(q: &HashMap<String, String>) -> Option<WantSize> {
    let width: u32 = q.get("width")?.parse().ok()?;
    let height: u32 = q.get("height")?.parse().ok()?;
    let scale: f64 = q.get("scale").map_or(Some(1.0), |s| s.parse().ok())?;
    crate::media::sane_box(width, height, scale).then_some(WantSize {
        width,
        height,
        scale,
    })
}

async fn pin(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(want) = want_size(&q) else {
        return json(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "width and height must be 1 to 16384 CSS pixels, scale 0.25 to 8" }),
        );
    };
    applied(&app.hub, app.hub.pin(Some(want))).await
}

async fn unpin(State(app): State<App>) -> Response {
    applied(&app.hub, app.hub.pin(None)).await
}

/// How long a control request waits for the screen to take its new size before it answers anyway.
const APPLY_WITHIN: std::time::Duration = std::time::Duration::from_secs(3);

/// Answers a pin or unpin once the resize it started is in effect (the new picture is being captured, and viewers have
/// their `hello`), so the daemon can read /geometry right after; `applied: false` if that took longer than 3 s.
async fn applied(hub: &Hub, size: Option<(u32, u32)>) -> Response {
    let applied = match size {
        Some(size) => hub.settled_at(size, APPLY_WITHIN).await,
        None => true,
    };
    json(
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "applied": applied,
            "width": hub.width.load(Ordering::Relaxed),
            "height": hub.height.load(Ordering::Relaxed),
        }),
    )
}

async fn crop(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    let hub = &app.hub;
    if hub.crop.lock().is_none() {
        return json(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "this castd serves the whole screen (no --crop)" }),
        );
    }
    let screen = (
        hub.screen_width.load(Ordering::Relaxed),
        hub.screen_height.load(Ordering::Relaxed),
    );
    let field = |k: &str| q.get(k).and_then(|v| v.parse::<u32>().ok());
    let rect = match (field("x"), field("y"), field("w"), field("h")) {
        (Some(x), Some(y), Some(w), Some(h)) => Rect { x, y, w, h }.fit(screen.0, screen.1),
        _ => None,
    };
    let Some(rect) = rect else {
        return json(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": format!("x, y, w, h must be a region of at least 16x16 on the {}x{} screen", screen.0, screen.1) }),
        );
    };
    let mut applied = true;
    if *hub.crop.lock() != Some(rect) {
        *hub.crop_req.lock() = Some(rect);
        hub.wake();
        applied =
            hub.settled_at((rect.w, rect.h), APPLY_WITHIN).await && *hub.crop.lock() == Some(rect);
    }
    json(
        StatusCode::OK,
        serde_json::json!({ "ok": true, "applied": applied, "crop": rect }),
    )
}

async fn stats(State(app): State<App>) -> Response {
    let hub = &app.hub;
    let st = &hub.stats;
    let steer = hub.steering.load(Ordering::Relaxed);
    let viewers: Vec<_> = hub
        .clients
        .lock()
        .iter()
        .map(|c| {
            let (n, age) = c.backlog();
            serde_json::json!({
                "id": c.id,
                "readOnly": c.read_only,
                "internal": c.internal,
                "local": c.local,
                "exact": c.exacting() && c.exact.lock().lossy.is_none(),
                "displayHz": c.display_hz.load(Ordering::Relaxed),
                "steering": c.id == steer,
                "video": c.video.load(Ordering::Relaxed),
                "skipping": c.skipping.load(Ordering::Relaxed),
                "inflight": n,
                "oldestMs": age,
                "rttMs": c.min_rtt_ms.load(Ordering::Relaxed),
                "queueMs": c.delay.lock().queue_ms as u64,
                "deliveredKbps": (c.delivered.lock().rate_bps / 1000.0) as u64,
                "decodeUs": c.decode_us.load(Ordering::Relaxed),
            })
        })
        .collect();
    let load = |a: &std::sync::atomic::AtomicU64| a.load(Ordering::Relaxed);
    json(
        StatusCode::OK,
        serde_json::json!({
            "captured": load(&st.captured),
            "encoded": load(&st.encoded),
            "bytes": load(&st.bytes),
            "encodeUsTotal": load(&st.encode_us),
            "grabUsTotal": load(&st.grab_us),
            "convertUsTotal": load(&st.convert_us),
            "flowBlocked": load(&st.flow_blocked),
            "paintovers": load(&st.paintovers),
            "keyframes": load(&st.keyframes),
            "refines": load(&st.refines),
            "skipped": load(&st.skipped),
            "lossless": load(&st.lossless),
            "losslessBytes": load(&st.lossless_bytes),
            "fps": hub.fps.load(Ordering::Relaxed),
            "localSteering": hub.local_steering.load(Ordering::Relaxed),
            "damageWaitUsTotal": load(&st.damage_wait_us),
            "sendLatUsTotal": load(&st.send_lat_us),
            "targetKbps": hub.target_kbps.load(Ordering::Relaxed),
            "encoder": *hub.encoder.lock(),
            "viewers": viewers,
        }),
    )
}
