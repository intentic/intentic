use std::path::{Path, PathBuf};

use crate::contract::{self, RunRequest};
use crate::docker;
use crate::logfile::{intentic_home, Log};
use crate::sandbox::recreate::APPROVED_FILE;
use crate::sandbox::{at_rest, container_of, is_slug, side};
use crate::ui;
use crate::util::{bail, base64, sha256_hex, Fail, Result};

/* A RUNNING SANDBOX AS A COMPOSE FOLDER (2026-11-11). Moving the "translations" sandbox from rog to z440 meant writing its
Compose file by hand: the at-rest key bind, the overlay build, SANDBOX_ENVIRONMENT_HASH, the side stamps, the 30 s stop
grace (Compose's 10 s SIGKILL read as a crash and the machine agent restarted the container). Each was a fact the run
contract already holds, so ic asks the sandbox's own IMAGE for the file (`intentic sandbox run-command --format
compose`, sandbox-run's compose.ts) exactly as it asks it for a run line, handing it what only this machine knows: the
container's env (credentials included, which come back for the `.env` and never into the file), the approved recipe,
where the key will sit, and which side keeps the sandbox. The folder holds:

- `compose.yaml`: the service, its storage `external: true` (the volumes already exist and `compose down` must never
  delete a workspace);
- `.env` (0600): the credentials and LOCAL_PORT;
- `at-rest.key` (0400): a copy of the key the container mounts, which the file binds as `./at-rest.key`.

The default is ~/.intentic/compose/<slug>/, a folder of this machine's own, never inside a volume. A folder holding
another sandbox's compose.yaml is refused rather than overwritten. */

/// What the folder's files are called; the Compose file names the key by this path.
pub const COMPOSE_FILE: &str = "compose.yaml";
pub const ENV_FILE: &str = ".env";
pub const KEY_FILE: &str = "at-rest.key";

/// The side stamps a Compose file carries (HOST_PLATFORM, HOST_LABEL, HOST_ENV): which ic keeps the sandbox.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostStamps {
    pub platform: Option<String>,
    pub label: Option<String>,
    pub env: Option<String>,
}

impl HostStamps {
    /// The stamps a container carries, each one it does not falling back to this side's: a sandbox ic made here
    /// carries all three. Pure.
    pub fn of_env(env: &[u8], here: &side::Side, label: &str) -> HostStamps {
        HostStamps {
            platform: at_rest::env_value(env, "HOST_PLATFORM").or(Some(here.platform.clone())),
            label: at_rest::env_value(env, "HOST_LABEL")
                .or_else(|| Some(label.to_string()).filter(|label| !label.is_empty())),
            env: at_rest::env_value(env, "HOST_ENV").or_else(|| here.env.clone()),
        }
    }
}

/// The default folder for a sandbox's Compose files. Pure.
pub fn default_dir(home: &Path, slug: &str) -> PathBuf {
    home.join("compose").join(slug)
}

/// The container a Compose file names (`container_name:`), the way compose.ts writes it. Pure.
pub fn container_named(compose: &str) -> Option<&str> {
    compose
        .lines()
        .find_map(|line| line.trim().strip_prefix("container_name:"))
        .map(|name| name.trim().trim_matches('"'))
        .filter(|name| !name.is_empty())
}

/// Why `dir` may not take `container`'s files: it already holds a Compose file for another one. Pure.
pub fn refusal(existing: Option<&str>, container: &str, dir: &Path) -> Option<String> {
    let existing = existing?;
    match container_named(existing) {
        Some(named) if named == container => None,
        Some(named) => Some(format!(
            "{} holds the Compose file of {named}, not {container}: choose another folder (--out).",
            dir.display()
        )),
        None => Some(format!(
            "{} already holds a {COMPOSE_FILE} that is not a sandbox's: choose another folder (--out).",
            dir.display()
        )),
    }
}

/// The optional directives the container was started without, read off their stamps (`SANDBOX_GPU=unsupported`): the
/// file keeps them dropped, as the run line did. Pure.
pub fn unsupported_of(env: &[u8]) -> Vec<String> {
    match at_rest::env_value(env, "SANDBOX_GPU").as_deref() {
        Some("unsupported") => vec!["--gpus=all".to_string()],
        _ => Vec::new(),
    }
}

/// The flags only the Compose rendering reads, attached (`--name=value`) since a value may begin with `-`. Pure.
pub fn compose_flags(recipe: Option<&str>, key: bool, host: &HostStamps) -> Vec<String> {
    let mut flags = Vec::new();
    if let Some(recipe) = recipe {
        flags.push(format!("--recipe-b64={}", base64(recipe.as_bytes())));
    }
    if key {
        flags.push(format!("--at-rest-key=./{KEY_FILE}"));
    }
    for (flag, value) in [
        ("--host-platform", &host.platform),
        ("--host-label", &host.label),
        ("--host-env", &host.env),
    ] {
        if let Some(value) = value.as_deref().filter(|value| !value.is_empty()) {
            flags.push(format!("{flag}={value}"));
        }
    }
    flags
}

/// What to do with the folder once it is written, for a person. Pure.
pub fn next_step(slug: &str, dir: &Path) -> String {
    let container = container_of(slug);
    format!(
        "Wrote {dir}. To hand {slug} to Docker Compose on this machine: `ic sandbox stop {slug}`, `docker rm {container}` \
         (its volumes stay), then `docker compose up -d` in that folder. On a Komodo server: copy the folder there and \
         point a stack at it (files on host, run directory = the folder). The volumes and the network must already \
         exist where it runs.",
        dir = dir.display()
    )
}

/// Write `slug`'s Compose folder at `dir`, stamped as kept by the side the container already names, and return the
/// folder. What `ic sandbox compose` and a move to another device call.
pub fn write_folder(slug: &str, dir: &Path) -> Result<PathBuf> {
    write_folder_as(slug, dir, None)
}

/// `write_folder` with the side stamps of the machine the file will run on, when that is not the one the container
/// names (a move to another device).
pub fn write_folder_as(slug: &str, dir: &Path, host: Option<HostStamps>) -> Result<PathBuf> {
    if !is_slug(slug) {
        bail!("'{slug}' is not a sandbox name.");
    }
    let container = container_of(slug);
    if !docker::container_exists(&container) {
        bail!("there is no sandbox {slug} on this device ({container}).");
    }
    let existing = std::fs::read_to_string(dir.join(COMPOSE_FILE)).ok();
    if let Some(reason) = refusal(existing.as_deref(), &container, dir) {
        bail!("{reason}");
    }
    let env = docker::container_env_nul(&container)?;
    let image = docker::inspect(&container, "{{.Config.Image}}")
        .filter(|image| !image.is_empty())
        .ok_or_else(|| Fail(format!("could not read {container}'s image.")))?;
    let base_image =
        at_rest::env_value(&env, "SANDBOX_BASE_IMAGE").unwrap_or_else(|| image.clone());
    let host = host.unwrap_or_else(|| {
        HostStamps::of_env(
            &env,
            &side::here(),
            &crate::sandbox::connect::machine_label(),
        )
    });

    let work = tempfile::tempdir()?;
    // The approved recipe, built by Compose on `up`; its hash is the one a rebuild would stamp (composition.rs).
    let recipe_path = work.path().join("approved.Dockerfile");
    let recipe = docker::cp_out(&container, APPROVED_FILE, &recipe_path)
        .is_none()
        .then(|| std::fs::read_to_string(&recipe_path).ok())
        .flatten()
        .filter(|content| !content.trim().is_empty());
    let hash = recipe
        .as_deref()
        .map(|content| sha256_hex(content.as_bytes()));
    // The key the container mounts, copied through docker so its spelling on this engine's host does not matter.
    let key_path = work.path().join(KEY_FILE);
    let key = docker::mount_source(&container, at_rest::KEY_MOUNT).is_some()
        && docker::cp_out(&container, at_rest::KEY_MOUNT, &key_path).is_none();
    if docker::mount_source(&container, at_rest::PREVIOUS_KEY_MOUNT).is_some() {
        ui::warn(&format!(
            "{slug} is in the middle of an at-rest key rotation: the Compose file carries only its current key. Finish the rotation (restart it through ic) before moving it."
        ));
    }
    let mut mounts: Vec<String> = Vec::new();
    if let Some(auth) = docker::mount_source(&container, at_rest::AUTH_MOUNT) {
        mounts.push(format!("{auth}:{}", at_rest::AUTH_MOUNT));
    }
    let mounts_joined = (!mounts.is_empty()).then(|| mounts.join("\n"));
    let dns = docker::inspect(&container, "{{join .HostConfig.Dns \" \"}}")
        .filter(|servers| !servers.is_empty());
    let channel = at_rest::env_value(&env, "SANDBOX_CHANNEL");
    let previous = at_rest::env_value(&env, "SANDBOX_PREVIOUS_IMAGE");
    let request = RunRequest {
        image: &image,
        slug,
        base_image: &base_image,
        channel: channel.as_deref(),
        previous_image: previous.as_deref(),
        environment_hash: hash.as_deref(),
        // The recipe's own directive lines ride inside it: the rendering reads them there.
        runtime: None,
        mounts: mounts_joined.as_deref(),
        dns: dns.as_deref(),
        definition_b64: None,
    };
    let log = Log::create_named("compose", &format!("compose-{slug}"))?;
    let answer = contract::compose_command(
        &request,
        &env,
        &unsupported_of(&env),
        &compose_flags(recipe.as_deref(), key, &host),
        &log,
    )?;

    std::fs::create_dir_all(dir)
        .map_err(|err| Fail(format!("could not make {}: {err}", dir.display())))?;
    write_mode(&dir.join(COMPOSE_FILE), answer.compose.as_bytes(), 0o644)?;
    write_mode(&dir.join(ENV_FILE), answer.env_file.as_bytes(), 0o600)?;
    if key {
        write_mode(&dir.join(KEY_FILE), &std::fs::read(&key_path)?, 0o400)?;
    }
    Ok(dir.to_path_buf())
}

/// Write `body` at `path` with `mode` (on Unix): into a file beside it, then renamed over it, so a read-only key from
/// an earlier run is replaced rather than refused.
fn write_mode(path: &Path, body: &[u8], mode: u32) -> Result<()> {
    use std::io::Write as _;
    let parent = path
        .parent()
        .ok_or_else(|| Fail(format!("{} has no folder", path.display())))?;
    let fail = |err: std::io::Error| Fail(format!("could not write {}: {err}", path.display()));
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(fail)?;
    file.write_all(body).map_err(fail)?;
    file.as_file().sync_all().map_err(fail)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(fail)?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    file.persist(path).map_err(|err| fail(err.error))?;
    Ok(())
}

/// `ic sandbox compose <slug> [--out <dir>]`.
pub fn run(slug: String, out: Option<PathBuf>) -> Result<()> {
    let dir = out.unwrap_or_else(|| default_dir(&intentic_home(), &slug));
    let dir = write_folder(&slug, &dir)?;
    ui::done(&next_step(&slug, &dir));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "services:\n    intentic-sandbox:\n        image: \"x\"\n        container_name: intentic-sandbox-translations\n";

    #[test]
    fn a_folder_is_refused_only_when_it_holds_another_sandboxs_file() {
        let dir = Path::new("/tmp/c");
        assert_eq!(refusal(None, "intentic-sandbox-translations", dir), None);
        assert_eq!(
            refusal(Some(FILE), "intentic-sandbox-translations", dir),
            None
        );
        assert!(refusal(Some(FILE), "intentic-sandbox-other", dir)
            .unwrap()
            .contains("intentic-sandbox-translations"));
        assert!(refusal(Some("services: {}\n"), "intentic-sandbox-x", dir).is_some());
    }

    #[test]
    fn the_file_names_its_container_as_compose_ts_writes_it() {
        assert_eq!(container_named(FILE), Some("intentic-sandbox-translations"));
        assert_eq!(container_named("container_name: \"a\"\n"), Some("a"));
        assert_eq!(container_named("image: x\n"), None);
    }

    #[test]
    fn the_folder_is_under_ics_home() {
        assert_eq!(
            default_dir(Path::new("/home/a/.intentic"), "translations"),
            Path::new("/home/a/.intentic/compose/translations")
        );
    }

    #[test]
    fn a_dropped_gpu_stays_dropped() {
        assert_eq!(
            unsupported_of(b"A=1\0SANDBOX_GPU=unsupported\0"),
            vec!["--gpus=all".to_string()]
        );
        assert!(unsupported_of(b"SANDBOX_GPU=all\0").is_empty());
        assert!(unsupported_of(b"").is_empty());
    }

    #[test]
    fn the_stamps_are_the_containers_and_this_sides_where_it_names_none() {
        let here = side::Side::new("linux", Some("native"));
        let stamped = HostStamps::of_env(
            b"HOST_PLATFORM=windows\0HOST_LABEL=rog\0HOST_ENV=archlinux\0",
            &here,
            "z440",
        );
        assert_eq!(stamped.platform.as_deref(), Some("windows"));
        assert_eq!(stamped.label.as_deref(), Some("rog"));
        assert_eq!(stamped.env.as_deref(), Some("archlinux"));
        let bare = HostStamps::of_env(b"", &here, "z440");
        assert_eq!(bare.platform.as_deref(), Some("linux"));
        assert_eq!(bare.label.as_deref(), Some("z440"));
        assert_eq!(bare.env.as_deref(), Some("native"));
    }

    #[test]
    fn the_flags_are_attached_and_name_the_key_beside_the_file() {
        let host = HostStamps {
            platform: Some("linux".into()),
            label: Some("z440".into()),
            env: None,
        };
        let flags = compose_flags(Some("FROM x\n"), true, &host);
        assert_eq!(
            flags,
            vec![
                format!("--recipe-b64={}", base64(b"FROM x\n")),
                "--at-rest-key=./at-rest.key".to_string(),
                "--host-platform=linux".to_string(),
                "--host-label=z440".to_string(),
            ]
        );
        assert!(compose_flags(None, false, &HostStamps::default()).is_empty());
    }

    // ic's names for the key's place and variable are the run contract's (sandbox-run's golden/at-rest.json).
    #[test]
    fn the_key_mount_is_the_run_contracts() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-run/golden/at-rest.json"
        ))
        .expect("JSON");
        assert_eq!(golden["keyMount"], at_rest::KEY_MOUNT);
        assert_eq!(golden["keyEnv"], at_rest::KEY_ENV);
    }
}
