use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("`{command}` failed: {stderr}")]
    Command { command: String, stderr: String },
    #[error("{0}")]
    Setup(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Which container runtime executes `docker …` for us. Every operation goes through one of these,
/// so the sandbox lifecycle is identical on a Linux host, Docker Desktop, and the managed WSL distro.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Engine {
    /// `docker` on PATH (Linux daemon or Docker Desktop). `viaSg` routes every call through
    /// `sg docker -c …` for the just-added-to-group-but-not-relogged-in case on Linux.
    HostDocker { via_sg: bool },
    /// `wsl.exe -d <distro> -u root --exec docker …` against the managed distro's own dockerd.
    Wsl { distro: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckId {
    DockerInstalled,
    DockerRunning,
    DockerPermission,
    DockerDesktop,
    Wsl,
    MachineDistro,
    MachineDocker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckState {
    Ok,
    /// The app can fix this itself (may prompt for elevation).
    Fixable,
    /// Needs the user's hands (BIOS virtualization, reboot, log out) — `detail` says exactly what.
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: CheckId,
    pub title: String,
    pub state: CheckState,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentReport {
    pub os: String,
    pub checks: Vec<Check>,
    /// The engine all sandbox operations will use once `ready` — present as soon as probing can tell.
    pub engine: Option<Engine>,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum FixOutcome {
    Fixed,
    /// The fix applied but Windows must restart before WSL works — persist and resume after.
    RebootRequired,
    Manual {
        instructions: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupMode {
    /// Platform-provisioned tunnel under intentic's zone (zero-config default).
    Intentic,
    /// User's own Cloudflare: the app provisions the tunnel like connect.sh does.
    Own,
    /// No tunnel: ports on 127.0.0.1, `SANDBOX_PUBLIC_URL=http://127.0.0.1:8787` announced.
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    /// Platform origin the setup code is claimed against (and the daemon announces to).
    pub platform_url: String,
    pub code: String,
    pub mode: SetupMode,
    /// Display name of the sandbox (rides from the SPA for the manager UI; not part of the claim).
    pub name: Option<String>,
    /// Own-Cloudflare only: rides into the tunnel-provision container and the sandbox env.
    pub cf_token: Option<String>,
    /// Tunnel modes only: also enroll the desktop sync agent into this folder after boot.
    pub sync_dir: Option<String>,
    /// Override the sandbox image (dev: `intentic-sandbox:dev`).
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRecord {
    pub slug: String,
    pub name: Option<String>,
    pub mode: SetupMode,
    /// The URL the daemon announced (tunnel https URL, or the loopback URL in local mode).
    pub url: String,
    pub container: String,
    /// Single-use desktop-sync pairing token from the claim — consumed by the shell right after
    /// setup, never serialized to the UI.
    #[serde(skip)]
    pub sync_pair_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    pub slug: String,
    pub container: String,
    pub running: bool,
    pub image: String,
    pub url: Option<String>,
    pub name: Option<String>,
    /// None when the sandbox is local-only (no cloudflared sidecar exists).
    pub tunnel_running: Option<bool>,
}
