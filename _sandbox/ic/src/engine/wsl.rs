use std::process::{Command, Stdio}; // Command used in listed_distros
use std::time::Duration;

/// Decode UTF-16LE bytes (NUL-terminated lines) from `wsl.exe -l -q`.
pub fn decode_utf16le(bytes: &[u8]) -> String {
    let mut units = Vec::new();
    for chunk in bytes.as_chunks::<2>().0 {
        let unit = u16::from_le_bytes([chunk[0], chunk[1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    String::from_utf16_lossy(&units)
}

/// Distro names from `wsl.exe -l -q` (quiet, no banner), one per line.
pub fn listed_distros() -> Result<Vec<String>, String> {
    let output = Command::new("wsl.exe")
        .args(["-l", "-q"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("wsl.exe -l -q: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = decode_utf16le(&output.stdout);
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.trim_start_matches('\u{feff}').to_string())
        .collect())
}

/// The distros running now (`wsl.exe -l --running -q`); none when WSL says there are none or cannot say.
pub fn running_distros() -> Vec<String> {
    let Ok(output) = Command::new("wsl.exe")
        .args(["-l", "--running", "-q"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    decode_utf16le(&output.stdout)
        .lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

pub fn distro_installed(name: &str) -> bool {
    listed_distros()
        .map(|names| names.iter().any(|listed| listed.eq_ignore_ascii_case(name)))
        .unwrap_or(false)
}

/// `wsl.exe <args>`, bounded. wsl.exe's own messages (a distro that will not start, a service error) come as UTF-16LE,
/// whose NULs are dropped here so they read as text. A call the WSL service timed out on never reached the distro, and
/// is made once more (measured on rog, 2026-10-10: one `--exec` of several in a row answered
/// `Wsl/Service/WSAETIMEDOUT` while the PC's WSL was busy, and the same call a moment later ran).
pub fn run_wsl(args: &[&str], limit: Duration) -> Result<(i32, String, String), String> {
    let run = || -> Result<(i32, String, String), String> {
        let output = crate::docker::run_bounded("wsl.exe", args, limit).map_err(|fail| fail.0)?;
        Ok((
            output.code.unwrap_or(-1),
            without_nuls(output.stdout),
            without_nuls(output.stderr),
        ))
    };
    let first = run()?;
    if first.0 != 0 && service_timed_out(&first.1, &first.2) {
        std::thread::sleep(Duration::from_secs(2));
        return run();
    }
    Ok(first)
}

fn without_nuls(text: String) -> String {
    if text.contains('\0') {
        text.replace('\0', "")
    } else {
        text
    }
}

/// Whether wsl.exe said its service timed out before the command ran. Pure.
pub fn service_timed_out(stdout: &str, stderr: &str) -> bool {
    [stdout, stderr]
        .iter()
        .any(|said| said.contains("Wsl/Service/WSAETIMEDOUT"))
}

/// Keeper command line `ic engine start` spawns (hidden, detached).
pub fn keeper_argv(distro: &str, port: u16) -> Vec<String> {
    vec![
        "wsl.exe".into(),
        "-d".into(),
        distro.into(),
        "-u".into(),
        "root".into(),
        "--exec".into(),
        "/usr/local/bin/intentic-engine".into(),
        port.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16le_decodes_wsl_list_shape() {
        let mut bytes = Vec::new();
        for unit in "intentic-engine\0docker-desktop\0".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let text = decode_utf16le(&bytes);
        assert!(text.contains("intentic-engine"));
    }

    #[test]
    fn wsl_messages_read_as_text_and_a_service_timeout_is_told_apart() {
        let said = without_nuls("E\0r\0r\0o\0r\0 \0c\0o\0d\0e\0".to_string());
        assert_eq!(said, "Error code");
        assert!(service_timed_out(
            "",
            "A connection attempt failed\nError code: Wsl/Service/WSAETIMEDOUT"
        ));
        assert!(!service_timed_out("", "cat: /x: No such file or directory"));
    }

    #[test]
    fn keeper_argv_names_distro_and_entry() {
        let argv = keeper_argv(super::super::DISTRO, 2378);
        assert_eq!(argv[0], "wsl.exe");
        assert!(argv.contains(&"-d".to_string()));
        assert!(argv.contains(&"-u".to_string()));
        assert!(argv.contains(&"root".to_string()));
        assert!(argv.contains(&super::super::DISTRO.to_string()));
        assert!(argv.contains(&"/usr/local/bin/intentic-engine".to_string()));
    }
}
