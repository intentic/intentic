use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::logfile::intentic_home;
use crate::util::{bail, Fail, Result};

/* WHERE A SANDBOX'S BACKUPS GO (2026-11-11).

By default this machine's own disk (`~/.intentic/backups/<slug>/repo`, backup.rs). `ic sandbox backup --repo <where>`
points a sandbox's backups somewhere else, and that choice is kept in `~/.intentic/backups/<slug>/repo.json`, so the
machine agent's unattended daily run (`--auto`) and the quick backup before an update go there too: a folder (a NAS
share, another disk) or any repository restic reaches over the network (sftp:, s3:, rest:, b2:, azure:, gs:, swift:).

ic never keeps a credential for a remote repository. restic reads them from its environment, so ic passes the restic
container the NAMES of the variables set where it runs (RESTIC_*, AWS_*, B2_*, AZURE_*, see PASSED) and docker copies
their values from ic's own environment: they appear on no command line, in no log, and in no file of ic's. A URL that
spells a password into itself is refused for the same reason; restic reads a REST server's login from
RESTIC_REST_USERNAME and RESTIC_REST_PASSWORD. An sftp repository uses this user's ~/.ssh, copied into the worker.

The unattended runs (the machine agent's daily `--auto`, the quick backup before an update it starts) do not run in the
shell the owner typed `--repo` in, and may not have those variables. So `--repo` also keeps the NAMES of the credential
variables set when it was given (`needs` in repo.json, never a value), and a run missing any of them knows before it
starts: a person's run stops and names them; an unattended one backs up to this machine's own disk for that run and says
so in its answer (backup.rs), rather than failing every day where nobody reads the machine agent's log. */

/// The repository schemes the pinned restic image reaches by itself (rclone needs a binary it does not carry).
const SCHEMES: [&str; 7] = ["sftp:", "s3:", "rest:", "b2:", "azure:", "gs:", "swift:"];

/// The prefixes of the variables whose names reach the restic container, for a remote repository's credentials.
const PASSED: [&str; 4] = ["RESTIC_", "AWS_", "B2_", "AZURE_"];
/// ...except the ones ic sets itself, which say where the repository is and what opens it.
const SET_BY_IC: [&str; 5] = [
    "RESTIC_REPOSITORY",
    "RESTIC_REPOSITORY_FILE",
    "RESTIC_PASSWORD",
    "RESTIC_PASSWORD_FILE",
    "RESTIC_PASSWORD_COMMAND",
];

/// Where a backup repository is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    /// A folder on this machine (or a share mounted on it), bound into the restic container.
    Folder(PathBuf),
    /// A repository restic reaches over the network, by its restic URL.
    Remote(String),
}

impl Location {
    /// How it is written in repo.json and shown to a person.
    pub fn spelled(&self) -> String {
        match self {
            Location::Folder(path) => path.display().to_string(),
            Location::Remote(url) => url.clone(),
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, Location::Remote(_))
    }

    /// Whether this is an sftp repository, which needs this user's ssh setup in the worker.
    pub fn is_sftp(&self) -> bool {
        matches!(self, Location::Remote(url) if url.to_ascii_lowercase().starts_with("sftp:"))
    }
}

/// A repository as a person names it: a restic URL with one of SCHEMES, else a folder. A URL carrying a password, and
/// a relative folder (which would reach docker as a volume name), are refused. Pure but for making a folder absolute.
pub fn parse(raw: &str) -> Result<Location> {
    let raw = raw.trim();
    if raw.is_empty() {
        bail!("--repo names no repository");
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("rclone:") {
        bail!(
            "rclone: repositories are not supported: the restic image ic runs has no rclone in it"
        );
    }
    if SCHEMES.iter().any(|scheme| lower.starts_with(scheme)) {
        if spells_password(raw) {
            bail!(
                "{raw:?} has a password in it, which ic would keep in a file: put it in the environment instead (RESTIC_REST_PASSWORD, AWS_SECRET_ACCESS_KEY, B2_ACCOUNT_KEY…) and name the repository without it"
            );
        }
        return Ok(Location::Remote(raw.to_string()));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        bail!(
            "--repo {raw:?} is neither a restic URL ({}) nor an absolute folder",
            SCHEMES.join(" ")
        );
    }
    Ok(Location::Folder(path))
}

/// Whether a URL holds `user:password@` after its `//`. Pure.
fn spells_password(url: &str) -> bool {
    let Some((_, rest)) = url.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    authority
        .rsplit_once('@')
        .is_some_and(|(userinfo, _)| userinfo.contains(':'))
}

fn file_in(home: &Path, slug: &str) -> PathBuf {
    home.join("backups").join(slug).join("repo.json")
}

/// The repository saved for a sandbox, if one is. A file that does not parse is said and ignored: backups then go to
/// this machine's disk, where they always could.
pub fn saved_in(home: &Path, slug: &str) -> Option<Location> {
    let path = file_in(home, slug);
    let text = std::fs::read_to_string(&path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    match value["repo"].as_str().map(parse) {
        Some(Ok(location)) => Some(location),
        _ => {
            crate::ui::warn(&format!(
                "{} does not name a repository ic can use; backing up to this machine instead.",
                path.display()
            ));
            None
        }
    }
}

pub fn saved(slug: &str) -> Option<Location> {
    saved_in(&intentic_home(), slug)
}

/// The credential variable names the saved repository was given with (`needs`); none for a file from before they were
/// kept, or a repository saved with none set.
pub fn needs_in(home: &Path, slug: &str) -> Vec<String> {
    std::fs::read_to_string(file_in(home, slug))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value["needs"].as_array().map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
        })
        .unwrap_or_default()
}

pub fn needs(slug: &str) -> Vec<String> {
    needs_in(&intentic_home(), slug)
}

/// The names in `needs` that `present` lacks, in order. Pure.
pub fn missing<I: IntoIterator<Item = String>>(needs: &[String], present: I) -> Vec<String> {
    let present: Vec<String> = present.into_iter().collect();
    needs
        .iter()
        .filter(|name| !present.contains(name))
        .cloned()
        .collect()
}

/// The credential variables set in this process's environment, by name (credential_names).
pub fn names_here() -> Vec<String> {
    credential_names(std::env::vars_os().map(|(name, _)| name.to_string_lossy().to_string()))
}

/// Keep `location` as the sandbox's repository, with the credential variable names it needs; None goes back to this
/// machine's own disk.
pub fn save_in(
    home: &Path,
    slug: &str,
    location: Option<&Location>,
    needs: &[String],
) -> Result<()> {
    let path = file_in(home, slug);
    match location {
        Some(location) => {
            std::fs::create_dir_all(path.parent().expect("repo.json has a parent"))?;
            // A folder needs no credentials, whatever happens to be set.
            let needs: &[String] = if location.is_remote() { needs } else { &[] };
            let body = json!({ "repo": location.spelled(), "needs": needs });
            std::fs::write(&path, format!("{body}\n"))
                .map_err(|err| Fail(format!("could not write {}: {err}", path.display())))?;
        }
        None => match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => bail!("could not remove {}: {err}", path.display()),
        },
    }
    Ok(())
}

pub fn save(slug: &str, location: Option<&Location>) -> Result<()> {
    save_in(&intentic_home(), slug, location, &names_here())
}

/// The credential variable names among `names`: each that starts with one of PASSED and is not one ic sets, sorted and
/// once each. Pure.
pub fn credential_names<I: IntoIterator<Item = String>>(names: I) -> Vec<String> {
    let mut picked: Vec<String> = names
        .into_iter()
        .filter(|name| PASSED.iter().any(|prefix| name.starts_with(prefix)))
        .filter(|name| !SET_BY_IC.contains(&name.as_str()))
        .collect();
    picked.sort();
    picked.dedup();
    picked
}

/// The `-e NAME` pairs that hand a remote repository's credentials to the restic container: each credential name set
/// in `names` (credential_names), value left for docker to copy. Pure.
pub fn passed_env<I: IntoIterator<Item = String>>(names: I) -> Vec<String> {
    credential_names(names)
        .into_iter()
        .flat_map(|name| ["-e".to_string(), name])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repository_is_a_restic_url_or_an_absolute_folder() {
        for url in [
            "sftp:me@nas:/backups/x",
            "s3:s3.amazonaws.com/bucket/x",
            "rest:https://backup.example/x",
            "b2:bucket:x",
            "S3:host/bucket",
        ] {
            assert_eq!(
                parse(url).unwrap(),
                Location::Remote(url.to_string()),
                "{url}"
            );
        }
        let folder = if cfg!(windows) {
            r"D:\backups\x"
        } else {
            "/mnt/nas/backups/x"
        };
        assert_eq!(
            parse(folder).unwrap(),
            Location::Folder(PathBuf::from(folder))
        );
        assert!(
            parse("backups/x").is_err(),
            "a relative folder would reach docker as a volume name"
        );
        assert!(parse("").is_err());
        assert!(parse("rclone:remote:x").is_err());
        assert!(parse("sftp:me@nas:/x").unwrap().is_sftp());
        assert!(!parse("s3:h/b").unwrap().is_sftp());
    }

    #[test]
    fn a_url_with_a_password_in_it_is_refused() {
        assert!(parse("rest:https://ada:secret@backup.example/x").is_err());
        assert!(parse("rest:https://ada@backup.example/x").is_ok());
        assert!(parse("rest:https://backup.example/x?a=b:c@d").is_ok());
    }

    #[test]
    fn the_repository_is_kept_per_sandbox_and_forgotten_on_request() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(saved_in(home.path(), "abc"), None);
        let remote = Location::Remote("s3:host/bucket/abc".to_string());
        save_in(home.path(), "abc", Some(&remote), &[]).unwrap();
        assert_eq!(saved_in(home.path(), "abc"), Some(remote));
        assert_eq!(saved_in(home.path(), "def"), None);
        let text = std::fs::read_to_string(home.path().join("backups/abc/repo.json")).unwrap();
        assert!(text.contains("s3:host/bucket/abc"), "{text}");
        save_in(home.path(), "abc", None, &[]).unwrap();
        assert_eq!(saved_in(home.path(), "abc"), None);
        save_in(home.path(), "abc", None, &[]).unwrap();
    }

    #[test]
    fn a_remote_repository_keeps_the_names_of_the_credentials_it_needs_never_their_values() {
        let home = tempfile::tempdir().unwrap();
        let needs = vec![
            "AWS_ACCESS_KEY_ID".to_string(),
            "AWS_SECRET_ACCESS_KEY".to_string(),
        ];
        let remote = Location::Remote("s3:host/bucket/abc".to_string());
        save_in(home.path(), "abc", Some(&remote), &needs).unwrap();
        assert_eq!(needs_in(home.path(), "abc"), needs);
        // A folder needs none, whatever was set when it was saved.
        save_in(
            home.path(),
            "def",
            Some(&Location::Folder(PathBuf::from("/x"))),
            &needs,
        )
        .unwrap();
        assert!(needs_in(home.path(), "def").is_empty());
        // A repo.json from before names were kept needs none.
        std::fs::write(
            home.path().join("backups/abc/repo.json"),
            r#"{"repo":"s3:host/bucket/abc"}"#,
        )
        .unwrap();
        assert!(needs_in(home.path(), "abc").is_empty());
        assert!(needs_in(home.path(), "nothing").is_empty());
    }

    #[test]
    fn what_a_run_lacks_is_the_needed_names_its_environment_does_not_set() {
        let needs = vec![
            "AWS_ACCESS_KEY_ID".to_string(),
            "AWS_SECRET_ACCESS_KEY".to_string(),
        ];
        assert_eq!(
            missing(
                &needs,
                ["AWS_ACCESS_KEY_ID".to_string(), "HOME".to_string()]
            ),
            vec!["AWS_SECRET_ACCESS_KEY".to_string()]
        );
        assert!(missing(&needs, needs.clone()).is_empty());
        assert!(missing(&[], Vec::<String>::new()).is_empty());
    }

    #[test]
    fn only_credential_names_reach_the_restic_container_never_their_values() {
        let names = [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "B2_ACCOUNT_KEY",
            "RESTIC_REST_PASSWORD",
            "RESTIC_PASSWORD",
            "RESTIC_REPOSITORY",
            "HOME",
            "AWS_ACCESS_KEY_ID",
        ]
        .map(str::to_string);
        assert_eq!(
            passed_env(names),
            vec![
                "-e",
                "AWS_ACCESS_KEY_ID",
                "-e",
                "AWS_SECRET_ACCESS_KEY",
                "-e",
                "B2_ACCOUNT_KEY",
                "-e",
                "RESTIC_REST_PASSWORD"
            ]
        );
    }
}
