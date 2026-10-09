//! Pinned upstream versions for the intentic-engine rootfs and prefetch sizes. Keep in sync with `engine/pins.toml`.
#![cfg_attr(not(windows), allow(dead_code))]

pub const ENGINE_VERSION: &str = "1.0.0";

pub const DOCKER_CLI_VERSION: &str = "27.5.1";

pub const DOCKER_LINUX_URL: &str =
    "https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz";
pub const DOCKER_LINUX_SHA256: &str =
    "4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640";

pub const DOCKER_CLI_URL: &str =
    "https://download.docker.com/win/static/stable/x86_64/docker-27.5.1.zip";
pub const DOCKER_CLI_SHA256: &str =
    "a573be076030c8babe34ffcd89c7ad6e720cfb4f876a0f8412dba7ecdd368926";

pub const TARBALL_NAME: &str = "intentic-engine-1.0.0-x86_64.tar.gz";

/// `intentic-engine-1.0.0-x86_64.tar.gz` from `engine/build.sh` on 2026-10-09 (53M, with apk packages).
pub const DISTRO_TARBALL_BYTES: u64 = 54_744_564;
/// `docker-27.5.1.zip` from download.docker.com, measured in the build sandbox.
pub const DOCKER_CLI_ZIP_BYTES: u64 = 40_083_749;

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
