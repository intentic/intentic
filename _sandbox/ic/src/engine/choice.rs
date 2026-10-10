//! WHICH ENGINE A PC'S SANDBOXES GO ON (2026-10-09) — the rules, pure, and the switch that changes them.
#![cfg_attr(not(windows), allow(dead_code))]

/* Three things decide it, in this order. The person's own word: `IC_ENGINE`, then the preference the desktop app
saves (`ic engine prefer`). What the PC already holds: sandboxes that run on Docker Desktop stay there until they are
moved (`ic engine move`), because a setup that switched engines under them would leave them where no `docker` looks;
and a sandbox handed this PC's GPU stays on Docker Desktop, since Intentic's engine cannot pass a GPU through yet. Then
the default for a PC with Docker Desktop, which is the one switch of the migration plan. Flipped to ours on 2026-10-10:
every new setup goes onto Intentic's engine, Docker Desktop installed or not, so a new install has one engine to run and
repair whatever else the PC holds. What it cannot flip is above it: sandboxes already on Docker Desktop (until moved), a
GPU sandbox, and the person's own word.

The same switch decides what Intentic promises a Docker Desktop that stays. Before it flips, Docker Desktop is an engine
Intentic sets up and repairs. After, it is the person's own engine (bring your own Docker): Intentic checks that it
answers and runs Linux containers, says so when it does not, and leaves installing, starting and repairing it to its
owner. Another engine of a person's own (Rancher Desktop) is that from the start. */

use super::Kind;

/// What a PC with Docker Desktop gets by default: our engine, the migration's switch flipped (2026-10-10). New setups
/// there go onto it, the desktop app offers the move to sandboxes already on Docker Desktop, and a Docker Desktop that
/// stays becomes the person's own engine. `Kind::DockerDesktop` here puts it back.
pub const DOCKER_DESKTOP_PCS: Kind = Kind::Intentic;

/// What the choice is made from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// `IC_ENGINE`, read: `docker-desktop` or `intentic`.
    pub forced: Option<Kind>,
    /// What the person said in the app (`ic engine prefer`).
    pub preferred: Option<Kind>,
    pub docker_desktop: bool,
    /// Another engine of the person's own on Windows (Rancher Desktop).
    pub own_engine: bool,
    /// This side of the PC already has sandboxes (its ic keeps records of them), on whatever engine is in use.
    pub sandboxes_here: bool,
    /// One of them was handed the PC's GPU.
    pub gpu: bool,
}

/// The engine a NEW setup on this PC puts its sandboxes on, when none is active yet. `default` is
/// [`DOCKER_DESKTOP_PCS`], passed in so tests can hold the switch either way.
pub fn for_new_setup(facts: &Facts, default: Kind) -> Kind {
    if let Some(forced) = facts.forced {
        return forced;
    }
    if !facts.docker_desktop && !facts.own_engine {
        return Kind::Intentic;
    }
    // Docker Desktop's (or the person's own engine's) sandboxes are not left behind by a setup.
    if facts.sandboxes_here || facts.gpu {
        return Kind::DockerDesktop;
    }
    match facts.preferred {
        Some(kind) => kind,
        None if facts.own_engine && !facts.docker_desktop => Kind::DockerDesktop,
        None => default,
    }
}

/// Whether a Docker Desktop (or another engine of the person's) that this PC's sandboxes run on is theirs to keep
/// running: true once the switch has flipped, and always for an engine Intentic does not install.
pub fn bring_your_own(facts: &Facts, default: Kind, in_use: Kind) -> bool {
    in_use == Kind::DockerDesktop
        && (default == Kind::Intentic || (facts.own_engine && !facts.docker_desktop))
}

/// Whether the desktop app should put the move in front of the person rather than only keep it in reach: the switch
/// has flipped, the sandboxes are still on Docker Desktop, and nothing says they should stay there.
pub fn offer_move(facts: &Facts, default: Kind, in_use: Kind) -> bool {
    default == Kind::Intentic
        && in_use == Kind::DockerDesktop
        && facts.docker_desktop
        && !facts.gpu
        && facts.preferred != Some(Kind::DockerDesktop)
}

/// Whether a move is possible at all from where this PC is: onto our engine from Docker Desktop (not with a GPU
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
    fn a_pc_with_no_engine_of_its_own_gets_ours() {
        for default in [Kind::DockerDesktop, Kind::Intentic] {
            assert_eq!(for_new_setup(&pc(), default), Kind::Intentic);
        }
    }

    #[test]
    fn before_the_switch_docker_desktop_pcs_keep_docker_desktop() {
        let desktop = Facts {
            docker_desktop: true,
            ..pc()
        };
        assert_eq!(
            for_new_setup(&desktop, Kind::DockerDesktop),
            Kind::DockerDesktop
        );
        // …unless the person asked for ours.
        let asked = Facts {
            preferred: Some(Kind::Intentic),
            ..desktop.clone()
        };
        assert_eq!(for_new_setup(&asked, Kind::DockerDesktop), Kind::Intentic);
    }

    #[test]
    fn after_the_switch_a_fresh_docker_desktop_pc_gets_ours_and_one_with_sandboxes_keeps_them_where_they_are(
    ) {
        let desktop = Facts {
            docker_desktop: true,
            ..pc()
        };
        assert_eq!(for_new_setup(&desktop, Kind::Intentic), Kind::Intentic);
        let holding = Facts {
            sandboxes_here: true,
            ..desktop.clone()
        };
        assert_eq!(for_new_setup(&holding, Kind::Intentic), Kind::DockerDesktop);
        let gpu = Facts {
            gpu: true,
            ..desktop.clone()
        };
        assert_eq!(for_new_setup(&gpu, Kind::Intentic), Kind::DockerDesktop);
        let stays = Facts {
            preferred: Some(Kind::DockerDesktop),
            ..desktop
        };
        assert_eq!(for_new_setup(&stays, Kind::Intentic), Kind::DockerDesktop);
    }

    #[test]
    fn the_person_forcing_an_engine_wins_over_everything() {
        let forced = Facts {
            forced: Some(Kind::Intentic),
            docker_desktop: true,
            sandboxes_here: true,
            ..pc()
        };
        assert_eq!(for_new_setup(&forced, Kind::DockerDesktop), Kind::Intentic);
    }

    #[test]
    fn rancher_desktop_is_the_persons_own_engine_from_the_start() {
        let rancher = Facts {
            own_engine: true,
            ..pc()
        };
        assert_eq!(
            for_new_setup(&rancher, Kind::DockerDesktop),
            Kind::DockerDesktop
        );
        assert!(bring_your_own(
            &rancher,
            Kind::DockerDesktop,
            Kind::DockerDesktop
        ));
    }

    #[test]
    fn docker_desktop_becomes_the_persons_own_only_once_the_switch_has_flipped() {
        let desktop = Facts {
            docker_desktop: true,
            ..pc()
        };
        assert!(!bring_your_own(
            &desktop,
            Kind::DockerDesktop,
            Kind::DockerDesktop
        ));
        assert!(bring_your_own(
            &desktop,
            Kind::Intentic,
            Kind::DockerDesktop
        ));
        // A PC on our engine has nothing of Docker Desktop's to promise.
        assert!(!bring_your_own(&desktop, Kind::Intentic, Kind::Intentic));
    }

    #[test]
    fn the_move_is_offered_after_the_switch_and_only_where_it_can_go() {
        let desktop = Facts {
            docker_desktop: true,
            sandboxes_here: true,
            ..pc()
        };
        assert!(!offer_move(
            &desktop,
            Kind::DockerDesktop,
            Kind::DockerDesktop
        ));
        assert!(offer_move(&desktop, Kind::Intentic, Kind::DockerDesktop));
        assert!(!offer_move(&desktop, Kind::Intentic, Kind::Intentic));
        let gpu = Facts {
            gpu: true,
            ..desktop.clone()
        };
        assert!(!offer_move(&gpu, Kind::Intentic, Kind::DockerDesktop));
        let stays = Facts {
            preferred: Some(Kind::DockerDesktop),
            ..desktop.clone()
        };
        assert!(!offer_move(&stays, Kind::Intentic, Kind::DockerDesktop));
        assert!(can_move(&desktop, Kind::DockerDesktop));
        assert!(!can_move(&gpu, Kind::DockerDesktop));
        assert!(can_move(&desktop, Kind::Intentic));
        assert!(!can_move(&pc(), Kind::Intentic));
    }
}
