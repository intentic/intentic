/* STARTING AT SIGN-IN, IN THE TRAY (2026-10-13) — opt-in, from the tray's "Start Intentic at login".
 *
 * An app that lives in the tray is only useful while it runs: the wake word (wake.rs), the notifications, the mark on the
 * icon. Nothing started it but the reader, so after every restart it was gone until somebody thought to open it. Ticked,
 * the system starts it at the reader's sign-in with `--background` ([`ARG`]): no window at all, only the tray, and the
 * workspace loaded hidden when its page was listening (lib.rs). Unticked, nothing is left behind.
 *
 * - Windows: the value `Intentic` under `HKCU\…\CurrentVersion\Run`, the key the setup's resume entry already uses
 *   (resume.rs), written and read with the same `reg.exe`. The uninstaller takes it away (installer-hooks.nsh); an update
 *   keeps it, since it names the same program.
 * - Linux: an XDG autostart entry, `$XDG_CONFIG_HOME/autostart/dev.intentic.desktop.desktop` (`~/.config` without the
 *   variable), naming this program, or the AppImage it runs from (`$APPIMAGE`, since the program itself is unpacked
 *   somewhere new at each start). Removing the package leaves it, as any per-user file; the desktop skips an entry whose
 *   program is gone.
 *
 * The row's tick is what the registry or the file says, read again after every press, never what the press meant. */

use std::path::{Path, PathBuf};

use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Wry};

/// What the entry starts this app with beside its own path: a launch at sign-in, which opens no window (lib.rs). Nothing
/// reads it as a path: a launch's arguments are files to open only when they do not start with `-` (local.rs `arg_path`).
pub const ARG: &str = "--background";

/// The tray's row, ticked as the system has it.
pub struct TrayLogin(pub CheckMenuItem<Wry>);

/// The menu id lib.rs `create_tray` routes here.
pub const ROW: &str = "login";

/// The Run value's name.
#[cfg_attr(not(windows), allow(dead_code))]
const VALUE: &str = "Intentic";

/// The Run value's command line: the app's own path, quoted (it has spaces on every ordinary install, and Windows hands
/// the value to the shell as a command line), then [`ARG`].
#[cfg_attr(not(windows), allow(dead_code))]
pub fn command_line(exe: &Path) -> String {
    format!("\"{}\" {ARG}", exe.display())
}

/// `reg.exe`'s arguments for the value: written, taken away, or asked about.
#[cfg_attr(not(windows), allow(dead_code))]
fn reg_args(verb: RegVerb<'_>) -> Vec<String> {
    let run = crate::resume::RUN;
    let args: &[&str] = match verb {
        RegVerb::Add(command) => &["add", run, "/v", VALUE, "/t", "REG_SZ", "/d", command, "/f"],
        RegVerb::Delete => &["delete", run, "/v", VALUE, "/f"],
        RegVerb::Query => &["query", run, "/v", VALUE],
    };
    args.iter().map(|arg| (*arg).to_string()).collect()
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy)]
enum RegVerb<'a> {
    Add(&'a str),
    Delete,
    Query,
}

/// The entry's file name: the app's identifier, as tauri.conf.json and its packages name it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const ENTRY: &str = "dev.intentic.desktop.desktop";

/// Where the autostart entry lives: `$XDG_CONFIG_HOME/autostart` when that is set to an absolute path (the spec ignores
/// anything else), `~/.config/autostart` otherwise. Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn entry_path(config_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    let config = match config_home.filter(|dir| dir.is_absolute()) {
        Some(dir) => dir.to_path_buf(),
        None => home?.join(".config"),
    };
    Some(config.join("autostart").join(ENTRY))
}

/// The `Exec` value for `exe`: the path as one quoted argument (escaping what the Desktop Entry spec says a quoted
/// argument escapes, then the backslash of the value itself, and `%` as `%%` so it is no field code), then [`ARG`]. A
/// path holding a line break or another control character cannot be written into the file at all. Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn exec_value(exe: &str) -> Option<String> {
    if exe.is_empty() || exe.chars().any(char::is_control) {
        return None;
    }
    let mut quoted = String::from("\"");
    for letter in exe.chars() {
        match letter {
            // The quoting rule's backslash, then the string rule's for that backslash: `\\` in the file.
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(letter);
            }
            '\\' => quoted.push_str("\\\\\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(letter),
        }
    }
    quoted.push('"');
    Some(format!("{quoted} {ARG}"))
}

/// The whole entry. Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_entry(exe: &str) -> Option<String> {
    Some(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Intentic\n\
         Comment=Intentic in the tray, started at login\n\
         Exec={}\n\
         Icon=intentic-desktop\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n",
        exec_value(exe)?
    ))
}

/// Whether an entry on disk starts the app: present, and not switched off the ways a desktop's own settings switch
/// one off in place (`Hidden=true`, GNOME's `X-GNOME-Autostart-enabled=false`). Pure.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn entry_starts(contents: &str) -> bool {
    !contents.lines().map(str::trim).any(|line| {
        matches!(
            line.replace(' ', "").as_str(),
            "Hidden=true" | "X-GNOME-Autostart-enabled=false"
        )
    })
}

/// Whether the system will start this app at the next sign-in. BLOCKING on Windows for one `reg.exe`.
#[cfg(windows)]
fn starts_at_login() -> bool {
    crate::resume::reg(&reg_args(RegVerb::Query)).is_ok()
}

#[cfg(windows)]
fn set_start_at_login(on: bool) -> Result<(), String> {
    if !on {
        return crate::resume::reg(&reg_args(RegVerb::Delete));
    }
    let exe = std::env::current_exe()
        .map_err(|error| format!("could not work out where this app lives: {error}"))?;
    crate::resume::reg(&reg_args(RegVerb::Add(&command_line(&exe))))
}

#[cfg(target_os = "linux")]
fn linux_entry_path() -> Option<PathBuf> {
    let config_home = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    entry_path(config_home.as_deref(), home.as_deref())
}

#[cfg(target_os = "linux")]
fn starts_at_login() -> bool {
    linux_entry_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|contents| entry_starts(&contents))
}

#[cfg(target_os = "linux")]
fn set_start_at_login(on: bool) -> Result<(), String> {
    let path = linux_entry_path().ok_or("no home folder to keep an autostart entry in")?;
    if !on {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("{}: {error}", path.display()))
            }
            _ => Ok(()),
        };
    }
    // An AppImage's program is unpacked somewhere new at every start; the file it came from is what to start.
    let exe = match std::env::var_os("APPIMAGE").filter(|path| !path.is_empty()) {
        Some(image) => PathBuf::from(image),
        None => std::env::current_exe()
            .map_err(|error| format!("could not work out where this app lives: {error}"))?,
    };
    let entry = desktop_entry(&exe.to_string_lossy())
        .ok_or_else(|| format!("{} cannot be written into an entry", exe.display()))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    }
    std::fs::write(&path, entry).map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn starts_at_login() -> bool {
    false
}

#[cfg(not(any(windows, target_os = "linux")))]
fn set_start_at_login(_on: bool) -> Result<(), String> {
    Err("starting at login is not offered here".to_string())
}

/// Tick the row as the system has it, off the calling thread (`reg.exe` on Windows).
pub fn refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let on = starts_at_login();
        if let Some(row) = app.try_state::<TrayLogin>() {
            let _ = row.0.set_checked(on);
        }
    });
}

/// "Start Intentic at login" was pressed: the opposite of what the system has now, then the row ticked as it has it
/// after, whatever the menu already drew for the press.
pub fn pressed(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = set_start_at_login(!starts_at_login()) {
            eprintln!("intentic: starting at login could not be changed: {error}");
        }
        let on = starts_at_login();
        if let Some(row) = app.try_state::<TrayLogin>() {
            let _ = row.0.set_checked(on);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_run_value_starts_this_app_quoted_and_into_the_tray() {
        assert_eq!(
            command_line(Path::new(
                r"C:\Users\Ann Smith\AppData\Local\Intentic\intentic-desktop.exe"
            )),
            r#""C:\Users\Ann Smith\AppData\Local\Intentic\intentic-desktop.exe" --background"#
        );
        // Never a path to open: a launch's arguments are files only when they do not start with `-`.
        assert!(ARG.starts_with('-'));
        assert_ne!(ARG, crate::resume::ARG);
    }

    #[test]
    fn the_run_value_is_its_own_beside_the_setups_resume_entry() {
        let command = r#""C:\a b\intentic-desktop.exe" --background"#;
        assert_eq!(
            reg_args(RegVerb::Add(command)),
            [
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Intentic",
                "/t",
                "REG_SZ",
                "/d",
                command,
                "/f",
            ]
        );
        assert_eq!(
            reg_args(RegVerb::Delete),
            [
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Intentic",
                "/f",
            ]
        );
        assert_eq!(
            reg_args(RegVerb::Query),
            [
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Intentic",
            ]
        );
    }

    #[test]
    fn the_entry_lives_in_the_xdg_autostart_folder() {
        assert_eq!(
            entry_path(
                Some(Path::new("/home/ann/.cfg")),
                Some(Path::new("/home/ann"))
            ),
            Some(PathBuf::from(
                "/home/ann/.cfg/autostart/dev.intentic.desktop.desktop"
            ))
        );
        assert_eq!(
            entry_path(None, Some(Path::new("/home/ann"))),
            Some(PathBuf::from(
                "/home/ann/.config/autostart/dev.intentic.desktop.desktop"
            ))
        );
        // A relative XDG_CONFIG_HOME is one the spec says to ignore.
        assert_eq!(
            entry_path(Some(Path::new("cfg")), Some(Path::new("/home/ann"))),
            Some(PathBuf::from(
                "/home/ann/.config/autostart/dev.intentic.desktop.desktop"
            ))
        );
        assert_eq!(entry_path(None, None), None);
    }

    #[test]
    fn the_entry_starts_this_program_quoted_and_into_the_tray() {
        assert_eq!(
            exec_value("/usr/bin/intentic-desktop").as_deref(),
            Some(r#""/usr/bin/intentic-desktop" --background"#)
        );
        assert_eq!(
            exec_value("/home/ann/Apps/Intentic 1.2.AppImage").as_deref(),
            Some(r#""/home/ann/Apps/Intentic 1.2.AppImage" --background"#)
        );
        // What the spec escapes inside quotes, written as the file must hold it, and a `%` that is no field code.
        assert_eq!(
            exec_value(r#"/opt/a"b$c`d\e%f"#).as_deref(),
            Some(r#""/opt/a\\"b\\$c\\`d\\\\e%%f" --background"#)
        );
        assert_eq!(exec_value("/opt/two\nlines"), None);
        assert_eq!(exec_value(""), None);
        let entry = desktop_entry("/usr/bin/intentic-desktop").unwrap();
        assert!(entry.starts_with("[Desktop Entry]\n"), "{entry}");
        assert!(
            entry.contains("\nExec=\"/usr/bin/intentic-desktop\" --background\n"),
            "{entry}"
        );
        assert!(entry_starts(&entry));
    }

    /// The tick is what the file says: an entry a desktop's own settings switched off in place does not start the app.
    #[test]
    fn an_entry_switched_off_in_place_does_not_count() {
        let entry = desktop_entry("/usr/bin/intentic-desktop").unwrap();
        assert!(!entry_starts(&format!("{entry}Hidden=true\n")));
        assert!(!entry_starts(&entry.replace(
            "X-GNOME-Autostart-enabled=true",
            "X-GNOME-Autostart-enabled=false"
        )));
        assert!(entry_starts(&format!("{entry}Hidden=false\n")));
    }
}
