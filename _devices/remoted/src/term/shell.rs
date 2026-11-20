//! Which program a person's terminal runs, and where. Windows: PowerShell 7 (`pwsh`) where it is installed, else Windows
//! PowerShell; `cmd` when asked for; `wsl.exe -d <distro>` for a `wsl:<distro>` environment. Linux: the user's login
//! shell, or another one `/etc/shells` lists when asked for by name.

#[cfg(not(windows))]
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::environments::Environment;

/// Why a terminal cannot be opened as asked: said to the daemon as a 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal(pub String);

/// A terminal's program, its working folder and its name in the list.
pub struct Launch {
    pub command: CommandBuilder,
    pub title: String,
}

/// The program a terminal opens with: `shell` is the daemon's ask (`pwsh`, `powershell`, `cmd` on Windows; a shell's
/// name or path from `/etc/shells` on Linux), `cwd` where it starts (the home folder when absent or not a folder).
pub fn launch(
    environment: &Environment,
    shell: Option<&str>,
    cwd: Option<&str>,
) -> Result<Launch, Refusal> {
    let mut launch = match environment {
        Environment::Native => native(shell, cwd)?,
        Environment::Wsl(distro) => wsl(distro, shell, cwd)?,
    };
    // A person's shell, not an agent's: the keyring's hint must not ride along from the agent that started remoted.
    launch.command.env_remove("INTENTIC_AGENT_COMMAND");
    Ok(launch)
}

fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from).filter(|path| path.is_dir())
}

// The folder asked for when it is one, else home.
fn start_in(cwd: Option<&str>) -> Option<PathBuf> {
    cwd.map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(home)
}

/// The first `name` on PATH (with PATHEXT's extensions on Windows), as a program would be found.
pub fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        candidate.is_file().then_some(candidate)
    })
}

#[cfg(windows)]
fn native(shell: Option<&str>, cwd: Option<&str>) -> Result<Launch, Refusal> {
    let pwsh = || {
        on_path("pwsh.exe").or_else(|| {
            std::env::var_os("ProgramFiles")
                .map(|dir| {
                    Path::new(&dir)
                        .join("PowerShell")
                        .join("7")
                        .join("pwsh.exe")
                })
                .filter(|path| path.is_file())
        })
    };
    let (program, args, title): (PathBuf, &[&str], &str) = match shell {
        None => match pwsh() {
            Some(path) => (path, &["-NoLogo"], "pwsh"),
            None => (PathBuf::from("powershell.exe"), &["-NoLogo"], "powershell"),
        },
        Some("pwsh") => (
            pwsh().ok_or_else(|| {
                Refusal("PowerShell 7 (pwsh) is not installed on this computer".into())
            })?,
            &["-NoLogo"],
            "pwsh",
        ),
        Some("powershell") => (PathBuf::from("powershell.exe"), &["-NoLogo"], "powershell"),
        Some("cmd") => (PathBuf::from("cmd.exe"), &[], "cmd"),
        Some(other) => {
            return Err(Refusal(format!(
                "{other:?} is not a shell here: ask for pwsh, powershell or cmd"
            )));
        }
    };
    let mut command = CommandBuilder::new(program.as_os_str());
    command.args(args);
    if let Some(dir) = start_in(cwd) {
        command.cwd(dir.as_os_str());
    }
    Ok(Launch {
        command,
        title: title.to_owned(),
    })
}

#[cfg(windows)]
fn wsl(distro: &str, shell: Option<&str>, cwd: Option<&str>) -> Result<Launch, Refusal> {
    if let Some(shell) = shell {
        return Err(Refusal(format!(
            "a WSL terminal opens the distro's own login shell; {shell:?} cannot be chosen"
        )));
    }
    let mut command = CommandBuilder::new("wsl.exe");
    command.args(["-d", distro, "--cd"]);
    // A Linux path is the distro's; anything else starts in the distro user's home.
    match cwd {
        Some(dir) if dir.starts_with('/') => command.arg(dir),
        _ => command.arg("~"),
    }
    if let Some(dir) = home() {
        command.cwd(dir.as_os_str());
    }
    Ok(Launch {
        command,
        title: distro.to_owned(),
    })
}

#[cfg(not(windows))]
fn native(shell: Option<&str>, cwd: Option<&str>) -> Result<Launch, Refusal> {
    let mut command = match shell {
        // The user's login shell, run as one (argv0 `-bash`): $SHELL, else the password database.
        None => CommandBuilder::new_default_prog(),
        Some(asked) => {
            let path = listed_shell(asked, &read_etc_shells()).ok_or_else(|| {
                Refusal(format!(
                    "{asked:?} is not a shell /etc/shells lists on this computer"
                ))
            })?;
            let mut command = CommandBuilder::new(path.as_os_str());
            command.arg("-l");
            command
        }
    };
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(dir) = start_in(cwd) {
        command.cwd(dir.as_os_str());
    }
    let title = match shell {
        Some(asked) => basename(asked),
        None => basename(&command.get_shell()),
    };
    Ok(Launch { command, title })
}

#[cfg(not(windows))]
fn wsl(_distro: &str, _shell: Option<&str>, _cwd: Option<&str>) -> Result<Launch, Refusal> {
    Err(Refusal("WSL terminals open only on Windows".into()))
}

#[cfg(not(windows))]
fn read_etc_shells() -> String {
    std::fs::read_to_string("/etc/shells").unwrap_or_default()
}

/// The `/etc/shells` entry `asked` names: the path itself, or an entry's file name.
pub fn listed_shell(asked: &str, etc_shells: &str) -> Option<PathBuf> {
    etc_shells
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('/'))
        .find(|line| {
            *line == asked
                || Path::new(line).file_name().and_then(|name| name.to_str()) == Some(asked)
        })
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

#[cfg(not(windows))]
fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(OsString::from)
        .and_then(|name| name.into_string().ok())
        .unwrap_or_else(|| path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_shell_is_found_by_its_path_or_its_name_and_only_where_etc_shells_lists_it() {
        let listed = "# comment\n/bin/sh\n/usr/bin/sh\n";
        assert_eq!(listed_shell("sh", listed), Some(PathBuf::from("/bin/sh")));
        assert_eq!(
            listed_shell("/usr/bin/sh", listed),
            Some(PathBuf::from("/usr/bin/sh"))
        );
        assert_eq!(listed_shell("python3", listed), None);
        assert_eq!(listed_shell("/bin/sh -c id", listed), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_linux_terminal_refuses_a_wsl_environment() {
        let refused = launch(&Environment::Wsl("Ubuntu".into()), None, None).err();
        assert_eq!(
            refused,
            Some(Refusal("WSL terminals open only on Windows".into()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_terminal_names_its_shell_and_refuses_an_unknown_one() {
        let launched = launch(&Environment::Native, Some("cmd"), None)
            .ok()
            .unwrap();
        assert_eq!(launched.title, "cmd");
        assert!(launch(&Environment::Native, Some("bash"), None).is_err());
        let wsl = launch(&Environment::Wsl("Ubuntu".into()), None, Some("/tmp"))
            .ok()
            .unwrap();
        assert_eq!(wsl.title, "Ubuntu");
        let argv: Vec<String> = wsl
            .command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv, ["wsl.exe", "-d", "Ubuntu", "--cd", "/tmp"]);
    }
}
