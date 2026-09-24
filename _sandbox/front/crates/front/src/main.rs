//! intentic-front: the sandbox's network edge and the Node daemon's supervisor. Owns every port and the ingress
//! tunnel, relays what Node answers over a Unix socket, and keeps all of it open across a Node restart.

mod body;
mod cgroup;
mod connect;
mod link;
mod listen;
mod proxy;
mod route;
mod supervise;
mod tls;
mod tunnel;

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Mutex, mpsc, watch};
use tracing_subscriber::EnvFilter;

use crate::link::{Link, Pushed};
use crate::listen::Listeners;
use crate::proxy::Front;
use crate::supervise::NodeCommand;
use crate::tls::CertificateSlot;
use crate::tunnel::Tunnel;

const USAGE: &str = "usage: intentic-front [--run-dir DIR] -- NODE_COMMAND [ARGS...]";

// The daemon reads these to find the front: where to dial the control lane, where to serve HTTP.
const CONTROL_SOCKET_ENV: &str = "INTENTIC_FRONT_SOCKET";
const HTTP_SOCKET_ENV: &str = "INTENTIC_NODE_SOCKET";

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

    let (pushed_sender, mut pushed) = mpsc::unbounded_channel();
    let link: &'static Link = Box::leak(Box::new(Link::new(pushed_sender)));
    let serving = control.clone();
    tokio::spawn(async move {
        if let Err(error) = link.serve(&serving).await {
            tracing::error!(%error, "the control lane stopped");
        }
    });

    let (config_sender, config) = watch::channel(None);
    let front = Arc::new(Front::new(link, http.clone(), config));
    let certificates = Arc::new(CertificateSlot::default());
    let mut listeners = Listeners::new(front.clone(), certificates.clone());
    let tunnel = Arc::new(Mutex::new(Tunnel::new(front, link)));

    let (node_pid, node_pids) = watch::channel(None);
    if std::process::id() == 1 {
        tokio::spawn(supervise::reap_orphans(node_pids.clone()));
    }
    tokio::spawn(cgroup::govern(node_pids));

    let applying = tunnel.clone();
    tokio::spawn(async move {
        while let Some(message) = pushed.recv().await {
            match message {
                Pushed::Listen(listen) => {
                    config_sender.send_replace(Some(Arc::new(listen.clone())));
                    listeners.apply(&listen).await;
                }
                Pushed::Certificate(certificate) => {
                    if let Err(error) = certificates.replace(certificate.as_ref()) {
                        tracing::error!(%error, "the loopback certificate is unusable; keeping the one held");
                    }
                }
                Pushed::Tunnel(wanted) => applying.lock().await.configure(wanted),
                Pushed::Hello => applying.lock().await.report_again(),
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
            (CONTROL_SOCKET_ENV.into(), control.into_os_string()),
            (HTTP_SOCKET_ENV.into(), http.into_os_string()),
        ],
    };
    let code = supervise::supervise(command, node_pid, stopping).await;
    tunnel.lock().await.shut().await;
    code
}
