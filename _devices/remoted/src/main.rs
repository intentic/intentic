//! The command line: `intentic-remoted run --config <file> [--parent-stdin] [--sandbox-url <url> --device <name>]`,
//! `intentic-remoted version`, and on Windows `service …` and `desktop-helper` (the lock screen and admin prompts
//! service, [`remoted::service`]). The machine agent starts `run` with `--parent-stdin`, so it ends when the agent does.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use remoted::config::{self, Named};
use remoted::daemon::Daemon;
use remoted::status::Status;

const USAGE: &str = "\
intentic-remoted: people's terminals on this computer, served to the sandboxes that turned remote access on.

usage:
  intentic-remoted run --config <file> [--parent-stdin] [--sandbox-url <url> --device <name>]
  intentic-remoted version
  intentic-remoted service status|install|uninstall   (Windows: the lock screen and admin prompts service)

  --config <file>       the uplinks, their secrets and switches (JSON, written 0600 by intentic-machine); read again
                        whenever it changes
  --parent-stdin        end when stdin ends: how the machine agent keeps remoted from outliving it
  --sandbox-url <url>   with --device: serve one uplink to this daemon base, its uplinkToken, mediaKey and allow at the
  --device <name>       file's top level instead of in `uplinks`

Status lines (JSON, one per change) go to stdout; the log goes to stderr (RUST_LOG, default info).
";

// What the person closing remoted waits for its terminals' programs to be told.
const END_PATIENCE: Duration = Duration::from_secs(2);

struct Args {
    config: PathBuf,
    parent_stdin: bool,
    named: Option<Named>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    let mut config = None;
    let mut parent_stdin = false;
    let mut url = None;
    let mut device = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let mut value = |name: &str| {
            rest.next()
                .cloned()
                .ok_or_else(|| format!("{name} takes a value"))
        };
        match arg.as_str() {
            "run" => {}
            "--config" => config = Some(PathBuf::from(value("--config")?)),
            "--parent-stdin" => parent_stdin = true,
            "--sandbox-url" => url = Some(value("--sandbox-url")?),
            "--device" => device = Some(value("--device")?),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let named = match (url, device) {
        (Some(url), Some(device)) => Some(Named { url, device }),
        (None, None) => None,
        _ => return Err("--sandbox-url and --device go together".into()),
    };
    Ok(Args {
        config: config.ok_or("--config is required")?,
        parent_stdin,
        named,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("version" | "--version") => {
            println!("{}", remoted::VERSION);
            return;
        }
        Some("--help" | "-h" | "help") | None => {
            print!("{USAGE}");
            return;
        }
        Some("service") => std::process::exit(remoted::service::main(&args[1..])),
        Some("desktop-helper") => std::process::exit(remoted::service::helper_main()),
        // One hardware encoder's self-test, in a process of its own so a driver that crashes takes only the probe
        // (media/linux/encoders.rs starts it).
        #[cfg(target_os = "linux")]
        Some("encoder-probe") => {
            std::process::exit(remoted::media::linux::encoders::probe_main(&args[1..]))
        }
        _ => {}
    }
    // zbus says every handshake step at info (the desktop portal's connection): kept to warnings unless asked.
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,zbus=warn,tracing=warn"),
    )
    .try_init();
    let args = match parse(&args) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("intentic-remoted: {error}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    let first = match config::read(&args.config, args.named.as_ref()) {
        Ok(first) => first,
        Err(error) => {
            eprintln!("intentic-remoted: {}: {error:#}", args.config.display());
            std::process::exit(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("remoted")
        .build()
        .expect("a runtime starts");
    let code = runtime.block_on(run(args, first));
    // Threads still blocked on a pseudo-terminal or stdin would hold a graceful shutdown: the process just ends.
    std::process::exit(code);
}

async fn run(args: Args, first: config::Config) -> i32 {
    log::info!(
        "intentic-remoted {} serving {} uplink(s)",
        remoted::VERSION,
        first.uplinks.len()
    );
    let status = Arc::new(Status::default());
    let watching = config::watch(args.config.clone(), args.named.clone(), first);
    let daemon = Daemon::new(status.clone(), watching);
    let writer = status.clone();
    tokio::spawn(async move { writer.write_lines(std::io::stdout()).await });
    tokio::spawn(daemon.clone().run());
    let why = ended(args.parent_stdin).await;
    log::info!("stopping: {why}");
    daemon.terminals.end_all(None, "remoted stopped");
    // The screens' input lets go of every key and restores the keymap; a virtual desktop remoted started ends.
    let screens = daemon.screens.clone();
    let _ = tokio::task::spawn_blocking(move || screens.stop_all()).await;
    let deadline = tokio::time::Instant::now() + END_PATIENCE;
    while daemon.terminals.count() > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    status.write_last(std::io::stdout());
    0
}

// Whichever comes first: a signal, or the agent's end of stdin.
async fn ended(parent_stdin: bool) -> &'static str {
    let stdin = async {
        if !parent_stdin {
            return std::future::pending().await;
        }
        use tokio::io::AsyncReadExt;
        let mut stdin = tokio::io::stdin();
        let mut buffer = [0_u8; 256];
        loop {
            match stdin.read(&mut buffer).await {
                Ok(0) | Err(_) => return "the machine agent closed stdin",
                Ok(_) => {}
            }
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        why = stdin => why,
        _ = tokio::signal::ctrl_c() => "interrupted",
        () = terminate => "terminated",
    }
}
