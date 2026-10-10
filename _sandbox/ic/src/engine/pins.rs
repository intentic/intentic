//! Pinned upstream versions for the intentic-engine rootfs and prefetch sizes. Keep in sync with `engine/pins.toml`.
#![cfg_attr(not(windows), allow(dead_code))]

pub const ENGINE_VERSION: &str = "1.2.0";

pub const DOCKER_CLI_VERSION: &str = "29.9.0";

pub const DOCKER_LINUX_URL: &str =
    "https://download.docker.com/linux/static/stable/x86_64/docker-29.9.0.tgz";
pub const DOCKER_LINUX_SHA256: &str =
    "33e1ab8b63d14bca449f7a3d30d7f6aa669daa544e60a86b17fec87f61afe2b4";

pub const DOCKER_CLI_URL: &str =
    "https://download.docker.com/win/static/stable/x86_64/docker-29.9.0.zip";
pub const DOCKER_CLI_SHA256: &str =
    "e3ff5d2e4cd1ad7e1c9bcb76f0df28a84853c43416a915323f08659d8487ad83";

pub const TARBALL_NAME: &str = "intentic-engine-1.2.0-x86_64.tar.gz";

/// `intentic-engine-1.2.0-x86_64.tar.gz` from `engine/build.sh` on 2026-10-10 (60M: docker 29.9.0, with apk packages, passt and socat
/// included).
pub const DISTRO_TARBALL_BYTES: u64 = 62_819_786;
/// `docker-29.9.0.zip` from download.docker.com, measured in the build sandbox.
pub const DOCKER_CLI_ZIP_BYTES: u64 = 49_716_206;

/// The engine cache's copy of the Windows CLI, named by its version: a cached older zip is never resumed into a newer
/// one (a resumable download takes the bytes already there as the start of the new file).
pub fn cli_zip_name() -> String {
    format!("docker-cli-{DOCKER_CLI_VERSION}.zip")
}

/// The engine cache's copy of the static Linux bundle `ic engine update` installs, named by its version for the same
/// reason.
pub fn linux_tgz_name() -> String {
    let version = DOCKER_LINUX_URL
        .rsplit('/')
        .next()
        .and_then(|file| file.strip_prefix("docker-"))
        .and_then(|file| file.strip_suffix(".tgz"))
        .unwrap_or("pinned");
    format!("docker-linux-{version}.tgz")
}

/// `docker compose` for a WSL distro the engine serves (`ic engine wsl enable`).
pub const DOCKER_COMPOSE_URL: &str =
    "https://github.com/docker/compose/releases/download/v5.6.0/docker-compose-linux-x86_64";
pub const DOCKER_COMPOSE_SHA256: &str =
    "40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a";
/// `docker buildx` for a WSL distro the engine serves.
pub const DOCKER_BUILDX_URL: &str =
    "https://github.com/docker/buildx/releases/download/v0.38.0/buildx-v0.38.0.linux-amd64";
pub const DOCKER_BUILDX_SHA256: &str =
    "4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287";

/// The engine cache's name for a pinned download: its URL's last segment, which carries its version.
pub fn cached_name(url: &str) -> String {
    url.rsplit('/').next().unwrap_or("download").to_string()
}

pub fn prefetch_total_bytes() -> u64 {
    DISTRO_TARBALL_BYTES + DOCKER_CLI_ZIP_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn tarball_name_matches_engine_version() {
        assert!(TARBALL_NAME.contains(ENGINE_VERSION));
    }

    #[test]
    fn cached_downloads_are_named_by_their_version() {
        assert_eq!(
            cli_zip_name(),
            format!("docker-cli-{DOCKER_CLI_VERSION}.zip")
        );
        assert_eq!(
            linux_tgz_name(),
            format!("docker-linux-{DOCKER_CLI_VERSION}.tgz")
        );
        assert!(DOCKER_CLI_URL.contains(DOCKER_CLI_VERSION));
        assert_eq!(
            cached_name(DOCKER_COMPOSE_URL),
            "docker-compose-linux-x86_64"
        );
        assert!(cached_name(DOCKER_BUILDX_URL).contains("v0.38.0"));
    }

    fn pin_value(toml: &str, key: &str) -> String {
        let prefix = format!("{key} = \"");
        toml.lines()
            .find(|line| line.starts_with(&prefix))
            .and_then(|line| line.strip_prefix(&prefix))
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or("")
            .to_string()
    }

    #[test]
    fn pins_toml_matches_rust_constants() {
        let toml = include_str!("../../engine/pins.toml");
        for (key, value) in [
            ("engine_version", ENGINE_VERSION),
            ("docker_tgz_sha256", DOCKER_LINUX_SHA256),
            ("docker_cli_zip_sha256", DOCKER_CLI_SHA256),
            ("docker_compose_url", DOCKER_COMPOSE_URL),
            ("docker_compose_sha256", DOCKER_COMPOSE_SHA256),
            ("docker_buildx_url", DOCKER_BUILDX_URL),
            ("docker_buildx_sha256", DOCKER_BUILDX_SHA256),
        ] {
            let needle = format!("{key} = \"{value}\"");
            assert!(toml.contains(&needle), "engine/pins.toml missing {needle}");
        }
        let alpine_sha = pin_value(toml, "alpine_sha256");
        assert_eq!(alpine_sha.len(), 64, "alpine_sha256 in pins.toml");
        assert!(
            alpine_sha.chars().all(|c| c.is_ascii_hexdigit()),
            "alpine_sha256 must be hex"
        );
        let _ = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("engine/pins.toml");
    }
}
