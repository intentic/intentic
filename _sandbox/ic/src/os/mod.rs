/* INTENTIC OS: the immutable Linux that boots straight into Intentic (_os/README.md), and `ic os`, the one door through
which anything changes it. The machine agent's tools, the desktop app, greenboot and the image's systemd units all call
these verbs and read their JSON rather than bootc's, so what bootc says and how is held in one place (status.rs) instead
of in every caller.

A machine is Intentic OS when its image carries `/usr/lib/intentic-os/release.json`, which the image build writes.
Anywhere else every verb stops with exit code 3 and one sentence, so a caller tells "not this kind of machine" from "it
failed" without reading prose. The image is Linux; on Windows the group says so, with the same code.

The isolation policy (policy.rs) is the one part every platform compiles: connect, every recreate and the runner apply
it to the sandbox's run line, and off Intentic OS it changes nothing. */

pub mod policy;

#[cfg(target_os = "linux")]
pub mod screen;

#[cfg(unix)]
pub mod bar;
#[cfg(unix)]
pub mod lock;

#[cfg(unix)]
mod bootc;
#[cfg(unix)]
pub mod display;
#[cfg(unix)]
pub mod drives;
#[cfg(unix)]
pub mod health;
#[cfg(unix)]
pub mod keyboard;
#[cfg(unix)]
pub mod network;
#[cfg(unix)]
pub mod pair;
#[cfg(unix)]
pub mod reboot;
#[cfg(unix)]
pub mod sound;
#[cfg(unix)]
pub mod status;
#[cfg(unix)]
pub mod sway;
#[cfg(unix)]
mod tool;
#[cfg(unix)]
pub mod update;

use std::path::{Path, PathBuf};

use serde_json::Value;

/// The exit code of every `ic os` verb on a machine that is not Intentic OS.
pub const NOT_INTENTIC_OS: i32 = 3;

/// Prefixes every path below, so a test (or a dry run on a workstation) can stand a whole OS tree up in a folder.
pub const ROOT_VAR: &str = "INTENTIC_OS_ROOT";

/// Where Intentic OS keeps what `ic os` reads and writes, under one root: `/` on the machine itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    /// The machine's own: `/`, or `INTENTIC_OS_ROOT` when it is set.
    pub fn here() -> Paths {
        let root = std::env::var_os(ROOT_VAR)
            .filter(|root| !root.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        Paths { root }
    }

    /// The same layout under another folder.
    #[cfg(test)]
    pub fn under(root: &Path) -> Paths {
        Paths {
            root: root.to_path_buf(),
        }
    }

    fn at(&self, absolute: &str) -> PathBuf {
        self.root.join(absolute.trim_start_matches('/'))
    }

    /// `{ "name", "edition", "version", "channel", "repository" }`, written by the image build. Its presence is what
    /// makes a machine Intentic OS.
    pub fn release(&self) -> PathBuf {
        self.at("/usr/lib/intentic-os/release.json")
    }

    /// The policy's defaults, shipped in the image.
    pub fn policy_defaults(&self) -> PathBuf {
        self.at("/usr/lib/intentic-os/os.json")
    }

    /// The owner's policy, which wins key by key.
    pub fn policy_owner(&self) -> PathBuf {
        self.at("/etc/intentic/os.json")
    }

    /// `{ "recordedAt": <ms>, "slugs": [...] }`: the sandboxes that ran when the machine last went down in order.
    #[cfg_attr(not(unix), allow(dead_code))] // read by the unix-only verbs
    pub fn expected_running(&self) -> PathBuf {
        self.at("/var/lib/intentic-os/expected-running.json")
    }

    /// This boot's health verdict (`/run` is gone at the next boot, so an old verdict never stands for a new one).
    #[cfg_attr(not(unix), allow(dead_code))] // read by the unix-only verbs
    pub fn health(&self) -> PathBuf {
        self.at("/run/intentic-os/health.json")
    }

    /// Left once first-boot pairing succeeded; the pairing unit does not start again while it is there.
    #[cfg_attr(not(unix), allow(dead_code))] // read by the unix-only verbs
    pub fn paired(&self) -> PathBuf {
        self.at("/var/lib/intentic-os/paired")
    }
}

/// Whether this machine is Intentic OS.
pub fn on_intentic_os() -> bool {
    cfg!(target_os = "linux") && Paths::here().release().is_file()
}

/// Stop here, with exit code 3, unless this machine is Intentic OS. Every `ic os` verb passes through it first.
#[cfg(unix)]
pub fn gate() {
    if !on_intentic_os() {
        crate::ui::error(&format!(
            "This machine is not Intentic OS ({} is missing), so ic os has nothing to manage here.",
            Paths::here().release().display()
        ));
        std::process::exit(NOT_INTENTIC_OS);
    }
}

/// One line of JSON on stdout, the `--json` answer. Written to stdout itself: a `--json` run sends every human line to
/// stderr (ui::send_human_to_stderr), and the crate's `println!` with it.
#[cfg(unix)]
pub fn emit_json(value: &Value) {
    use std::io::Write as _;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// A JSON file, or None when it is missing or is not JSON.
#[cfg_attr(not(unix), allow(dead_code))] // read by the unix-only verbs
pub fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// `release.json`, which the gate has already found.
#[cfg(unix)]
pub fn release(paths: &Paths) -> crate::util::Result<Value> {
    let path = paths.release();
    let text = std::fs::read_to_string(&path)
        .map_err(|err| crate::util::Fail(format!("could not read {}: {err}", path.display())))?;
    serde_json::from_str(&text)
        .map_err(|err| crate::util::Fail(format!("{} is not JSON: {err}", path.display())))
}

/// Write `body` at `path` all at once: into a file beside it, flushed to disk, then renamed over it, so a reader (or a
/// power cut) never finds half of one. Readable by everyone, since root writes files the `intentic` user reads.
#[cfg(unix)]
pub fn write_atomic(path: &Path, body: &[u8]) -> crate::util::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::PermissionsExt as _;
    let parent = path
        .parent()
        .ok_or_else(|| crate::util::Fail(format!("{} has no folder", path.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|err| crate::util::Fail(format!("could not make {}: {err}", parent.display())))?;
    let fail = |err: std::io::Error| {
        crate::util::Fail(format!("could not write {}: {err}", path.display()))
    };
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(fail)?;
    file.write_all(body).map_err(fail)?;
    file.as_file().sync_all().map_err(fail)?;
    file.as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o644))
        .map_err(fail)?;
    file.persist(path).map_err(|err| fail(err.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_path_hangs_off_one_root() {
        let paths = Paths::under(Path::new("/tmp/os-tree"));
        assert_eq!(
            paths.release(),
            Path::new("/tmp/os-tree/usr/lib/intentic-os/release.json")
        );
        assert_eq!(
            paths.policy_owner(),
            Path::new("/tmp/os-tree/etc/intentic/os.json")
        );
        assert_eq!(
            paths.expected_running(),
            Path::new("/tmp/os-tree/var/lib/intentic-os/expected-running.json")
        );
        assert_eq!(
            paths.health(),
            Path::new("/tmp/os-tree/run/intentic-os/health.json")
        );
        assert_eq!(
            Paths::under(Path::new("/")).paired(),
            Path::new("/var/lib/intentic-os/paired")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_is_written_whole_and_readable_by_everyone() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("deep").join("health.json");
        write_atomic(&path, b"{\"verdict\":\"green\"}").expect("written");
        write_atomic(&path, b"{\"verdict\":\"red\"}").expect("replaced");
        assert_eq!(
            read_json(&path),
            Some(serde_json::json!({"verdict": "red"}))
        );
        let mode = std::fs::metadata(&path)
            .expect("there")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o644);
        assert_eq!(read_json(&dir.path().join("missing.json")), None);
    }
}
