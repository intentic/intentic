/* A PROJECT SANDBOX is made for one folder on the owner's computer, synced into `/work/<name>` rather than into /work
itself, which is the daemon's own (its state, its starter repo, the public outbox). The desktop app names the folder
in SYNC_REMOTE_DIR and asks for it with SYNC_PROJECT; this checks both before anything starts, hands the installer
what it needs and tells the container which folder it was made for (SANDBOX_PROJECT_DIR).

A PROJECTS HOST is the other shape: the one sandbox the desktop app keeps on this computer, made with no folder at all
(SYNC_PROJECTS_HOST), which any number of folders attach to later, each as its own `/work/<name>`. Its sync pairing
holds no folder, only the token the attached folders sync under, and the container is told what it is
(SANDBOX_PROJECTS_HOST) so it seeds no starter site and learns its folders from the machine agent's reports.

The name rule is @intentic/sandbox-contract's (`_shared/sandbox-contract/src/ids/project-dir.ts`), the source of
truth; this is its copy for the host side, held to the same cases by `project-dir.fixture.json`. */

/// The sandbox's workspace root (`WORKSPACE_ROOT` in @intentic/constants).
const WORKSPACE_ROOT: &str = "/work";

/// Top-level names the daemon keeps for itself or never sees: `RESERVED_PROJECT_DIR_NAMES` in project-dir.ts.
const RESERVED: [&str; 12] = [
    "public",
    "refs",
    "site",
    "root",
    "intent",
    "desired-state",
    "app",
    "AGENTS.md",
    "node_modules",
    "dist",
    "venv",
    "claude.json",
];

/// One path segment starting with a letter or digit, of letters, digits, `.`, `_` and `-`, at most 64 long, and not
/// a name the daemon keeps: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, spelled without a regex crate this binary lacks.
pub fn is_project_dir_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !RESERVED.contains(&name)
}

/// The name out of a sandbox path that is exactly `/work/<name>`, and nothing for any other path.
pub fn project_dir_name_of(remote_dir: &str) -> Option<&str> {
    remote_dir
        .strip_prefix(WORKSPACE_ROOT)
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|name| is_project_dir_name(name))
}

/// Where the desktop sync of this setup lands in the sandbox, as the installer and the container are told it.
#[derive(Debug, PartialEq, Eq)]
pub struct Placement {
    /// SYNC_REMOTE_DIR for the sync installer, as given; absent means /work.
    pub remote_dir: Option<String>,
    /// SANDBOX_PROJECT_DIR for the container, `/work/<name>`: set exactly when this is a project sandbox.
    pub project_dir: Option<String>,
    /// SANDBOX_PROJECTS_HOST for the container: this computer's own sandbox, which folders attach to later.
    pub projects_host: bool,
}

impl Placement {
    /// What the sync installer is handed on top of its own variables: the folder, and the project flag exactly when
    /// this is a project, which sync.sh/.ps1 pass to `intentic-machine sync setup` as `--remote-dir`/`--project`.
    pub fn installer_vars(&self) -> Vec<(&'static str, &str)> {
        let mut vars = Vec::new();
        // A projects host pairs with no folder: sync.sh/.ps1 pass `--projects-host` and no `--dir`.
        if self.projects_host {
            vars.push(("SYNC_PROJECTS_HOST", "1"));
        }
        if let Some(remote_dir) = &self.remote_dir {
            vars.push(("SYNC_REMOTE_DIR", remote_dir.as_str()));
        }
        if self.project_dir.is_some() {
            vars.push(("SYNC_PROJECT", "1"));
        }
        vars
    }

    /// Whether desktop sync is set up at all: a folder asked for (SYNC_DIR), or the projects host's folderless pairing,
    /// without which no folder can attach to it later.
    pub fn syncs(&self, has_sync_dir: bool) -> bool {
        has_sync_dir || self.projects_host
    }

    /// SANDBOX_PROJECTS_HOST as the container is handed it; empty, and so dropped, on every other sandbox.
    pub fn projects_host_env(&self) -> &'static str {
        if self.projects_host {
            "1"
        } else {
            ""
        }
    }
}

/// SYNC_PROJECTS_HOST, refused before anything starts beside any of the variables that name a folder: this computer's
/// own sandbox holds none of its own, and a folder it was handed now would be synced over /work or made a project
/// sandbox, neither of which is what was asked for.
pub fn projects_host(
    remote_dir: Option<&str>,
    project: bool,
    has_sync_dir: bool,
) -> Result<Placement, String> {
    let named: Vec<&str> = [
        (has_sync_dir, "SYNC_DIR"),
        (remote_dir.is_some(), "SYNC_REMOTE_DIR"),
        (project, "SYNC_PROJECT"),
    ]
    .into_iter()
    .filter_map(|(set, name)| set.then_some(name))
    .collect();
    if let Some((last, rest)) = named.split_last() {
        let unset = if rest.is_empty() {
            last.to_string()
        } else {
            format!("{} and {last}", rest.join(", "))
        };
        return Err(format!("SYNC_PROJECTS_HOST sets up this computer's own sandbox, which holds no folder: folders attach to it later, each as {WORKSPACE_ROOT}/<name>. Unset {unset}, or drop SYNC_PROJECTS_HOST to make a sandbox for that folder instead."));
    }
    Ok(Placement {
        remote_dir: None,
        project_dir: None,
        projects_host: true,
    })
}

/// SYNC_REMOTE_DIR and SYNC_PROJECT, refused before anything starts when they are not a shape the sync agent accepts:
/// /work (the default), or a project folder under it asked for as one, which also needs SYNC_DIR — the folder on this
/// computer it syncs with, which is the whole point of it.
pub fn placement(
    remote_dir: Option<&str>,
    project: bool,
    has_sync_dir: bool,
) -> Result<Placement, String> {
    let Some(remote_dir) = remote_dir else {
        return if project {
            Err(format!("SYNC_PROJECT needs SYNC_REMOTE_DIR={WORKSPACE_ROOT}/<name>, the folder in the sandbox the project syncs into."))
        } else {
            Ok(Placement {
                remote_dir: None,
                project_dir: None,
                projects_host: false,
            })
        };
    };
    if remote_dir == WORKSPACE_ROOT {
        return if project {
            Err(format!("SYNC_PROJECT needs SYNC_REMOTE_DIR={WORKSPACE_ROOT}/<name>: a project syncs into a folder of its own, never into {WORKSPACE_ROOT} itself."))
        } else {
            Ok(Placement {
                remote_dir: Some(remote_dir.to_string()),
                project_dir: None,
                projects_host: false,
            })
        };
    }
    if project_dir_name_of(remote_dir).is_none() {
        return Err(format!("SYNC_REMOTE_DIR={remote_dir} is neither {WORKSPACE_ROOT} nor {WORKSPACE_ROOT}/<name> (a name starting with a letter or digit, of letters, digits, '.', '_' and '-', and not one the sandbox keeps for itself: {}).", RESERVED.join(", ")));
    }
    if !project {
        return Err(format!("SYNC_REMOTE_DIR={remote_dir} is a project folder, so set SYNC_PROJECT=1 as well: it is what keeps the sandbox's state and git history out of your folder."));
    }
    if !has_sync_dir {
        return Err(format!("SYNC_REMOTE_DIR={remote_dir} is a project folder, which needs SYNC_DIR: the folder on this computer it syncs with."));
    }
    Ok(Placement {
        remote_dir: Some(remote_dir.to_string()),
        project_dir: Some(remote_dir.to_string()),
        projects_host: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct NameCase {
        name: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    struct Cases {
        names: Vec<NameCase>,
    }

    #[test]
    fn the_shared_name_cases_validate_as_the_contract_validates_them() {
        let cases: Cases = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/src/ids/project-dir.fixture.json"
        ))
        .unwrap();
        assert!(cases.names.len() > 10);
        for case in cases.names {
            assert_eq!(
                is_project_dir_name(&case.name),
                case.valid,
                "name {:?}",
                case.name
            );
        }
    }

    #[test]
    fn a_project_dir_is_exactly_one_valid_name_under_the_workspace_root() {
        assert_eq!(project_dir_name_of("/work/my-app"), Some("my-app"));
        assert_eq!(project_dir_name_of("/work"), None);
        assert_eq!(project_dir_name_of("/work/"), None);
        assert_eq!(project_dir_name_of("/work/my-app/"), None);
        assert_eq!(project_dir_name_of("/work/my-app/src"), None);
        assert_eq!(project_dir_name_of("/work/../etc"), None);
        assert_eq!(project_dir_name_of("/workshop/my-app"), None);
        assert_eq!(project_dir_name_of("/work/public"), None);
    }

    #[test]
    fn a_project_is_placed_in_its_folder_and_the_container_is_told_which() {
        assert_eq!(
            placement(Some("/work/my-app"), true, true),
            Ok(Placement {
                remote_dir: Some("/work/my-app".to_string()),
                project_dir: Some("/work/my-app".to_string()),
                projects_host: false,
            })
        );
    }

    #[test]
    fn an_ordinary_setup_is_placed_on_the_workspace_and_names_no_project() {
        let workspace = Placement {
            remote_dir: None,
            project_dir: None,
            projects_host: false,
        };
        assert_eq!(placement(None, false, true), Ok(workspace));
        assert_eq!(
            placement(Some("/work"), false, false),
            Ok(Placement {
                remote_dir: Some("/work".to_string()),
                project_dir: None,
                projects_host: false,
            })
        );
    }

    #[test]
    fn the_installer_is_handed_the_folder_and_the_project_flag_only_for_a_project() {
        let project = placement(Some("/work/my-app"), true, true).unwrap();
        assert_eq!(
            project.installer_vars(),
            vec![("SYNC_REMOTE_DIR", "/work/my-app"), ("SYNC_PROJECT", "1")]
        );
        let workspace = placement(Some("/work"), false, true).unwrap();
        assert_eq!(
            workspace.installer_vars(),
            vec![("SYNC_REMOTE_DIR", "/work")]
        );
        assert!(placement(None, false, true)
            .unwrap()
            .installer_vars()
            .is_empty());
    }

    #[test]
    fn every_other_shape_is_refused_before_anything_starts() {
        // A project with nowhere of its own to go would sync the owner's folder with the whole workspace.
        assert!(placement(None, true, true)
            .unwrap_err()
            .contains("SYNC_PROJECT needs SYNC_REMOTE_DIR=/work/<name>"));
        assert!(placement(Some("/work"), true, true)
            .unwrap_err()
            .contains("never into /work itself"));
        // Outside /work, deeper than one level, or a name the daemon serves or seeds.
        for remote in [
            "/etc",
            "/work/a/b",
            "/work/public",
            "/work/.intentic",
            "relative",
        ] {
            assert!(
                placement(Some(remote), true, true)
                    .unwrap_err()
                    .contains("is neither /work nor /work/<name>"),
                "{remote}"
            );
        }
        // Both halves of the ask, and the local folder it is for.
        assert!(placement(Some("/work/my-app"), false, true)
            .unwrap_err()
            .contains("set SYNC_PROJECT=1 as well"));
        assert!(placement(Some("/work/my-app"), true, false)
            .unwrap_err()
            .contains("needs SYNC_DIR"));
    }

    #[test]
    fn a_projects_host_names_no_folder_and_tells_the_installer_and_the_container_what_it_is() {
        let host = projects_host(None, false, false).unwrap();
        assert_eq!(
            host,
            Placement {
                remote_dir: None,
                project_dir: None,
                projects_host: true,
            }
        );
        // The installer pairs with no folder: no SYNC_DIR to hand over, only the flag `--projects-host` comes from.
        assert_eq!(host.installer_vars(), vec![("SYNC_PROJECTS_HOST", "1")]);
        assert_eq!(host.projects_host_env(), "1");
        // Its sync is set up without a folder, since the attached folders sync under the token it enrolls.
        assert!(host.syncs(false));
    }

    #[test]
    fn every_other_sandbox_hands_the_container_no_projects_host_flag() {
        for placed in [
            placement(None, false, true).unwrap(),
            placement(Some("/work"), false, false).unwrap(),
            placement(Some("/work/my-app"), true, true).unwrap(),
        ] {
            assert_eq!(placed.projects_host_env(), "", "{placed:?}");
            assert!(placed
                .installer_vars()
                .iter()
                .all(|(name, _)| *name != "SYNC_PROJECTS_HOST"));
        }
        // An ordinary sandbox still syncs only when a folder was asked for.
        assert!(!placement(None, false, false).unwrap().syncs(false));
        assert!(placement(None, false, false).unwrap().syncs(true));
    }

    #[test]
    fn a_projects_host_beside_any_folder_variable_is_refused_before_anything_starts() {
        // Each one alone, named in the refusal so the reader knows which to unset.
        for (remote, project, has_sync_dir, named) in [
            (None, false, true, "SYNC_DIR"),
            (Some("/work/my-app"), false, false, "SYNC_REMOTE_DIR"),
            (Some("/work"), false, false, "SYNC_REMOTE_DIR"),
            (None, true, false, "SYNC_PROJECT"),
        ] {
            let refusal = projects_host(remote, project, has_sync_dir).unwrap_err();
            assert!(
                refusal.starts_with("SYNC_PROJECTS_HOST sets up this computer's own sandbox"),
                "{refusal}"
            );
            assert!(refusal.contains(&format!("Unset {named},")), "{refusal}");
        }
        // All of them at once: a project sandbox's whole ask, which is the likeliest mix-up.
        assert!(projects_host(Some("/work/my-app"), true, true)
            .unwrap_err()
            .contains("Unset SYNC_DIR, SYNC_REMOTE_DIR and SYNC_PROJECT,"));
    }
}
