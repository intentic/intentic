//! WHERE A WINDOWS PATH SHOWS UP INSIDE OUR ENGINE'S DISTRO.
//!
//! A bind mount's source is read by the daemon, never by the docker CLI that sends it. Docker Desktop's daemon rewrites
//! `C:\Users\…` into its own mount of the drive; a plain Linux `dockerd`, which is what Intentic's engine runs inside its
//! WSL distro (`intentic-engine`), splits `C:\Users\x:/src` on its colons and refuses it as an invalid volume
//! specification. Its distro sees the PC's drives where WSL mounts them, `/mnt/<drive letter>/` (its `wsl.conf` leaves
//! `[automount] root` at that default, `engine/rootfs/wsl.conf`), so every bind ic and the desktop app hand our engine
//! goes through [`wsl_mount_path`] first. Pure: no process, no file system.

/// Where WSL mounts the PC's drives in our distro.
pub const DRIVES_ROOT: &str = "/mnt/";

/// `C:\Users\me\x` (or `C:/Users/me/x`, or `\\?\C:\Users\me\x`) as our engine's distro sees it: `/mnt/c/Users/me/x`.
/// A path that is already a Linux one (`/mnt/c/…`, `/var/…`) is handed back as it is, so a source read off one of our
/// engine's containers can be passed back to it. None for what no drive mount holds: a network share
/// (`\\server\share`), another distro's files (`\\wsl.localhost\…`, `\\wsl$\…`), and anything relative.
pub fn wsl_mount_path(windows: &str) -> Option<String> {
    if windows.starts_with('/') {
        return Some(windows.to_string());
    }
    // The verbatim prefix Windows APIs hand back for long paths: `\\?\C:\…` is a drive path, `\\?\UNC\…` a share.
    let path = windows.strip_prefix(r"\\?\").unwrap_or(windows);
    let mut chars = path.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next() != Some(':') {
        return None;
    }
    let rest = &path[2..];
    // `C:` alone, or `C:folder`, is relative to the drive's current folder: no absolute place to mount.
    if !rest.starts_with(['\\', '/']) {
        return None;
    }
    let mut out = format!("{DRIVES_ROOT}{}", drive.to_ascii_lowercase());
    for part in rest.split(['\\', '/']).filter(|part| !part.is_empty()) {
        out.push('/');
        out.push_str(part);
    }
    Some(out)
}

/// A `-v` spec for our engine: `source:target[:options]` with the source translated, or None when the source is not
/// one our engine's distro can see. `source` is a host path; `rest` is everything after the first separator.
pub fn bind_spec(source: &str, rest: &str) -> Option<String> {
    Some(format!("{}:{rest}", wsl_mount_path(source)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drive_path_lands_under_the_lowercased_drive_in_both_slash_spellings() {
        assert_eq!(
            wsl_mount_path(r"C:\Users\radar\.intentic\backups\abc\repo").as_deref(),
            Some("/mnt/c/Users/radar/.intentic/backups/abc/repo")
        );
        assert_eq!(
            wsl_mount_path("D:/movies/films").as_deref(),
            Some("/mnt/d/movies/films")
        );
        assert_eq!(wsl_mount_path(r"e:\").as_deref(), Some("/mnt/e"));
    }

    #[test]
    fn the_verbatim_prefix_is_dropped_and_doubled_or_trailing_separators_do_not_survive() {
        assert_eq!(
            wsl_mount_path(r"\\?\C:\Users\me\AppData\Local\Temp\drop-1\").as_deref(),
            Some("/mnt/c/Users/me/AppData/Local/Temp/drop-1")
        );
        assert_eq!(
            wsl_mount_path(r"C:\a\\b//c").as_deref(),
            Some("/mnt/c/a/b/c")
        );
    }

    #[test]
    fn spaces_and_non_ascii_names_are_kept_as_they_are() {
        assert_eq!(
            wsl_mount_path(r"C:\Users\Zażółć\Moje filmy\🎬").as_deref(),
            Some("/mnt/c/Users/Zażółć/Moje filmy/🎬")
        );
    }

    #[test]
    fn a_linux_path_is_handed_back_unchanged() {
        assert_eq!(
            wsl_mount_path("/mnt/c/Users/me").as_deref(),
            Some("/mnt/c/Users/me")
        );
        assert_eq!(wsl_mount_path("/var/lib/x").as_deref(), Some("/var/lib/x"));
    }

    #[test]
    fn shares_other_distros_and_relative_paths_have_no_place_in_the_distro() {
        for path in [
            r"\\nas\films",
            r"\\?\UNC\nas\films",
            r"\\wsl.localhost\Ubuntu\home\me",
            r"\\wsl$\Ubuntu\home\me",
            r"films\new",
            r"C:films",
            "C:",
            "",
            "1:/x",
        ] {
            assert_eq!(wsl_mount_path(path), None, "{path}");
        }
    }

    #[test]
    fn a_bind_spec_translates_only_its_source() {
        assert_eq!(
            bind_spec(r"C:\stage", "/stage:ro").as_deref(),
            Some("/mnt/c/stage:/stage:ro")
        );
        assert_eq!(bind_spec(r"\\nas\x", "/src:ro"), None);
    }

    #[test]
    fn the_engine_distro_mounts_drives_where_this_module_looks() {
        let conf = include_str!("../../engine/rootfs/wsl.conf");
        let automount = conf
            .split("\n[")
            .find(|section| section.trim_start_matches('[').starts_with("automount]"))
            .expect("wsl.conf has an [automount] section");
        assert!(
            !automount
                .lines()
                .any(|line| line.trim_start().starts_with("root")),
            "wsl.conf moves the drives away from {DRIVES_ROOT}: update DRIVES_ROOT with it"
        );
        assert!(automount.contains("enabled=true"));
    }
}
