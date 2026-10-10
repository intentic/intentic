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

pub fn distro_installed(name: &str) -> bool {
    listed_distros()
        .map(|names| names.iter().any(|listed| listed.eq_ignore_ascii_case(name)))
        .unwrap_or(false)
}

pub fn run_wsl(args: &[&str], limit: Duration) -> Result<(i32, String, String), String> {
    let output = crate::docker::run_bounded("wsl.exe", args, limit).map_err(|fail| fail.0)?;
    let code = output.code.unwrap_or(-1);
    Ok((code, output.stdout, output.stderr))
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
