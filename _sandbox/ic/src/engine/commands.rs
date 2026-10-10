use super::{fetch, record, Kind, Status};
use super::{fetch::FetchOutcome, pins};
use crate::util::{Fail, Result};

pub fn run_fetch() -> Result<()> {
    let total = pins::prefetch_total_bytes();
    if super::in_use() != Kind::Intentic && chosen() != Kind::Intentic {
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

/// What `ic engine status --json` prints, pure over what was read, so the desktop app and Repair read stable names.
/// `engine` is the engine sandboxes run on now; `chosen`, the one a fresh setup here would pick. `canMove` keeps the
/// move in reach; `offerMove` puts it in front of the person (choice.rs).
pub fn status_json(
    in_use: Kind,
    facts: &super::choice::Facts,
    default: Kind,
    status: &Status,
) -> serde_json::Value {
    use super::choice;
    serde_json::json!({
        "engine": in_use.id(),
        "chosen": choice::for_new_setup(facts, default).id(),
        "installed": status.installed,
        "running": status.running,
        "version": status.version,
        "active": status.active,
        "held": status.held,
        "distro": status.distro,
        "network": status.network,
        "pipe": status.pipe,
        "dockerDesktop": facts.docker_desktop,
        "ownEngine": facts.own_engine,
        "preferred": facts.preferred.map(Kind::id),
        "gpu": facts.gpu,
        "bringYourOwn": choice::bring_your_own(facts, default, in_use),
        "canMove": choice::can_move(facts, in_use),
        "offerMove": choice::offer_move(facts, default, in_use),
        "moves": super::moves::summary(),
    })
}

pub fn run_status(json: bool) -> Result<()> {
    let kind = super::in_use();
    let status = super::status();
    if json {
        let mut facts = super::choice_facts(docker_desktop_installed());
        facts.gpu = gpu_in_use();
        println!(
            "{}",
            status_json(kind, &facts, super::choice::DOCKER_DESKTOP_PCS, &status)
        );
        return Ok(());
    }
    print_human_status(kind, &status);
    Ok(())
}

pub fn run_install() -> Result<()> {
    // A fresh PC's engine is the one its sandboxes run on. On a PC with Docker Desktop, installing makes it ready and
    // switches nothing: Docker Desktop's sandboxes would otherwise vanish from every `docker` this account runs.
    let activate = chosen() == Kind::Intentic;
    // A line per step and per percent, not per downloaded chunk.
    let mut last: Option<(String, Option<u64>)> = None;
    super::install(
        &mut |sentence, percent| {
            let now = (sentence.to_string(), percent);
            if last.as_ref() == Some(&now) {
                return;
            }
            last = Some(now);
            if let Some(pct) = percent {
                println!("{sentence} ({pct}%)");
            } else {
                println!("{sentence}");
            }
        },
        activate,
    )
    .map_err(Fail::from)?;
    if super::in_use() != Kind::Intentic {
        println!(
            "Intentic's engine is installed and running beside Docker Desktop. Your sandboxes stay on Docker Desktop until you move them: ic engine move --to intentic"
        );
    }
    Ok(())
}

pub fn run_start(quiet: bool) -> Result<()> {
    if quiet {
        super::start_quiet().map_err(Fail::from)
    } else {
        super::start().map_err(Fail::from)
    }
}

pub fn run_relay() -> Result<()> {
    super::relay().map_err(Fail::from)
}

pub fn run_stop() -> Result<()> {
    super::stop().map_err(Fail::from)?;
    println!("Intentic's engine is stopped and stays stopped until `ic engine start`.");
    Ok(())
}

pub fn run_hold() -> Result<()> {
    super::hold().map_err(Fail::from)
}

pub fn run_restart() -> Result<()> {
    super::restart().map_err(Fail::from)
}

pub fn run_update() -> Result<()> {
    super::update().map_err(Fail::from)
}

pub fn run_remove(yes: bool) -> Result<()> {
    super::remove(yes).map_err(Fail::from)
}

/// The engine a fresh setup here would pick.
pub fn chosen() -> Kind {
    super::choose(docker_desktop_installed())
}

/// `ic engine prefer <intentic|docker-desktop>`: the person's word, saved for every later choice (choice.rs). Moving
/// nothing: `ic engine move` is what carries sandboxes across.
pub fn run_prefer(engine: &str) -> Result<()> {
    let Some(kind) = Kind::parse(engine).filter(|kind| *kind != Kind::Native) else {
        return Err(Fail(format!(
            "prefer `intentic` or `docker-desktop`, not '{engine}'."
        )));
    };
    super::set_preferred(kind).map_err(Fail::from)?;
    println!("intentic: noted — {} from now on.", kind.name());
    Ok(())
}

/// One of the sandboxes on the engine in use was handed this PC's GPU, which keeps the PC on Docker Desktop.
pub fn gpu_in_use() -> bool {
    let Ok(listed) = crate::docker::capture_bounded(
        &[
            "ps",
            "-a",
            "--format",
            "{{.Names}}",
            "--filter",
            &format!("name=^{}", crate::sandbox::CONTAINER_PREFIX),
        ],
        crate::docker::READ_LIMIT,
    ) else {
        return false;
    };
    listed
        .stdout
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.ends_with(crate::sandbox::MOVED_SUFFIX))
        .any(|name| {
            crate::docker::inspect(
                name,
                "{{json .HostConfig.DeviceRequests}} {{range .Config.Env}}{{.}} {{end}}",
            )
            .is_some_and(|said| said.contains("\"gpu\"") || said.contains("--gpus"))
        })
}

pub fn docker_desktop_installed() -> bool {
    #[cfg(windows)]
    {
        use intentic_docker_host::desktop_app;
        desktop_app::default_installs_here()
            .into_iter()
            .any(|path| std::path::Path::new(&path).exists())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn print_human_status(kind: Kind, status: &Status) {
    println!("Engine: {}", kind.id());
    if kind == Kind::Intentic || status.installed {
        println!("Installed: {}", if status.installed { "yes" } else { "no" });
        println!("Running: {}", if status.running { "yes" } else { "no" });
        println!(
            "Sandboxes run on it: {}",
            if status.active { "yes" } else { "no" }
        );
        if status.held {
            println!("Held: yes (stopped on purpose; `ic engine start` brings it back)");
        }
        if let Some(version) = &status.version {
            println!("Version: {version}");
        }
        println!("Distro: {}", status.distro);
        if let Some(network) = &status.network {
            println!(
                "Network: {}",
                if network == "isolated" {
                    "its own (a network namespace of the engine's, as Docker Desktop's engine has)"
                } else {
                    "WSL's shared one (the fallback: see /var/log/intentic-engine.log in its distro)"
                }
            );
        }
        if let Some(record) = record::EngineRecord::load() {
            println!("Endpoint: {}", record.host);
        }
        if let Some(pipe) = &status.pipe {
            println!("Named pipe: {pipe} (what docker uses while it is there)");
        }
    }
    if kind == Kind::DockerDesktop {
        println!("Sandboxes on this PC run on Docker Desktop.");
    } else if kind == Kind::Native {
        println!("Using this system's own Docker installation.");
    }
}

pub fn default_action() -> Result<()> {
    run_status(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_json_names_what_the_app_and_repair_read() {
        let status = Status {
            installed: true,
            running: true,
            version: Some("1.0.0".into()),
            active: false,
            held: false,
            distro: "intentic-engine".into(),
            network: Some("isolated".into()),
            pipe: Some("npipe:////./pipe/intentic-engine.me".into()),
        };
        let facts = super::super::choice::Facts {
            docker_desktop: true,
            sandboxes_here: true,
            ..Default::default()
        };
        let json = status_json(Kind::DockerDesktop, &facts, Kind::DockerDesktop, &status);
        assert_eq!(json["engine"], "dockerDesktop");
        assert_eq!(json["chosen"], "dockerDesktop");
        assert_eq!(json["installed"], true);
        assert_eq!(json["active"], false);
        assert_eq!(json["dockerDesktop"], true);
        assert_eq!(json["distro"], "intentic-engine");
        assert_eq!(json["network"], "isolated");
        assert_eq!(json["pipe"], "npipe:////./pipe/intentic-engine.me");
        assert_eq!(json["canMove"], true);
        assert_eq!(json["offerMove"], false);
        assert_eq!(json["bringYourOwn"], false);
        assert!(json.get("held").is_some());
        // The switch flipped: the move is offered, and Docker Desktop is the person's own to keep running.
        let flipped = status_json(Kind::DockerDesktop, &facts, Kind::Intentic, &status);
        assert_eq!(flipped["offerMove"], true);
        assert_eq!(flipped["bringYourOwn"], true);
    }
}
