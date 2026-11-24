//! WHICH ENGINE A PC'S SANDBOXES GO ON — the rules, pure.
#![cfg_attr(not(windows), allow(dead_code))]

/* On a Windows PC it is the intentic engine, always (2026-10-13). Docker Desktop installed or not, sandboxes already on it
or not, the person's "Not now" on the move or not: a setup puts this PC's sandboxes on ours. Sandboxes still on Docker
Desktop are not a reason to stay there: the setup carries them across itself (`ic engine move --to intentic`, the
`engine-move` step of prepare/plan.rs) before the PC switches, so none is left where no `docker` looks. Until 2026-10-13
three things kept a PC on Docker Desktop instead: any sandbox record of ic's (stale ones too), a "Not now" on the move
offer (saved as a preference for Docker Desktop), and Rancher Desktop being installed; each put "Your own Docker" on a
new install's setup card and asked the person to start an engine Intentic no longer uses.

`IC_ENGINE=docker-desktop` is the one way onto Docker Desktop, for a test or CI run that must exercise it.

Until a PC's sandboxes are moved, the Docker Desktop they run on is the person's own engine (bring your own Docker):
Intentic checks that it answers and runs Linux containers, says so when it does not, and leaves installing, starting and
repairing it to its owner. The same holds for Rancher Desktop. */

use super::Kind;

/// What the choice is made from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// `IC_ENGINE`, read: `docker-desktop` or `intentic`.
    pub forced: Option<Kind>,
    /// What the person said in the app (`ic engine prefer`). It only decides whether the move is put in front of them
    /// (`offer_move`); it never keeps a setup on Docker Desktop.
    pub preferred: Option<Kind>,
    pub docker_desktop: bool,
    /// Another engine of the person's own on Windows (Rancher Desktop).
    pub own_engine: bool,
    /// This side of the PC already has sandboxes (its ic keeps records of them), on whatever engine is in use.
    pub sandboxes_here: bool,
    /// One of them was handed the PC's GPU.
    pub gpu: bool,
}

/// The engine a setup on this device puts its sandboxes on: ours, unless `IC_ENGINE` says otherwise.
pub fn for_new_setup(facts: &Facts) -> Kind {
    facts.forced.unwrap_or(Kind::Intentic)
}

/// Whether a setup that chose `chosen` has sandboxes to carry across first: this side keeps sandboxes, and they run on
/// another engine (Docker Desktop, or the person's own). Installing our engine and switching alone would leave them
/// where no `docker` looks, so the switch is the move's, at its end.
pub fn move_first(facts: &Facts, chosen: Kind, in_use: Kind) -> bool {
    chosen == Kind::Intentic && in_use == Kind::DockerDesktop && facts.sandboxes_here
}

/// Whether the Docker this device's sandboxes run on is the person's own to keep running: Docker Desktop (or another
/// engine of theirs) for as long as they are still on it. Intentic installs, starts and repairs only its own engine.
pub fn bring_your_own(in_use: Kind) -> bool {
    in_use == Kind::DockerDesktop
}

/// Whether the desktop app should put the move in front of the person rather than only keep it in reach: the
/// sandboxes are still on Docker Desktop, and nothing says they should stay there for now.
pub fn offer_move(facts: &Facts, in_use: Kind) -> bool {
    in_use == Kind::DockerDesktop
        && facts.docker_desktop
        && !facts.gpu
        && facts.preferred != Some(Kind::DockerDesktop)
}

/// Whether a move is possible at all from where this device is: onto our engine from Docker Desktop (not with a GPU
/// sandbox), or back onto Docker Desktop while it is installed.
pub fn can_move(facts: &Facts, in_use: Kind) -> bool {
    match in_use {
        Kind::DockerDesktop => facts.docker_desktop && !facts.gpu,
        Kind::Intentic => facts.docker_desktop,
        Kind::Native => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pc() -> Facts {
        Facts::default()
    }

    #[test]
    fn every_setup_gets_ours_whatever_the_pc_holds() {
        let holding_everything = Facts {
            preferred: Some(Kind::DockerDesktop),
            docker_desktop: true,
            own_engine: true,
            sandboxes_here: true,
            gpu: true,
            ..pc()
        };
        for facts in [pc(), holding_everything] {
            assert_eq!(for_new_setup(&facts), Kind::Intentic);
        }
    }

    #[test]
    fn only_ic_engine_puts_a_setup_on_docker_desktop() {
        let forced = Facts {
            forced: Some(Kind::DockerDesktop),
            ..pc()
        };
        assert_eq!(for_new_setup(&forced), Kind::DockerDesktop);
    }

    #[test]
    fn sandboxes_on_docker_desktop_are_moved_first_and_never_keep_the_pc_there() {
        let holding = Facts {
            docker_desktop: true,
            sandboxes_here: true,
            ..pc()
        };
        assert_eq!(for_new_setup(&holding), Kind::Intentic);
        assert!(move_first(&holding, Kind::Intentic, Kind::DockerDesktop));
        // Already on ours, a fresh PC, or a setup forced onto Docker Desktop: nothing to carry.
        assert!(!move_first(&holding, Kind::Intentic, Kind::Intentic));
        assert!(!move_first(&pc(), Kind::Intentic, Kind::DockerDesktop));
        assert!(!move_first(
            &holding,
            Kind::DockerDesktop,
            Kind::DockerDesktop
        ));
    }

    #[test]
    fn the_docker_sandboxes_still_run_on_is_the_persons_own() {
        assert!(bring_your_own(Kind::DockerDesktop));
        // A PC on our engine has nothing of Docker Desktop's to promise.
        assert!(!bring_your_own(Kind::Intentic));
        assert!(!bring_your_own(Kind::Native));
    }

    #[test]
    fn the_move_is_offered_only_where_it_can_go() {
        let desktop = Facts {
            docker_desktop: true,
            sandboxes_here: true,
            ..pc()
        };
        assert!(offer_move(&desktop, Kind::DockerDesktop));
        assert!(!offer_move(&desktop, Kind::Intentic));
        let gpu = Facts {
            gpu: true,
            ..desktop.clone()
        };
        assert!(!offer_move(&gpu, Kind::DockerDesktop));
        // "Not now" quiets the offer; it no longer keeps a setup on Docker Desktop (above).
        let not_now = Facts {
            preferred: Some(Kind::DockerDesktop),
            ..desktop.clone()
        };
        assert!(!offer_move(&not_now, Kind::DockerDesktop));
        assert!(can_move(&desktop, Kind::DockerDesktop));
        assert!(!can_move(&gpu, Kind::DockerDesktop));
        assert!(can_move(&desktop, Kind::Intentic));
        assert!(!can_move(&pc(), Kind::Intentic));
    }
}
