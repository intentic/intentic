use crate::docker;
use crate::util::{bail, Result};

/* A SWAP NEVER MOVES A SANDBOX ONTO OTHER STORAGE.

The image being moved onto prints its own `docker run` line (contract.rs), and a named volume docker does not have is
created empty rather than refused. So a run contract that spelled a volume differently, or dropped a mount, would start
the sandbox on EMPTY storage: it would pass every health check (a fresh daemon boots fine on nothing), the owner would
see their workspace gone, desktop sync would carry the "deletions" to their own folder, and the next update would build
on the empty volumes. The data would still be in the old volumes, which nobody would know to look for. A mount dropped
from one run shape wiped the hosted fleet's /history once already. */

/// The mounts a swap must carry over unchanged: the workspace, the daemon's records, and the sandbox's own Docker.
pub const DATA_DESTINATIONS: [&str; 3] = ["/work", "/history", "/var/lib/docker"];

/// Where `argv` (docker's arguments, as the run contract prints them) mounts something at `destination`, spelled as
/// `-v` takes it back; None when it mounts nothing there. Reads `-v`/`--volume` in both spellings and `--mount`.
pub fn mounted_at(argv: &[String], destination: &str) -> Option<String> {
    let mut found = None;
    let mut args = argv.iter();
    while let Some(arg) = args.next() {
        let spec = match arg.as_str() {
            "-v" | "--volume" => args.next().and_then(|spec| volume_spec(spec)),
            "--mount" => args.next().and_then(|spec| mount_spec(spec)),
            other => other
                .strip_prefix("--volume=")
                .and_then(volume_spec)
                .or_else(|| other.strip_prefix("--mount=").and_then(mount_spec)),
        };
        if let Some((source, target)) = spec {
            if target == destination {
                // The last mount at a path is the one docker keeps.
                found = Some(source);
            }
        }
    }
    found
}

/// `source:target[:options]`, where a Windows host path's drive letter (`C:\x`, `C:/x`) is part of the source.
fn volume_spec(spec: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = spec.split(':').collect();
    let (source, rest) = match parts.as_slice() {
        // A drive letter only when what follows it is a path AND a target follows that: `w:/work:ro` is the volume
        // `w` mounted read-only, never a drive `w:` holding a folder called /work.
        [drive, path, rest @ ..]
            if drive.len() == 1
                && drive.chars().all(|c| c.is_ascii_alphabetic())
                && (path.starts_with('\\') || path.starts_with('/'))
                && rest.first().is_some_and(|target| target.starts_with('/')) =>
        {
            (format!("{drive}:{path}"), rest)
        }
        [source, rest @ ..] if !rest.is_empty() => (source.to_string(), rest),
        _ => return None,
    };
    Some((source, rest.first()?.to_string()))
}

/// `type=volume,source=x,target=/work` in any order, with docker's aliases for both keys.
fn mount_spec(spec: &str) -> Option<(String, String)> {
    let mut source = None;
    let mut target = None;
    for pair in spec.split(',') {
        match pair.split_once('=') {
            Some(("source" | "src", value)) => source = Some(value.to_string()),
            Some(("target" | "destination" | "dst", value)) => target = Some(value.to_string()),
            _ => {}
        }
    }
    Some((source?, target?))
}

/// Every data mount the new run line would change, as a line for a person: pure over what the running container
/// mounts (per destination, None where it mounts nothing) and the new argv. A destination the running container
/// has nothing at is not held to anything, so a first mount can be added.
pub fn moves(current: &[(&str, Option<String>)], argv: &[String]) -> Vec<String> {
    current
        .iter()
        .filter_map(|(destination, now)| {
            let now = now.as_ref()?;
            match mounted_at(argv, destination) {
                Some(next) if next == *now => None,
                Some(next) => Some(format!("{destination} would be {next} instead of {now}")),
                None => Some(format!("{destination} ({now}) would not be mounted at all")),
            }
        })
        .collect()
}

/// Refuse a run line that would put `container`'s sandbox on other storage. `IC_ALLOW_STORAGE_MOVE=1` is the one way
/// past it, for a deliberate migration a person is standing over.
pub fn check(container: &str, argv: &[String]) -> Result<()> {
    let current: Vec<(&str, Option<String>)> = DATA_DESTINATIONS
        .iter()
        .map(|destination| (*destination, docker::mount_source(container, destination)))
        .collect();
    let moved = moves(&current, argv);
    if moved.is_empty() {
        return Ok(());
    }
    if std::env::var("IC_ALLOW_STORAGE_MOVE").as_deref() == Ok("1") {
        crate::ui::warn(&format!(
            "IC_ALLOW_STORAGE_MOVE=1: moving this sandbox onto other storage anyway — {}.",
            moved.join("; ")
        ));
        return Ok(());
    }
    bail!(
        "the image being moved onto would start this sandbox on different storage, so nothing was changed:\n       {}\n       Your files are where they were. This is a fault in that image's run contract — report it rather than working around it.",
        moved.join("\n       ")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    fn current(work: &str, history: &str) -> Vec<(&'static str, Option<String>)> {
        vec![
            ("/work", Some(work.to_string())),
            ("/history", Some(history.to_string())),
            ("/var/lib/docker", None),
        ]
    }

    #[test]
    fn a_run_line_on_the_same_volumes_moves_nothing() {
        // The shape the run contract prints today (sandbox-run index.ts): `-v <volume>:<destination>`.
        let line = argv(&[
            "run",
            "-d",
            "--name",
            "intentic-sandbox-abc",
            "-v",
            "intentic-workspace-abc:/work",
            "-v",
            "intentic-history-abc:/history",
            "-v",
            "intentic-dev-agent-auth:/agent-auth",
            "ghcr.io/intentic/sandbox:stable",
        ]);
        assert!(moves(
            &current("intentic-workspace-abc", "intentic-history-abc"),
            &line
        )
        .is_empty());
    }

    #[test]
    fn a_renamed_volume_or_a_dropped_mount_is_named() {
        // The failure this exists for: a slug-derived name that no longer matches what the sandbox runs on.
        let renamed = argv(&[
            "run",
            "-v",
            "intentic-workspace-abc.previous:/work",
            "-v",
            "intentic-history-abc:/history",
            "img",
        ]);
        assert_eq!(
            moves(
                &current("intentic-workspace-abc", "intentic-history-abc"),
                &renamed
            ),
            vec![
                "/work would be intentic-workspace-abc.previous instead of intentic-workspace-abc"
                    .to_string()
            ]
        );
        let dropped = argv(&["run", "-v", "intentic-workspace-abc:/work", "img"]);
        assert_eq!(
            moves(
                &current("intentic-workspace-abc", "intentic-history-abc"),
                &dropped
            ),
            vec!["/history (intentic-history-abc) would not be mounted at all".to_string()]
        );
    }

    #[test]
    fn every_spelling_docker_takes_is_read() {
        assert_eq!(
            mounted_at(&argv(&["--volume", "w:/work:ro"]), "/work").as_deref(),
            Some("w")
        );
        assert_eq!(
            mounted_at(&argv(&["-v", "C:/Users/me/w:/work:ro"]), "/work").as_deref(),
            Some("C:/Users/me/w")
        );
        assert_eq!(
            mounted_at(&argv(&["--volume=w:/work"]), "/work").as_deref(),
            Some("w")
        );
        assert_eq!(
            mounted_at(
                &argv(&["--mount", "type=volume,target=/work,source=w"]),
                "/work"
            )
            .as_deref(),
            Some("w")
        );
        assert_eq!(
            mounted_at(&argv(&["--mount=type=bind,src=/srv/w,dst=/work"]), "/work").as_deref(),
            Some("/srv/w")
        );
        // A Windows bind source keeps its drive letter.
        assert_eq!(
            mounted_at(&argv(&["-v", "C:\\Users\\me\\w:/work"]), "/work").as_deref(),
            Some("C:\\Users\\me\\w")
        );
        // A destination is matched exactly: /workspace is not /work.
        assert_eq!(mounted_at(&argv(&["-v", "w:/workspace"]), "/work"), None);
        // The last mount at a path is the one docker keeps.
        assert_eq!(
            mounted_at(&argv(&["-v", "a:/work", "-v", "b:/work"]), "/work").as_deref(),
            Some("b")
        );
    }

    #[test]
    fn a_destination_the_running_container_has_nothing_at_is_not_held_to_anything() {
        // A sandbox created before it had its own Docker gains the mount on its next update.
        let line = argv(&[
            "run",
            "-v",
            "w:/work",
            "-v",
            "h:/history",
            "-v",
            "d:/var/lib/docker",
            "img",
        ]);
        assert!(moves(&current("w", "h"), &line).is_empty());
    }
}
