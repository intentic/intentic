/* A PROJECT SANDBOX is made for one folder on the owner's computer, synced into `/work/<name>` rather than into /work
itself, which is the daemon's own (its state, its starter repo, the public outbox). The desktop app names the folder
in SYNC_REMOTE_DIR and asks for it with SYNC_PROJECT; this checks both before anything starts, hands the installer
what it needs and tells the container which folder it was made for (SANDBOX_PROJECT_DIR).

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
}

impl Placement {
    /// What the sync installer is handed on top of its own variables: the folder, and the project flag exactly when
    /// this is a project, which sync.sh/.ps1 pass to `intentic-machine sync setup` as `--remote-dir`/`--project`.
    pub fn installer_vars(&self) -> Vec<(&'static str, &str)> {
        let mut vars = Vec::new();
        if let Some(remote_dir) = &self.remote_dir {
            vars.push(("SYNC_REMOTE_DIR", remote_dir.as_str()));
        }
        if self.project_dir.is_some() {
            vars.push(("SYNC_PROJECT", "1"));
        }
        vars
    }
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
            })
        );
    }

    #[test]
    fn an_ordinary_setup_is_placed_on_the_workspace_and_names_no_project() {
        let workspace = Placement {
            remote_dir: None,
            project_dir: None,
        };
        assert_eq!(placement(None, false, true), Ok(workspace));
        assert_eq!(
            placement(Some("/work"), false, false),
            Ok(Placement {
                remote_dir: Some("/work".to_string()),
                project_dir: None,
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
}
