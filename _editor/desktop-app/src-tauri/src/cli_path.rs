//! `intentic .` IN A TERMINAL, FINISHED BY THE APP WHEN THE INSTALLER COULD NOT.
//!
//! The installer puts the install's `bin` folder on the user's PATH (installer-hooks.nsh `INTENTIC_CLI_PATH`), through
//! PowerShell, under a one-minute limit. On a busy PC PowerShell can take longer than that just to start: the install
//! then said "completed successfully" with the command missing and nothing to put it back (2026-10-12, a laptop loaded
//! by CI jobs). Now the installer leaves `cli-path-pending` in this app's config folder when that step fails, and the
//! app adds the folder at its next launch and removes the marker. Only then: a PATH the reader edits by hand later is
//! theirs, and is not rewritten at every launch.

use tauri::AppHandle;

/// Left by the installer when it could not put the folder on PATH; removed once the app has.
#[cfg_attr(not(windows), allow(dead_code))]
const PENDING: &str = "cli-path-pending";

/// Finish what the installer left, off the launch's own thread (a registry write and a settings broadcast).
pub fn finish_pending(app: &AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let Ok(dir) = app.path().app_config_dir() else {
            return;
        };
        let marker = dir.join(PENDING);
        if !marker.is_file() {
            return;
        }
        std::thread::spawn(move || match add_install_bin() {
            Ok(()) => {
                let _ = std::fs::remove_file(&marker);
            }
            // Kept for the next launch to try again.
            Err(error) => eprintln!("intentic: the terminal command is still not on PATH: {error}"),
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// The install's `bin` folder onto the user's PATH. A copy with no launchers beside it (a development run) has
/// nothing to add, which counts as done.
#[cfg(windows)]
fn add_install_bin() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| format!("where this app is: {error}"))?;
    let Some(folder) = exe.parent() else {
        return Ok(());
    };
    let bin = folder.join("bin");
    if !bin.join("intentic.cmd").is_file() {
        return Ok(());
    }
    registry::add_to_user_path(&bin.to_string_lossy())
}

/// The user's PATH with `dir` added as an entry of its own, or `None` when it is already there. The same rule as the
/// installer's PowerShell: whole entries, compared without case (Windows paths), and a trailing `;` not doubled. A
/// trailing `\` and surrounding spaces do not make a different entry.
#[cfg_attr(not(windows), allow(dead_code))]
fn with_entry(current: &str, dir: &str) -> Option<String> {
    let same = |entry: &str| {
        entry
            .trim()
            .trim_end_matches('\\')
            .eq_ignore_ascii_case(dir.trim().trim_end_matches('\\'))
    };
    if current.split(';').any(same) {
        return None;
    }
    let kept = current.trim_end_matches(';');
    Some(if kept.trim().is_empty() {
        dir.to_string()
    } else {
        format!("{kept};{dir}")
    })
}

/// HKCU\Environment\Path, read and written unexpanded and under the kind it already has, so `%USERPROFILE%`-style
/// entries keep expanding; then the broadcast the Control Panel's editor sends, so a terminal started afterwards sees it.
#[cfg(windows)]
mod registry {
    use windows::core::w;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, LPARAM, WPARAM};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    pub fn add_to_user_path(dir: &str) -> Result<(), String> {
        let mut opened = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                w!("Environment"),
                None,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                &mut opened,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("open HKCU\\Environment: error {}", status.0));
        }
        let key = Key(opened);
        let (current, kind) = read_path(&key)?;
        let Some(value) = super::with_entry(&current, dir) else {
            return Ok(());
        };
        let mut wide: Vec<u16> = value.encode_utf16().collect();
        wide.push(0);
        let bytes =
            unsafe { std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2) };
        let status = unsafe { RegSetValueExW(key.0, w!("Path"), None, kind, Some(bytes)) };
        if status != ERROR_SUCCESS {
            return Err(format!("write PATH: error {}", status.0));
        }
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(w!("Environment").as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                5000,
                None,
            );
        }
        Ok(())
    }

    /// The value and its kind; no value yet is an empty PATH of the kind Windows gives a new one.
    fn read_path(key: &Key) -> Result<(String, REG_VALUE_TYPE), String> {
        let mut kind = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                w!("Path"),
                None,
                Some(&mut kind),
                None,
                Some(&mut size),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok((String::new(), REG_EXPAND_SZ));
        }
        if status != ERROR_SUCCESS {
            return Err(format!("read PATH: error {}", status.0));
        }
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            return Err(format!("PATH is not text (registry kind {})", kind.0));
        }
        let mut wide = vec![0u16; (size as usize).div_ceil(2)];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                w!("Path"),
                None,
                Some(&mut kind),
                Some(wide.as_mut_ptr().cast::<u8>()),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("read PATH: error {}", status.0));
        }
        wide.truncate(size as usize / 2);
        while wide.last() == Some(&0) {
            wide.pop();
        }
        Ok((String::from_utf16_lossy(&wide), kind))
    }
}

#[cfg(test)]
mod tests {
    use super::with_entry;

    const DIR: &str = r"C:\Users\a\AppData\Local\Intentic\bin";

    #[test]
    fn appends_to_a_path_that_lacks_it() {
        assert_eq!(
            with_entry(r"%USERPROFILE%\bin;C:\tools", DIR).as_deref(),
            Some(r"%USERPROFILE%\bin;C:\tools;C:\Users\a\AppData\Local\Intentic\bin")
        );
    }

    #[test]
    fn does_not_double_a_trailing_separator() {
        assert_eq!(
            with_entry(r"C:\tools;", DIR).as_deref(),
            Some(r"C:\tools;C:\Users\a\AppData\Local\Intentic\bin")
        );
    }

    #[test]
    fn an_empty_path_becomes_the_folder() {
        assert_eq!(with_entry("", DIR).as_deref(), Some(DIR));
        assert_eq!(with_entry(";", DIR).as_deref(), Some(DIR));
    }

    #[test]
    fn leaves_a_path_that_has_it_whatever_its_case_or_trailing_backslash() {
        assert_eq!(with_entry(&format!(r"C:\tools;{DIR}"), DIR), None);
        assert_eq!(
            with_entry(&format!(r"{}\;C:\tools", DIR.to_uppercase()), DIR),
            None
        );
    }

    #[test]
    fn a_longer_entry_is_not_the_folder() {
        assert!(with_entry(&format!(r"{DIR}\sub"), DIR).is_some());
    }
}
