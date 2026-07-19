use std::ffi::OsStr;
use std::process::Command;

use crate::types::Engine;

/// The managed WSL distro every Windows machine without Docker Desktop gets.
pub const MACHINE_DISTRO: &str = "intentic-machine";

impl Engine {
    /// Build the `docker <args>` invocation for this engine. Callers pass the full docker argument
    /// list; the engine decides how it reaches a daemon.
    pub fn docker<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        match self {
            Engine::HostDocker { via_sg: false } => {
                let mut command = quiet(Command::new("docker"));
                command.args(args);
                command
            }
            // Fresh `usermod -aG docker` membership isn't in this process's groups until re-login;
            // `sg docker -c` grants the gid immediately because /etc/group already lists the user.
            Engine::HostDocker { via_sg: true } => {
                let mut line = String::from("docker");
                for arg in args {
                    line.push(' ');
                    line.push_str(&shell_escape(&arg.as_ref().to_string_lossy()));
                }
                let mut command = quiet(Command::new("sg"));
                command.args(["docker", "-c", &line]);
                command
            }
            Engine::Wsl { distro } => {
                let mut command = quiet(Command::new("wsl.exe"));
                command.args(["-d", distro, "-u", "root", "--exec", "docker"]);
                command.args(args);
                command
            }
        }
    }
}

/// Single-quote escaping for the `sg docker -c <line>` path.
pub fn shell_escape(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@,".contains(c))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Suppress the console window flash spawned processes cause on Windows GUI apps.
pub fn quiet(mut command: Command) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_docker_runs_docker_directly() {
        let command = Engine::HostDocker { via_sg: false }.docker(["ps", "-a"]);
        assert_eq!(command.get_program(), "docker");
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, ["ps", "-a"]);
    }

    #[test]
    fn sg_wraps_the_whole_docker_line() {
        let command = Engine::HostDocker { via_sg: true }.docker(["run", "-e", "A=b c"]);
        assert_eq!(command.get_program(), "sg");
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, ["docker", "-c", "docker run -e 'A=b c'"]);
    }

    #[test]
    fn wsl_prefixes_the_managed_distro() {
        let command = Engine::Wsl {
            distro: MACHINE_DISTRO.into(),
        }
        .docker(["info"]);
        assert_eq!(command.get_program(), "wsl.exe");
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            [
                "-d",
                "intentic-machine",
                "-u",
                "root",
                "--exec",
                "docker",
                "info"
            ]
        );
    }

    #[test]
    fn shell_escape_quotes_only_when_needed() {
        assert_eq!(shell_escape("plain-value_1:2"), "plain-value_1:2");
        assert_eq!(shell_escape("has space"), "'has space'");
        assert_eq!(shell_escape("it's"), r"'it'\''s'");
    }
}
