//! intentic-netd: the sandbox's network daemon and the Node daemon's supervisor. Owns every port and the ingress
//! tunnel, relays what Node answers over a Unix socket, and keeps all of it open across a Node restart.

mod cgroup;
mod connect;
mod feed;
mod link;
mod listen;
mod proxy;
mod quic;
mod remember;
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

use netd_wire::{INSTANCE_ENV, NETD_SOCKET_ENV, NODE_SOCKET_ENV, NetdAnswer, NetdQuestion};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Mutex, mpsc, watch};
use tracing_subscriber::EnvFilter;

use crate::feed::Feed;
use crate::link::{Link, Pushed};
use crate::listen::Listeners;
use crate::proxy::Netd;
use crate::standing::Standing;
use crate::supervise::{NodeCommand, Restarts};
use crate::term::{Hubs, Terminals, Tmux};
use crate::tls::CertificateSlot;
use crate::tunnel::Tunnel;
use crate::vitals::Vitals;

const USAGE: &str = "usage: intentic-netd [--run-dir DIR] -- NODE_COMMAND [ARGS...]";

// netd's run directory unless `--run-dir` names another: its sockets, the config it remembers, its vitals file.
const RUN_DIR: &str = "/run/intentic";

// The vitals file's name in the run directory, which is browser-wire's VITALS_FILE under the default one.
const VITALS_FILE_NAME: &str = "vitals.json";

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("NETD_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
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
        [] => PathBuf::from(RUN_DIR),
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
        .thread_name("netd")
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
    // An earlier netd's vitals say nothing of this one's daemon, and a host reading them as this one's could take a crash
    // loop that ended with the last start for the current one: gone before anything else, rewritten once Vitals runs.
    let _ = std::fs::remove_file(run_dir.join(VITALS_FILE_NAME));
    let control = run_dir.join("netd.sock");
    let http = run_dir.join("node.sock");

    // This netd, as its tunnels present it and as its daemon announces it: an instance minted once per process, which
    // lives as long as the container, and the machine the container's environment names.
    let instance = instance_id();
    let identity = ::tunnel::Identity::new(
        instance.clone(),
        &std::env::var("HOST_LABEL").unwrap_or_default(),
        &std::env::var("HOST_PLATFORM").unwrap_or_default(),
        &std::env::var("HOST_ENV").unwrap_or_default(),
    );
    tracing::info!(instance = %identity.instance, host = %identity.host, "this netd's instance");

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
    let recording = vitals.clone();
    let vitals_file = run_dir.join(VITALS_FILE_NAME);
    tokio::spawn(async move { recording.keep_written(&vitals_file).await });

    let (config_sender, config) = watch::channel(None);
    let terminals = Terminals::new(Hubs::new(Tmux::default()));
    let netd = Arc::new(Netd::new(
        link,
        http.clone(),
        config,
        terminals.clone(),
        vitals,
    ));
    let certificates = Arc::new(CertificateSlot::default());
    let mut listeners = Listeners::new(netd.clone(), certificates.clone());
    let tunnel = Arc::new(Mutex::new(Tunnel::new(netd, link, identity, standing)));

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

    // What the last Node said, applied before this one says anything (remember.rs): a Node that never gets that far
    // still leaves a sandbox that answers, with its vitals and netd's own "restarting".
    let mut memory = remember::Memory::open(&run_dir);
    let last = memory.held().clone();
    if last != remember::Remembered::default() {
        tracing::info!("serving as the daemon last configured it, until it says otherwise");
    }
    if let Some(certificate) = last.certificate.as_ref()
        && let Err(error) = tls::apply(&certificates, Some(certificate))
    {
        tracing::warn!(%error, "the remembered loopback certificate is unusable");
    }
    if let Some(listen) = last.listen {
        config_sender.send_replace(Some(Arc::new(listen.clone())));
        listeners.apply(&listen).await;
    }
    if last.tunnel.is_some() {
        tunnel.lock().await.configure(last.tunnel);
    }

    let applying = tunnel.clone();
    tokio::spawn(async move {
        while let Some(message) = pushed.recv().await {
            match message {
                Pushed::Listen(listen) => {
                    memory.listen(&listen);
                    config_sender.send_replace(Some(Arc::new(listen.clone())));
                    listeners.apply(&listen).await;
                }
                Pushed::Certificate(certificate) => {
                    memory.certificate(certificate.as_ref());
                    if let Err(error) = tls::apply(&certificates, certificate.as_ref()) {
                        tracing::error!(%error, "the loopback certificate is unusable; keeping the one held");
                    }
                }
                Pushed::Tunnel(wanted) => {
                    memory.tunnel(wanted.as_ref());
                    applying.lock().await.configure(wanted);
                }
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
                    question: NetdQuestion::Sync { dirs },
                } => {
                    let feed = feed.clone();
                    tokio::spawn(async move {
                        let generations = match feed {
                            Some(feed) => feed.sync(&dirs).await,
                            None => vec![None; dirs.len()],
                        };
                        link.answer(id, Ok(NetdAnswer::Sync { generations }));
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
            (NETD_SOCKET_ENV.into(), control.into_os_string()),
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

#[cfg(test)]
mod tests {
    use super::*;

    // Hosts read the file where browser-wire says netd writes it, which is only true of the default run directory.
    #[test]
    fn the_vitals_file_is_where_browser_wire_says_it_is() {
        assert_eq!(
            std::path::Path::new(RUN_DIR).join(VITALS_FILE_NAME),
            std::path::Path::new(browser_wire::VITALS_FILE)
        );
    }
}
