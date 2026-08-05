#![cfg(unix)]

use std::process::{Command, Stdio};

use crate::util::{bail, Result};

/* Wiring a Linux machine as a deploy target — the root-side system mutations connect.sh's SELF_HOST=1 and
 * connect-host.sh share: a dedicated service user in the docker group with a generated SSH key, an sshd to
 * reach it through, /opt/intentic for provider state, a native cloudflared connector. Everything here is
 * idempotent — an existing user/key is reused so re-runs don't churn the key the platform pins.
 *
 * Root is obtained as the scripts obtained it: already-root, else passwordless `sudo -n` — never an
 * interactive sudo prompt from inside a flow the user believes is unprivileged. */

pub struct Root {
    prefix: Vec<String>,
}

impl Root {
    pub fn acquire(purpose: &str) -> Result<Root> {
        if crate::docker::is_root() {
            return Ok(Root { prefix: Vec::new() });
        }
        let passwordless = Command::new("sudo")
            .args(["-n", "true"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if passwordless {
            return Ok(Root {
                prefix: vec!["sudo".to_string(), "-n".to_string()],
            });
        }
        bail!("{purpose} needs root — re-run as root (sudo -i) or enable passwordless sudo.");
    }

    fn command(&self, program: &str) -> Command {
        match self.prefix.first() {
            Some(sudo) => {
                let mut cmd = Command::new(sudo);
                cmd.args(&self.prefix[1..]);
                cmd.arg(program);
                cmd
            }
            None => Command::new(program),
        }
    }

    /// Run, all streams quiet; false on failure — the `$SUDO cmd >/dev/null 2>&1 || true` shape.
    pub fn quiet(&self, program: &str, args: &[&str]) -> bool {
        self.command(program)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// Run with output surfaced; Err on failure.
    pub fn run(&self, program: &str, args: &[&str]) -> Result<()> {
        let status = self
            .command(program)
            .args(args)
            .status()
            .map_err(|err| crate::util::Fail(format!("could not run {program}: {err}")))?;
        if !status.success() {
            bail!("{program} {} failed", args.join(" "));
        }
        Ok(())
    }

    pub fn capture(&self, program: &str, args: &[&str]) -> Option<String> {
        let out = self
            .command(program)
            .args(args)
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    }

    /// Write `content` to a root-owned path — the `| $SUDO tee <path>` shape.
    pub fn write(&self, path: &str, content: &str) -> Result<()> {
        let mut child = self
            .command("tee")
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .map_err(|err| crate::util::Fail(format!("could not write {path}: {err}")))?;
        use std::io::Write;
        child
            .stdin
            .take()
            .expect("stdin was piped")
            .write_all(content.as_bytes())?;
        if !child.wait()?.success() {
            bail!("could not write {path}");
        }
        Ok(())
    }
}

/// Ensure an SSH server is installed and listening on :22. The sandbox reaches it through this host's own
/// Cloudflare tunnel (the connector dials localhost:22), so sshd need not be exposed on any interface.
pub fn ensure_sshd(root: &Root) -> Result<()> {
    let have_sshd = Command::new("sh")
        .args([
            "-c",
            "command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ]",
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !have_sshd {
        println!("intentic: installing OpenSSH server…");
        if root.quiet("sh", &["-c", "command -v apt-get"]) {
            root.quiet("apt-get", &["update", "-qq"]);
            root.run(
                "env",
                &[
                    "DEBIAN_FRONTEND=noninteractive",
                    "apt-get",
                    "install",
                    "-y",
                    "-qq",
                    "openssh-server",
                ],
            )?;
        } else if root.quiet("sh", &["-c", "command -v dnf"]) {
            root.run("dnf", &["install", "-y", "-q", "openssh-server"])?;
        } else if root.quiet("sh", &["-c", "command -v yum"]) {
            root.run("yum", &["install", "-y", "-q", "openssh-server"])?;
        } else if root.quiet("sh", &["-c", "command -v apk"]) {
            root.run("apk", &["add", "--no-cache", "openssh"])?;
        } else {
            bail!("no supported package manager (apt/dnf/yum/apk) to install openssh-server — install it and re-run.");
        }
    }
    // Host keys + the privilege-separation dir, then start sshd via whatever init is present.
    root.quiet("ssh-keygen", &["-A"]);
    root.quiet("mkdir", &["-p", "/run/sshd"]);
    if systemd_present() {
        if !root.quiet("systemctl", &["enable", "--now", "ssh"]) {
            root.quiet("systemctl", &["enable", "--now", "sshd"]);
        }
    } else if root.quiet("sh", &["-c", "command -v service"])
        && !root.quiet("service", &["ssh", "start"])
    {
        root.quiet("service", &["sshd", "start"]);
    }
    // Force a listener on hosts without an init system (e.g. WSL without systemd): launch sshd directly.
    if !sshd_listening() {
        root.quiet("/usr/sbin/sshd", &[]);
    }
    if !sshd_listening() {
        eprintln!("intentic: warning — sshd does not appear to be listening on :22; the sandbox may not be able to deploy here.");
    }
    Ok(())
}

fn sshd_listening() -> bool {
    Command::new("sh")
        .args([
            "-c",
            "(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':22 '",
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn systemd_present() -> bool {
    std::path::Path::new("/run/systemd/system").is_dir()
        && Command::new("sh")
            .args(["-c", "command -v systemctl"])
            .stdout(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
}

/// Create the deploy service user (docker group) + a stable ed25519 key, authorize it, hand /opt/intentic to
/// the user, and return the PRIVATE half (it rides into the sandbox as HOST_SSH_KEY). `key_comment`
/// distinguishes the two callers' keys on inspection (intentic-self-host vs intentic-host).
pub fn setup_service_user(root: &Root, user: &str, key_comment: &str) -> Result<String> {
    if !root.quiet("sh", &["-c", "command -v useradd"]) {
        bail!("useradd not found — intentic expects a standard Linux server (Debian/Ubuntu/RHEL).");
    }
    ensure_sshd(root)?;
    let user_exists = Command::new("id")
        .arg(user)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !user_exists {
        println!("intentic: creating service user '{user}'…");
        root.run("useradd", &["-m", "-s", "/bin/bash", user])?;
    }
    // The host provider runs `docker version` over SSH, so the user needs docker access; group membership
    // applies to the sandbox's fresh SSH sessions. A missing docker group is a soft warning, not fatal.
    if !root.quiet("usermod", &["-aG", "docker", user]) {
        eprintln!("intentic: warning — could not add '{user}' to the docker group.");
    }

    let home = Command::new("getent")
        .args(["passwd", user])
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .split(':')
                .nth(5)
                .unwrap_or("")
                .to_string()
        })
        .filter(|home| !home.is_empty())
        .unwrap_or_else(|| format!("/home/{user}"));
    let ssh_dir = format!("{home}/.ssh");
    let key = format!("{ssh_dir}/intentic_ed25519");
    let auth = format!("{ssh_dir}/authorized_keys");
    root.run("mkdir", &["-p", &ssh_dir])?;
    // Generate once; reuse on re-runs so HOST_SSH_KEY (and the platform-pinned host key) stay stable.
    if !root.quiet("test", &["-f", &key]) {
        println!("intentic: generating SSH key for '{user}'…");
        root.run(
            "ssh-keygen",
            &[
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                key_comment,
                "-f",
                &key,
                "-q",
            ],
        )?;
    }
    let public = root
        .capture("cat", &[&format!("{key}.pub")])
        .ok_or_else(|| crate::util::Fail(format!("could not read {key}.pub")))?;
    let authorized = root.capture("cat", &[&auth]).unwrap_or_default();
    if !authorized.lines().any(|line| line == public) {
        root.write(
            &auth,
            &format!(
                "{authorized}{}{public}\n",
                if authorized.is_empty() { "" } else { "\n" }
            ),
        )?;
    }
    root.run("chown", &["-R", &format!("{user}:{user}"), &ssh_dir])?;
    root.run("chmod", &["700", &ssh_dir])?;
    root.run("chmod", &["600", &auth])?;
    root.run("chmod", &["600", &key])?;

    // Every provider writes its host state (compose projects + .env, the apply lock, secrets.json,
    // backup/restic state) under /opt/intentic, over SSH as this unprivileged user. /opt is root-owned, so
    // the providers cannot create it themselves — hand the dir to the user here. 700: it holds secrets.
    root.run("mkdir", &["-p", "/opt/intentic"])?;
    root.run("chown", &[&format!("{user}:{user}"), "/opt/intentic"])?;
    root.run("chmod", &["700", "/opt/intentic"])?;

    root.capture("cat", &[&key])
        .ok_or_else(|| crate::util::Fail(format!("could not read the generated key {key}")))
}

/// Install the cloudflared binary natively. Native, not a container: under Docker Desktop a container's
/// localhost is the VM, so a containerized connector could not reach the host's sshd at localhost:22.
pub fn install_cloudflared(root: &Root, version: &str) -> Result<()> {
    if Command::new("sh")
        .args(["-c", "command -v cloudflared"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Ok(());
    }
    println!("intentic: installing cloudflared on this host…");
    let arch = Command::new("dpkg")
        .arg("--print-architecture")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .or_else(|| {
            Command::new("uname")
                .arg("-m")
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .unwrap_or_default();
    let cf_arch = match arch.as_str() {
        "amd64" | "x86_64" => "amd64",
        "arm64" | "aarch64" => "arm64",
        other => bail!(
            "unsupported architecture '{other}' for cloudflared; install it manually and re-run."
        ),
    };
    let url = format!("https://github.com/cloudflare/cloudflared/releases/download/{version}/cloudflared-linux-{cf_arch}");
    root.run(
        "sh",
        &[
            "-c",
            &format!("curl -fsSL '{url}' -o /usr/local/bin/cloudflared"),
        ],
    )?;
    root.run("chmod", &["+x", "/usr/local/bin/cloudflared"])?;
    Ok(())
}

/// Run the host SSH-tunnel connector. Prefer systemd for persistence (survives reboot); otherwise detached
/// (survives this flow but not a reboot — re-run the connect flow after one). `flow` names the re-run.
pub fn run_ssh_connector(root: &Root, token: &str, flow: &str) -> Result<()> {
    if systemd_present() {
        let unit = format!(
            "[Unit]\nDescription=intentic host SSH cloudflared connector\nAfter=network-online.target\nWants=network-online.target\n[Service]\nExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token {token}\nRestart=always\nRestartSec=5\n[Install]\nWantedBy=multi-user.target\n"
        );
        root.write(
            "/etc/systemd/system/intentic-host-ssh-tunnel.service",
            &unit,
        )?;
        root.run(
            "chmod",
            &[
                "600",
                "/etc/systemd/system/intentic-host-ssh-tunnel.service",
            ],
        )?;
        root.run("systemctl", &["daemon-reload"])?;
        root.run(
            "systemctl",
            &["enable", "--now", "intentic-host-ssh-tunnel.service"],
        )?;
    } else {
        root.quiet("pkill", &["-f", "cloudflared tunnel --no-autoupdate run"]);
        root.run("sh", &["-c", &format!("nohup cloudflared tunnel --no-autoupdate run --token '{token}' >/var/log/intentic-host-ssh-tunnel.log 2>&1 &")])?;
        eprintln!("intentic: the host SSH connector is running (detached; re-run {flow} after a reboot to restore it).");
    }
    Ok(())
}
