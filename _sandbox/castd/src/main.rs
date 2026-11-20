//! The castd binary: one process per X display (or per window region of one), serving that picture on a Unix socket.

use castd::config::{Config, USAGE};
use castd::{audio_format, encoder, hub, input, record, screen, server, video};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USAGE}");
        return;
    }
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();
    let cfg = match Config::parse(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("castd: {e}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    #[cfg(feature = "nvenc")]
    if cfg.encoder != encoder::Request::Only(encoder::Backend::X264) {
        castd::nvenc::reexec_with_wsl_libs();
    }
    // A panic in a viewer's task ends that task alone (tokio catches it); in one of the media threads it would leave the
    // window frozen behind a live socket, so castd ends and the daemon starts another.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("");
        if ["capture", "encode", "input", "desktop", "audio"].contains(&name)
            || name.starts_with("enc-")
        {
            castd::exit(1);
        }
    }));
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(run(cfg));
}

async fn run(cfg: Config) {
    let key = match std::fs::read(&cfg.key_file) {
        Ok(k) if !k.is_empty() => k,
        Ok(_) => fail(&format!("--key-file {}: empty", cfg.key_file)),
        Err(e) => fail(&format!("--key-file {}: {e}", cfg.key_file)),
    };
    let hub = hub::Hub::new(cfg.scale, audio_format(cfg.audio_source.is_some()));
    // A drop the daemon asked of the castd before this one still stands: tokens minted before it stay dead.
    hub.not_before
        .store(cfg.not_before, std::sync::atomic::Ordering::Relaxed);
    let screen = if cfg.crop.is_some() {
        None
    } else {
        match screen::Screen::open(cfg.display.as_deref(), cfg.max_size) {
            Ok(s) => Some(s),
            Err(e) => {
                log::warn!("the screen cannot be resized: {e}");
                None
            }
        }
    };
    let vcfg = video::VideoConfig {
        display: cfg.display.clone(),
        crop: cfg.crop,
        fps: cfg.fps,
        preset: cfg.preset.clone(),
        threads: cfg.encoder_threads,
        convert_threads: cfg.convert_threads,
        crf: cfg.crf,
        max_kbps: cfg.max_kbps,
        paintover_crf: cfg.paintover_crf,
        paintover_burst: cfg.paintover_burst,
        paintover_delay_ms: cfg.paintover_delay_ms,
        min_kbps: cfg.min_kbps,
        local_crf: cfg.local_crf,
        local_max_kbps: cfg.local_max_kbps,
        local_fps: cfg.local_fps,
        lossless: cfg.lossless,
        lossless_delay: Duration::from_millis(cfg.lossless_delay_ms),
        stripes: cfg.stripes,
        adaptive_threads: cfg.adaptive_threads,
        coalesce: Duration::from_micros(cfg.coalesce_us),
        encoder: pick_encoder(cfg.encoder),
    };
    if let Err(e) = video::spawn(vcfg, hub.clone(), screen) {
        fail(&format!("video: {e}"));
    }
    let clipboard = match castd::desktop::spawn(cfg.display.clone(), hub.clone()) {
        Ok(h) => Some(h),
        Err(e) => {
            log::error!("cursor and clipboard unavailable: {e}");
            None
        }
    };
    match input::spawn(
        cfg.display.clone(),
        &cfg.session,
        clipboard,
        cfg.scroll_px_per_notch,
        hub.clone(),
    ) {
        Ok(tx) => *hub.input.lock() = Some(tx),
        Err(e) => log::error!("input unavailable: {e}"),
    }
    #[cfg(feature = "audio")]
    if let Some(source) = cfg.audio_source.clone() {
        castd::audio::spawn(source, cfg.audio_bitrate, hub.clone());
    }
    // A peer port that cannot be bound leaves the socket as every viewer's way in, which it always is anyway.
    if let Some(bind) = cfg.rtc_udp {
        match castd::rtc::start(bind, cfg.rtc_candidates.clone()).await {
            Ok(candidates) if castd::rtc::offered() => {
                log::info!("taking peer connections on udp {bind}, reached at {candidates:?}")
            }
            Ok(_) => log::warn!(
                "udp {bind} is bound but no --rtc-candidates say where a viewer reaches it: no peers are offered"
            ),
            Err(e) => log::error!("--rtc-udp {bind}: {e}; viewers stay on the socket"),
        }
    }

    let app = server::App {
        hub: hub.clone(),
        key: Arc::new(key),
        session: Arc::new(cfg.session.clone()),
        recorder: record::Recorder::new(
            hub.clone(),
            Duration::from_secs_f64(cfg.max_record_seconds.clamp(1.0, 3600.0)),
            cfg.record_dir.as_ref().map(std::path::PathBuf::from),
        ),
    };
    let listener = bind(&cfg);
    castd::set_socket_path(&cfg.socket);
    log::info!(
        "castd serving session {} of display {} on {}",
        cfg.session,
        cfg.display.as_deref().unwrap_or("(none)"),
        cfg.socket
    );
    let shutdown_hub = hub.clone();
    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut term), Ok(mut int)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            return;
        };
        tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
        log::info!("shutting down");
        if let Some(tx) = shutdown_hub.input.lock().as_ref() {
            let _ = tx.send(input::InputEvent::Shutdown);
        }
        // The input thread releases held keys and restores the keymap; give it a moment.
        tokio::time::sleep(Duration::from_millis(100)).await;
        castd::exit(0);
    });
    if let Err(e) = axum::serve(listener, server::router(app)).await {
        log::error!("serving: {e}");
        castd::exit(1);
    }
}

/// The encoder `--encoder` asks for, each hardware candidate proven by its self-test first.
fn pick_encoder(request: encoder::Request) -> encoder::Backend {
    let picked = encoder::select(request, encoder::Backend::hardware(), |b| {
        let t = std::time::Instant::now();
        let result = encoder::self_test(b);
        log::info!(
            "{} self-test: {} ({} ms)",
            b.name(),
            result.as_ref().map_or_else(|e| e.as_str(), |()| "passed"),
            t.elapsed().as_millis()
        );
        result
    });
    match picked {
        Ok(s) => {
            for (b, why) in &s.passed_over {
                log::info!("encoder: {} passed over ({why})", b.name());
            }
            log::info!("encoder: {}", s.backend.name());
            s.backend
        }
        Err(e) => fail(&e),
    }
}

fn fail(msg: &str) -> ! {
    log::error!("{msg}");
    castd::exit(1)
}

/// Binds the socket, replacing a stale one a dead castd left, with the permissions `--socket-mode` gives.
fn bind(cfg: &Config) -> tokio::net::UnixListener {
    let path = std::path::Path::new(&cfg.socket);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::os::unix::net::UnixStream::connect(path).is_ok() {
        fail(&format!("{}: another castd is serving it", cfg.socket));
    }
    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path)
        .unwrap_or_else(|e| fail(&format!("bind {}: {e}", cfg.socket)));
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(cfg.socket_mode))
    {
        log::warn!("chmod {}: {e}", cfg.socket);
    }
    listener
}
