use std::time::{Duration, Instant};

use super::desktop::{self, Applied, Done};
use super::host::DeviceFacts;
use super::model::Repair;
use crate::docker;
use crate::sandbox::lock::{self, Wait};
use crate::sandbox::power::{self, Power};
use crate::sandbox::recreate::{self, Mode, Preflight};

/* APPLYING ONE REPAIR. A sandbox's own repairs go through ic's own verbs, never raw docker: they keep the saved shape,
power the tunnel sidecar with the sandbox, and take the sandbox's lock (ic is the one host authority, README). */

/// How long a started sandbox's daemon gets to answer before the re-check judges it.
const HEALTH_WAIT: Duration = Duration::from_secs(90);

/// `slug` is the sandbox a sandbox repair is for; `patient` whether to wait for another ic run on it (a person does,
/// the machine agent's `--auto` comes back later).
pub fn apply(repair: &Repair, slug: Option<&str>, host: &DeviceFacts, patient: bool) -> Done {
    match repair {
        Repair::StartDesktop => desktop::start(host),
        Repair::RestartDesktop => desktop::restart(host),
        Repair::ShutdownWsl => desktop::shutdown_wsl(host),
        Repair::ReapplyIntegration => desktop::reapply_integration(),
        Repair::LinuxContainers => desktop::linux_containers(host),
        Repair::StartEngine => desktop::start_engine(),
        Repair::AutoStart => desktop::enable_autostart(host),
        Repair::Prerequisite(id) => desktop::prerequisite(host, id),
        Repair::Tidy => crate::sandbox::tidy::run(false, false)
            .map(|()| Applied::Now)
            .map_err(|fail| fail.0),
        Repair::PruneBuilder => {
            let ran =
                docker::capture_bounded(&["builder", "prune", "-f"], Duration::from_secs(600))
                    .map_err(|fail| fail.0)?;
            if ran.timed_out || ran.code != Some(0) {
                return Err(format!(
                    "docker builder prune did not finish: {}",
                    ran.stderr
                ));
            }
            Ok(Applied::Now)
        }
        sandbox => {
            let slug = slug.ok_or("a sandbox repair needs its sandbox")?;
            let wait = if patient { Wait::Block } else { Wait::Skip };
            let Some(_held) = lock::hold(slug, wait).map_err(|fail| fail.0)? else {
                return Err(format!(
                    "another ic run is working on {slug}, so it was left alone."
                ));
            };
            on_sandbox(sandbox, slug)
        }
    }
}

fn on_sandbox(repair: &Repair, slug: &str) -> Done {
    let slug_owned = slug.to_string();
    let done = match repair {
        Repair::Start | Repair::StartHeld => power::run(Power::Start, Some(slug_owned)),
        Repair::Restart => power::run(Power::Restart, Some(slug_owned)),
        Repair::Watch => crate::sandbox::probation::watch_one(slug).map(|report| {
            crate::ui::note(&report.sentence());
        }),
        Repair::Rollback => recreate::run(
            Mode::Rollback { to: None },
            Some(slug_owned),
            Preflight::Run,
        ),
        Repair::RaiseMemory(gib) => recreate::reshape(
            slug_owned,
            crate::shape::Ask {
                memory: Some(format!("{gib}g")),
                ..crate::shape::Ask::default()
            },
            Preflight::Run,
        ),
        other => return Err(format!("{} is not a sandbox's repair.", other.doing())),
    };
    done.map_err(|fail| fail.0)?;
    if matches!(
        repair,
        Repair::Start | Repair::StartHeld | Repair::Restart | Repair::Watch
    ) {
        wait_answering(slug);
    }
    Ok(Applied::Now)
}

/// Until the daemon answers /health, it stops for good, or the wait runs out: whichever it is, the re-check says so.
fn wait_answering(slug: &str) {
    let container = crate::sandbox::container_of(slug);
    let started = Instant::now();
    while started.elapsed() < HEALTH_WAIT {
        if docker::ask(
            &[
                "exec",
                &container,
                "curl",
                "-sf",
                "-m",
                "5",
                "http://localhost:8787/health",
            ],
            Duration::from_secs(15),
        )
        .said()
        .is_some()
        {
            return;
        }
        let running = docker::ask(
            &["inspect", "--format", "{{.State.Running}}", &container],
            docker::READ_LIMIT,
        )
        .said()
        .is_some_and(|running| running.trim() == "true");
        if !running {
            return;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}
