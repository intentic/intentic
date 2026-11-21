//! `intentic-remoted desktop-helper`: the process the service starts as SYSTEM in the console session. It reads its
//! configuration from stdin (and ends when stdin does), listens on `\\.\pipe\intentic-remoted-desktop-<session>` for
//! the person's remoted, and serves each connection with cast-win's helper.

use super::launch::HelperConfig;
use super::pipe_name;
use cast_win::helper::pipe::{self, Pipe};
use cast_win::helper::serve::{self, Options};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

pub fn main() -> i32 {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return 2;
    }
    let config: HelperConfig = match serde_json::from_str(&line) {
        Ok(c) => c,
        Err(e) => {
            log::error!("the service's configuration does not parse: {e}");
            return 2;
        }
    };
    // The service holds stdin: when it goes, so does the helper.
    std::thread::spawn(|| {
        let mut rest = String::new();
        while std::io::stdin()
            .lock()
            .read_line(&mut rest)
            .is_ok_and(|n| n > 0)
        {
            rest.clear();
        }
        std::process::exit(0);
    });
    cast_win::init_process();
    let session = pipe::process_session(std::process::id()).unwrap_or(0);
    let out = Arc::new(parking_lot::Mutex::new(std::io::stdout()));
    let say = {
        let out = out.clone();
        move |message: serde_json::Value| {
            let mut out = out.lock();
            let _ = writeln!(out, "{message}");
            let _ = out.flush();
        }
    };
    // Which desktop takes input, for the service's state (and so `service status` and remoted's `/info`).
    {
        let say = say.clone();
        std::thread::spawn(move || {
            let mut last: Option<Option<String>> = None;
            loop {
                let now = cast_win::input_desktop_name();
                if last.as_ref() != Some(&now) {
                    say(serde_json::json!({ "desktop": now }));
                    last = Some(now);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
    }
    let watched = Arc::new(AtomicUsize::new(0));
    cast_win::helper::notice::spawn(watched.clone());
    let options = Arc::new(Options {
        secret: config.secret.clone(),
        version: config.version.clone(),
        sas: {
            let say = say.clone();
            Arc::new(move || say(serde_json::json!({ "sas": true })))
        },
        watched,
        uninstall: {
            let say = say.clone();
            Arc::new(move || say(serde_json::json!({ "uninstall": true })))
        },
    });
    let name = pipe_name(session);
    // SYSTEM, and the user the service was installed for; nobody else may even open it.
    let sddl = format!("D:P(A;;GA;;;SY)(A;;GRGW;;;{})", config.user_sid);
    log::info!("helper in session {session} listening on {name}");
    let mut first = true;
    loop {
        let server = match Pipe::create(&name, &sddl, first) {
            Ok(p) => p,
            Err(e) => {
                log::error!("{e}");
                if first {
                    // Someone else holds the name: never serve under it.
                    return 1;
                }
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
        };
        first = false;
        if let Err(e) = server.accept() {
            log::warn!("{name}: {e}");
            continue;
        }
        let Some(peer) = server.peer_pid() else {
            continue;
        };
        if let Err(why) = check(peer, session, &config.clients) {
            log::warn!("refused process {peer}: {why}");
            continue;
        }
        log::info!("process {peer} connected");
        let options = options.clone();
        std::thread::spawn(move || {
            if let Err(e) = serve::serve(Arc::new(server), peer, &options) {
                log::warn!("process {peer}: {e}");
            }
        });
    }
}

/// A client is the person's remoted: in this session, running from a path the service was installed for.
fn check(peer: u32, session: u32, clients: &[std::path::PathBuf]) -> Result<(), String> {
    let theirs = pipe::process_session(peer).ok_or("its session is unknown")?;
    if theirs != session {
        return Err(format!("it is in session {theirs}, not {session}"));
    }
    let image = pipe::process_image(peer).ok_or("its image is unknown")?;
    if !clients.iter().any(|c| pipe::same_path(&image, c)) {
        return Err(format!(
            "it runs {}, which the service was not installed for",
            image.display()
        ));
    }
    Ok(())
}
