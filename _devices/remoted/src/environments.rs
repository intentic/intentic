//! Where on this computer a terminal can open: `native` (this environment's own shell) and, on Windows, `wsl:<distro>`
//! for each WSL distro a person can enter through `wsl.exe -d <distro>` from here. A distro whose own machine agent runs
//! a remoted of its own (a Linux one) is served by that one, as its `native`: the sandbox leaves such a distro out of
//! this list and refuses it here (`_sandbox/sandbox/src/hosts/remote/remote-environments.ts`), so `wsl.exe -d` serves
//! only a distro with no agent.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// This environment's own shell.
pub const NATIVE: &str = "native";

/// The prefix a WSL distro's environment is named with.
pub const WSL_PREFIX: &str = "wsl:";

// Listing distros starts wsl.exe; a person opening terminals does not need a fresh answer every time.
const KEEP_FOR: Duration = Duration::from_secs(60);

// wsl.exe answers within a second when WSL is installed; past this something is wedged and the list is empty for now.
#[cfg(windows)]
const ASK_PATIENCE: Duration = Duration::from_secs(10);

/// An environment by its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Environment {
    Native,
    Wsl(String),
}

impl Environment {
    pub fn parse(name: &str) -> Option<Self> {
        if name == NATIVE {
            return Some(Self::Native);
        }
        let distro = name.strip_prefix(WSL_PREFIX)?;
        valid_distro(distro).then(|| Self::Wsl(distro.to_owned()))
    }

    pub fn name(&self) -> String {
        match self {
            Self::Native => NATIVE.to_owned(),
            Self::Wsl(distro) => format!("{WSL_PREFIX}{distro}"),
        }
    }
}

// What WSL accepts as a distro name, and nothing a command line could read as more than one argument.
fn valid_distro(name: &str) -> bool {
    name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// Docker Desktop's own distros hold no shell a person would open.
fn listed(name: &str) -> bool {
    valid_distro(name) && !name.starts_with("docker-desktop")
}

/// wsl.exe's `--list --quiet`, which it writes in UTF-16LE whatever the console says: one distro a line.
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.len() >= 2
        && bytes.len().is_multiple_of(2)
        && bytes.iter().skip(1).step_by(2).all(|b| *b == 0)
    {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|line| listed(line))
        .map(str::to_owned)
        .collect()
}

static KEPT: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

/// Every environment a terminal can open in here, `native` first.
pub async fn list() -> Vec<String> {
    if let Some((at, kept)) = KEPT.lock().expect("environments poisoned").as_ref()
        && at.elapsed() < KEEP_FOR
    {
        return kept.clone();
    }
    let mut names = vec![NATIVE.to_owned()];
    names.extend(
        distros()
            .await
            .into_iter()
            .map(|distro| format!("{WSL_PREFIX}{distro}")),
    );
    *KEPT.lock().expect("environments poisoned") = Some((Instant::now(), names.clone()));
    names
}

#[cfg(windows)]
async fn distros() -> Vec<String> {
    // CREATE_NO_WINDOW: remoted has no console, and wsl.exe would otherwise get one of its own on the person's screen.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let asked = tokio::process::Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(ASK_PATIENCE, asked).await {
        Ok(Ok(output)) if output.status.success() => parse_wsl_list(&output.stdout),
        // No WSL, or none installed: no distros, said by the empty list.
        _ => Vec::new(),
    }
}

#[cfg(not(windows))]
async fn distros() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn wsls_utf16_list_reads_without_docker_desktops_own() {
        let listed =
            utf16("archlinux\r\nUbuntu-24.04\r\ndocker-desktop\r\ndocker-desktop-data\r\n\r\n");
        assert_eq!(parse_wsl_list(&listed), ["archlinux", "Ubuntu-24.04"]);
        // An older wsl.exe, or one whose output was redirected through a code page, wrote it plainly.
        assert_eq!(
            parse_wsl_list(b"Debian\nkali-linux\n"),
            ["Debian", "kali-linux"]
        );
    }

    #[test]
    fn an_environment_reads_back_by_its_name_and_nothing_else_does() {
        assert_eq!(Environment::parse("native"), Some(Environment::Native));
        assert_eq!(
            Environment::parse("wsl:Ubuntu-24.04"),
            Some(Environment::Wsl("Ubuntu-24.04".into()))
        );
        assert_eq!(Environment::parse("wsl:"), None);
        assert_eq!(Environment::parse("wsl:a b"), None);
        assert_eq!(Environment::parse("wsl:-d x"), None);
        assert_eq!(Environment::parse("wsl:--exec"), None);
        assert_eq!(Environment::parse("macos"), None);
        assert_eq!(Environment::Wsl("Debian".into()).name(), "wsl:Debian");
    }
}
