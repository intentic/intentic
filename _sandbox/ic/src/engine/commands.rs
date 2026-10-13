use super::{fetch, record, Kind, Status};
use super::{fetch::FetchOutcome, pins};
use crate::ui;
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
    status: &Status,
) -> serde_json::Value {
    use super::choice;
    serde_json::json!({
        "engine": in_use.id(),
        "chosen": choice::for_new_setup(facts).id(),
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
        "bringYourOwn": choice::bring_your_own(in_use),
        "canMove": choice::can_move(facts, in_use),
        "offerMove": choice::offer_move(facts, in_use),
        "moves": super::moves::summary(),
    })
}

pub fn run_status(json: bool) -> Result<()> {
    let kind = super::in_use();
    let status = super::status();
    if json {
        let mut facts = super::choice_facts(docker_desktop_installed());
        facts.gpu = gpu_in_use();
        // allow(terminal-output): --json: one document on stdout for the desktop app and the smoke tests.
        println!("{}", status_json(kind, &facts, &status));
        return Ok(());
    }
    print_human_status(kind, &status);
    Ok(())
}

pub fn run_install() -> Result<()> {
    // A device's engine is the one its sandboxes run on. On a device whose sandboxes are still on Docker Desktop,
    // installing makes it ready and switches nothing: they would otherwise vanish from every `docker` this account runs,
    // so the switch is the move's (`ic engine move --to intentic`), at its end.
    let activate = chosen() == Kind::Intentic && !super::move_first();
    ui::act("Installing the intentic engine");
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
                ui::detail(&format!("{sentence} ({pct}%)"));
            } else {
                ui::detail(sentence);
            }
        },
        activate,
    )
    .map_err(Fail::from)?;
    ui::done("The intentic engine is installed.");
    if super::in_use() != Kind::Intentic {
        ui::note(
            "The intentic engine is installed and running beside Docker Desktop. Your sandboxes stay on Docker Desktop until you move them.",
        );
        ui::later(&[(
            "move sandboxes".to_string(),
            "ic engine move --to intentic".to_string(),
        )]);
    }
    Ok(())
}

pub fn run_start(quiet: bool) -> Result<()> {
    if !quiet {
        ui::act("Starting the intentic engine");
    }
    let res = if quiet {
        super::start_quiet().map_err(Fail::from)
    } else {
        super::start().map_err(Fail::from)
    };
    if !quiet && res.is_ok() {
        ui::done("The intentic engine is running.");
    }
    res
}

pub fn run_wsl(action: Option<String>, distro: Option<String>) -> Result<()> {
    super::wsl(action.as_deref(), distro.as_deref()).map_err(Fail::from)
}

pub fn run_copy(args: super::moves::CopyArgs) -> Result<()> {
    super::moves::copy(args)
}

pub fn run_relay() -> Result<()> {
    super::relay().map_err(Fail::from)
}

pub fn run_stop() -> Result<()> {
    ui::act("Stopping the intentic engine");
    super::stop().map_err(Fail::from)?;
    ui::done("The intentic engine is stopped.");
    ui::later(&[("start it".to_string(), "ic engine start".to_string())]);
    Ok(())
}

pub fn run_hold() -> Result<()> {
    ui::act("Holding the intentic engine down");
    super::hold().map_err(Fail::from)?;
    ui::done("The intentic engine is stopped and held down on purpose.");
    ui::later(&[("start it".to_string(), "ic engine start".to_string())]);
    Ok(())
}

pub fn run_restart() -> Result<()> {
    ui::act("Restarting the intentic engine");
    super::restart().map_err(Fail::from)?;
    ui::done("The intentic engine is restarted.");
    Ok(())
}

pub fn run_update() -> Result<()> {
    ui::act("Updating the intentic engine");
    super::update().map_err(Fail::from)?;
    ui::done("The intentic engine is updated.");
    Ok(())
}

pub fn run_remove(yes: bool) -> Result<()> {
    // Asked before the live line starts: a spinner repainting over a question garbles the one line being read.
    if !ui::confirm(
        "Remove the intentic engine?",
        "Every sandbox's Docker data in its distro is deleted. This cannot be undone.",
        yes,
    )? {
        ui::cancelled();
        return Ok(());
    }
    ui::act("Removing the intentic engine");
    super::remove(true).map_err(Fail::from)?;
    ui::done("The intentic engine is removed.");
    Ok(())
}

/// The engine a setup here picks.
pub fn chosen() -> Kind {
    super::choose(docker_desktop_installed())
}

/// `ic engine prefer <intentic|docker-desktop>`: the person's word on the move, saved (choice.rs). `docker-desktop` is
/// the desktop app's "Not now": the move stops being put in front of them. `intentic` puts it back. It moves nothing and
/// chooses no engine: a setup always puts this PC's sandboxes on ours, and `ic engine move` is what carries them across.
pub fn run_prefer(engine: &str) -> Result<()> {
    let Some(kind) = Kind::parse(engine).filter(|kind| *kind != Kind::Native) else {
        return Err(Fail(format!(
            "prefer `intentic` or `docker-desktop`, not '{engine}'."
        )));
    };
    ui::act("Saving your word on the move to the intentic engine");
    super::set_preferred(kind).map_err(Fail::from)?;
    if kind == Kind::DockerDesktop {
        ui::done("The move to the intentic engine is no longer offered here. Sandboxes on Docker Desktop stay there until they are moved.");
        ui::later(&[(
            "move sandboxes".to_string(),
            "ic engine move --to intentic".to_string(),
        )]);
    } else {
        ui::done("The move to the intentic engine is offered again while sandboxes here run on Docker Desktop.");
    }
    Ok(())
}

/// One of the sandboxes on the engine in use was handed this device's GPU, which keeps the PC on Docker Desktop.
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
    ui::report("intentic · engine status", None);
    let mut fields = Vec::new();
    fields.push(("Engine".to_string(), kind.id().to_string()));
    if kind == Kind::Intentic || status.installed {
        fields.push((
            "Installed".to_string(),
            if status.installed {
                "yes".to_string()
            } else {
                "no".to_string()
            },
        ));
        fields.push((
            "Running".to_string(),
            if status.running {
                "yes".to_string()
            } else {
                "no".to_string()
            },
        ));
        fields.push((
            "Sandboxes run on it".to_string(),
            if status.active {
                "yes".to_string()
            } else {
                "no".to_string()
            },
        ));
        if status.held {
            fields.push(("Held".to_string(), "yes (stopped on purpose)".to_string()));
        }
        if let Some(version) = &status.version {
            fields.push(("Version".to_string(), version.clone()));
        }
        fields.push(("Distro".to_string(), status.distro.clone()));
        if let Some(network) = &status.network {
            fields.push((
                "Network".to_string(),
                if network == "isolated" {
                    "its own (a network namespace of the engine's, as Docker Desktop's engine has)".to_string()
                } else {
                    "WSL's shared one (the fallback: see /var/log/intentic-engine.log in its distro)".to_string()
                },
            ));
        }
        if let Some(record) = record::EngineRecord::load() {
            fields.push(("Endpoint".to_string(), record.host));
        }
        if let Some(pipe) = &status.pipe {
            fields.push((
                "Named pipe".to_string(),
                format!("{pipe} (what docker uses while it is there)"),
            ));
        }
    }
    if kind == Kind::DockerDesktop {
        fields.push((
            "Note".to_string(),
            "Sandboxes on this device run on Docker Desktop.".to_string(),
        ));
    } else if kind == Kind::Native {
        fields.push((
            "Note".to_string(),
            "Using this system's own Docker installation.".to_string(),
        ));
    }
    ui::fields(&fields);
    if status.held {
        ui::later(&[("start it".to_string(), "ic engine start".to_string())]);
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
        let json = status_json(Kind::DockerDesktop, &facts, &status);
        assert_eq!(json["engine"], "dockerDesktop");
        // Sandboxes on Docker Desktop never keep a setup there: it chooses ours, and carries them across.
        assert_eq!(json["chosen"], "intentic");
        assert_eq!(json["installed"], true);
        assert_eq!(json["active"], false);
        assert_eq!(json["dockerDesktop"], true);
        assert_eq!(json["distro"], "intentic-engine");
        assert_eq!(json["network"], "isolated");
        assert_eq!(json["pipe"], "npipe:////./pipe/intentic-engine.me");
        assert_eq!(json["canMove"], true);
        // The move is offered, and Docker Desktop is the person's own to keep running until it happens.
        assert_eq!(json["offerMove"], true);
        assert_eq!(json["bringYourOwn"], true);
        assert!(json.get("held").is_some());
        let on_ours = status_json(Kind::Intentic, &facts, &status);
        assert_eq!(on_ours["offerMove"], false);
        assert_eq!(on_ours["bringYourOwn"], false);
    }
}
