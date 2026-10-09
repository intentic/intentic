use super::{fetch, record, Kind, Status};
use super::{fetch::FetchOutcome, pins};
use crate::util::{Fail, Result};

pub fn run_fetch() -> Result<()> {
    let total = pins::prefetch_total_bytes();
    if active_kind() != Kind::Intentic {
        fetch::say_prefetch("ready", 0, 0);
        return Ok(());
    }
    if super::prefetch_already_done() {
        fetch::say_prefetch("ready", 0, 0);
        return Ok(());
    }
    let mut last_done = 0u64;
    let outcome = fetch::fetch_all(&mut |done, part_total| {
        last_done = done;
        let whole = total.max(part_total);
        fetch::say_prefetch("fetching", done, whole);
    })
    .map_err(Fail::from)?;
    match outcome {
        FetchOutcome::HeldByAnother => fetch::say_prefetch("elsewhere", 0, 0),
        FetchOutcome::Complete => fetch::say_prefetch("ready", last_done.max(total), total),
    }
    Ok(())
}

pub fn run_status(json: bool) -> Result<()> {
    let kind = active_kind();
    let status = super::status();
    if json {
        let line = serde_json::json!({
            "engine": kind.id(),
            "installed": status.installed,
            "running": status.running,
            "version": status.version,
        });
        println!("{line}");
        return Ok(());
    }
    print_human_status(kind, &status);
    Ok(())
}

pub fn run_install() -> Result<()> {
    super::install(&mut |sentence, percent| {
        if let Some(pct) = percent {
            println!("{sentence} ({pct}%)");
        } else {
            println!("{sentence}");
        }
    })
    .map_err(Fail::from)
}

pub fn run_start(quiet: bool) -> Result<()> {
    if quiet {
        super::start_quiet().map_err(Fail::from)
    } else {
        super::start().map_err(Fail::from)
    }
}

pub fn run_stop() -> Result<()> {
    super::stop().map_err(Fail::from)
}

pub fn run_hold() -> Result<()> {
    super::hold().map_err(Fail::from)
}

pub fn run_update() -> Result<()> {
    super::update().map_err(Fail::from)
}

pub fn run_remove(yes: bool) -> Result<()> {
    super::remove(yes).map_err(Fail::from)
}

fn active_kind() -> Kind {
    #[cfg(windows)]
    {
        use intentic_docker_host::desktop_app;
        let desktop = desktop_app::default_installs_here()
            .into_iter()
            .any(|path| std::path::Path::new(&path).exists());
        super::choose(desktop)
    }
    #[cfg(not(windows))]
    {
        super::choose(false)
    }
}

fn print_human_status(kind: Kind, status: &Status) {
    println!("Engine: {}", kind.id());
    if kind == Kind::Intentic {
        println!("Installed: {}", if status.installed { "yes" } else { "no" });
        println!("Running: {}", if status.running { "yes" } else { "no" });
        if let Some(version) = &status.version {
            println!("Version: {version}");
        }
        if let Some(record) = record::EngineRecord::load() {
            println!("Endpoint: {}", record.host);
        }
    } else if kind == Kind::DockerDesktop {
        println!("Using Docker Desktop on this PC.");
    } else {
        println!("Using this system's own Docker installation.");
    }
}

pub fn default_action() -> Result<()> {
    run_status(false)
}
