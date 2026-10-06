//! intentic-front: the sandbox's network edge and the Node daemon's supervisor. Owns every port and the ingress
//! tunnel, relays what Node answers over a Unix socket, and keeps all of it open across a Node restart.

mod cgroup;
mod connect;
mod feed;
mod link;
mod listen;
mod proxy;
mod quic;
mod route;
mod standing;
mod supervise;
mod term;
mod tls;
mod tunnel;
mod vitals;

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use front_wire::{FRONT_SOCKET_ENV, FrontAnswer, FrontQuestion, INSTANCE_ENV, NODE_SOCKET_ENV};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Mutex, mpsc, watch};
use tracing_subscriber::EnvFilter;

use crate::feed::Feed;
use crate::link::{Link, Pushed};
use crate::listen::Listeners;
use crate::proxy::Front;
use crate::standing::Standing;
use crate::supervise::{NodeCommand, Restarts};
use crate::term::{Hubs, Terminals, Tmux};
use crate::tls::CertificateSlot;
use crate::tunnel::Tunnel;
use crate::vitals::Vitals;

const USAGE: &str = "usage: intentic-front [--run-dir DIR] -- NODE_COMMAND [ARGS...]";

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("FRONT_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .with_target(false)
        .init();
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    let Some(split) = arguments.iter().position(|argument| argument == "--") else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let (options, node) = (&arguments[..split], &arguments[split + 1..]);
    let run_dir = match options {
        [] => PathBuf::from("/run/intentic"),
        [flag, dir] if flag == "--run-dir" => PathBuf::from(dir),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let Some((program, args)) = node.split_first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("front")
        .build()
        .expect("a tokio runtime starts");
    let code = runtime.block_on(run(run_dir, program.clone(), args.to_vec()));
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

async fn run(run_dir: PathBuf, program: OsString, args: Vec<OsString>) -> i32 {
    // Owner-only: the sockets inside carry the loopback certificate and every request unauthenticated.
    if let Err(error) = std::fs::create_dir_all(&run_dir)
        .and_then(|()| std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700)))
    {
        tracing::error!(%error, dir = %run_dir.display(), "could not prepare the run directory");
        return 1;
    }
    let control = run_dir.join("front.sock");
    let http = run_dir.join("node.sock");

    // This front, as its tunnels present it and as its daemon announces it: an instance minted once per process, which
    // lives as long as the container, and the machine the container's environment names.
    let instance = instance_id();
    let identity = ::tunnel::Identity::new(
        instance.clone(),
        &std::env::var("HOST_LABEL").unwrap_or_default(),
        &std::env::var("HOST_PLATFORM").unwrap_or_default(),
        &std::env::var("HOST_ENV").unwrap_or_default(),
    );
    tracing::info!(instance = %identity.instance, host = %identity.host, "this front's instance");

    let (pushed_sender, mut pushed) = mpsc::unbounded_channel();
    let link: &'static Link = Box::leak(Box::new(Link::new(pushed_sender)));
    let serving = control.clone();
    tokio::spawn(async move { link.serve(&serving).await });

    let restarts = Arc::new(Restarts::default());
    let standing = Arc::new(Standing::default());
    let vitals = Arc::new(Vitals::new(link, restarts.clone(), standing.clone()));
    let stuck = vitals.stuck();
    let pinging = vitals.clone();
    tokio::spawn(async move { pinging.keep_pinging().await });
    let greeting = vitals.clone();

    let (config_sender, config) = watch::channel(None);
    let terminals = Terminals::new(Hubs::new(Tmux::default()));
    let front = Arc::new(Front::new(
        link,
        http.clone(),
        config,
        terminals.clone(),
        vitals,
    ));
    let certificates = Arc::new(CertificateSlot::default());
    let mut listeners = Listeners::new(front.clone(), certificates.clone());
    let tunnel = Arc::new(Mutex::new(Tunnel::new(front, link, identity, standing)));

    let (node_pid, node_pids) = watch::channel(None);
    if std::process::id() == 1 {
        tokio::spawn(supervise::reap_orphans(node_pids.clone()));
    }
    let started = node_pids.clone();
    tokio::spawn(async move { greeting.deadline_first_hellos(started).await });
    tokio::spawn(cgroup::govern(node_pids));

    // Unavailable (no inotify) is a feed that knows nothing: every sync answers null and Node reads git itself.
    let feed = match Feed::start(run_dir.join("feed")) {
        Ok(feed) => Some(feed),
        Err(error) => {
            tracing::error!(%error, "the change feed could not start");
            None
        }
    };

    let applying = tunnel.clone();
    tokio::spawn(async move {
        while let Some(message) = pushed.recv().await {
            match message {
                Pushed::Listen(listen) => {
                    config_sender.send_replace(Some(Arc::new(listen.clone())));
                    listeners.apply(&listen).await;
                }
                Pushed::Certificate(certificate) => {
                    if let Err(error) = tls::apply(&certificates, certificate.as_ref()) {
                        tracing::error!(%error, "the loopback certificate is unusable; keeping the one held");
                    }
                }
                Pushed::Tunnel(wanted) => applying.lock().await.configure(wanted),
                Pushed::Hello => {
                    applying.lock().await.report_again();
                    if let Some(feed) = &feed {
                        feed.reset();
                    }
                }
                Pushed::Revoke(member) => terminals.revoke(member.as_deref()),
                Pushed::Watch(checkout) => {
                    if let Some(feed) = feed.clone() {
                        tokio::task::spawn_blocking(move || feed.watch(&checkout));
                    }
                }
                Pushed::Unwatch(dir) => {
                    if let Some(feed) = &feed {
                        feed.unwatch(&dir);
                    }
                }
                Pushed::Asked {
                    id,
                    question: FrontQuestion::Sync { dirs },
                } => {
                    let feed = feed.clone();
                    tokio::spawn(async move {
                        let generations = match feed {
                            Some(feed) => feed.sync(&dirs).await,
                            None => vec![None; dirs.len()],
                        };
                        link.answer(id, Ok(FrontAnswer::Sync { generations }));
                    });
                }
            }
        }
    });

    let (stop, stopping) = watch::channel(false);
    tokio::spawn(async move {
        let (Ok(mut terminate), Ok(mut interrupt)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            return;
        };
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
        tracing::info!("stopping: the daemon first, then the tunnel");
        stop.send_replace(true);
    });

    let command = NodeCommand {
        program,
        args,
        env: vec![
            (FRONT_SOCKET_ENV.into(), control.into_os_string()),
            (NODE_SOCKET_ENV.into(), http.into_os_string()),
            (INSTANCE_ENV.into(), instance.into()),
        ],
    };
    let code = supervise::supervise(command, node_pid, stopping, stuck, &restarts).await;
    tunnel.lock().await.shut().await;
    code
}

// Sixteen hex digits from the kernel's randomness: unique among the copies of one sandbox, which is all it is compared
// against. Should the kernel refuse (it does not), the clock and the pid still tell two processes apart.
fn instance_id() -> String {
    let mut bytes = [0_u8; 8];
    // SAFETY: getrandom writes at most `bytes.len()` bytes into a buffer this function owns.
    let filled = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if usize::try_from(filled).ok() != Some(bytes.len()) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        let mixed = (nanos as u64) ^ (u64::from(std::process::id()) << 40);
        bytes = mixed.to_be_bytes();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
