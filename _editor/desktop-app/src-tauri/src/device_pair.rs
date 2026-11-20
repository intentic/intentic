//! `intentic://device-pair?url=…&pair=…`: connect THIS computer to a sandbox as a device, the one-time command a
//! device's card hands out, run by the app with nothing to paste (2026-11-20). A reader inside this app on the very
//! computer whose connection to its sandbox dropped pressed Reconnect on the computer's card six times one evening and
//! met, each time, only a PowerShell line to copy into a terminal. The card now offers this beside it on a computer
//! that runs the app (the web's HostConnectDialog), and the command stays for any other machine.
//!
//! It runs the bundled `device.sh` / `device.ps1`, the very script the one-liner fetches, with the sandbox's address and
//! the single-use pairing token the card just minted, as the one-liner's environment-variable form carries them.
//!
//! App-window only, refused outright from anywhere else, as `sync` is and for the same reason: both values are the
//! sender's choice, and from the OS handler any page could put this computer one click from answering to a sandbox
//! the sender signs in to. Nothing is confirmed here: the card's own button said what it does.

use tauri::AppHandle;

use crate::scripts::{self, Host, ScriptRun};

/// The run's id, one at a time: a second press while one runs changes nothing.
pub const RUN: &str = "device-pair";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicePairArgs {
    pub url: String,
    pub pair: String,
}

/// The sandbox's address as a card hands it out: https, or plain http on this computer's loopback (a local sandbox's
/// daemon). Nothing a shell could read as more than one value. Pure.
pub fn is_sandbox_url(url: &str) -> bool {
    let plain =
        |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'/' | b'_');
    (1..=512).contains(&url.len())
        && url.bytes().all(plain)
        && (url.starts_with("https://")
            || url.starts_with("http://127.0.0.1:")
            || url.starts_with("http://localhost:"))
}

/// A pairing token as the sandbox mints them: url-safe, never a flag. Pure.
pub fn is_pair_token(token: &str) -> bool {
    (16..=256).contains(&token.len())
        && !token.starts_with('-')
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
}

/// The link's values, each held to its shape; either missing or malformed is no link. Pure.
pub fn args_of(url: Option<String>, pair: Option<String>) -> Option<DevicePairArgs> {
    let url = url.filter(|url| is_sandbox_url(url))?;
    let pair = pair.filter(|pair| is_pair_token(pair))?;
    Some(DevicePairArgs { url, pair })
}

/// The run: the device script with the pairing, as the user, as the one-liner would run it. Pure.
pub fn script(args: &DevicePairArgs, host: Host, version: &str) -> ScriptRun {
    let mut env = crate::commands::app_env(version);
    env.push(("SANDBOX_URL".into(), args.url.clone()));
    env.push(("PAIR_TOKEN".into(), args.pair.clone()));
    ScriptRun {
        file: host.script("device.sh", "device.ps1"),
        args: Vec::new(),
        env,
        // The agent installs into ~/.intentic/machine and registers per-user login entries: nothing needs root.
        elevate: false,
        host,
    }
}

/// The link landing (windows/links.rs): run out of sight. The card that asked watches its device come online, and keeps
/// the command on screen for a run that fails.
pub fn requested(app: &AppHandle, args: DevicePairArgs) {
    if scripts::is_running(RUN) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = scripts::run(
            &app,
            RUN,
            script(&args, Host::current(), crate::commands::VERSION),
        ) {
            eprintln!("intentic: connecting this computer as a device failed ({error})");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "pK3_x9-Qa7Zr2LmN4tYv";

    #[test]
    fn a_pairing_runs_the_device_script_with_the_address_and_token() {
        let args = args_of(
            Some("https://sandbox-3f2a9c1d7e4b.sbx.intentic.dev".into()),
            Some(TOKEN.into()),
        )
        .expect("a well-formed link");
        let windows = script(&args, Host::Windows, "1.0.0");
        assert_eq!(windows.file, "device.ps1");
        assert!(!windows.elevate);
        assert!(windows.env.contains(&(
            "SANDBOX_URL".into(),
            "https://sandbox-3f2a9c1d7e4b.sbx.intentic.dev".into()
        )));
        assert!(windows.env.contains(&("PAIR_TOKEN".into(), TOKEN.into())));
        assert_eq!(script(&args, Host::Unix, "1.0.0").file, "device.sh");
    }

    #[test]
    fn a_local_sandboxs_loopback_address_is_taken() {
        assert!(args_of(Some("http://127.0.0.1:31833".into()), Some(TOKEN.into())).is_some());
        assert!(args_of(Some("http://localhost:31833".into()), Some(TOKEN.into())).is_some());
    }

    #[test]
    fn anything_but_a_sandbox_address_and_a_token_is_no_link() {
        for (url, pair) in [
            (None, Some(TOKEN)),
            (Some("https://x.test"), None),
            (Some("http://evil.test"), Some(TOKEN)),
            (Some("https://x.test; rm -rf ~"), Some(TOKEN)),
            (Some("https://x.test'$(calc)"), Some(TOKEN)),
            (Some("https://x.test"), Some("--help-and-more-flags")),
            (Some("https://x.test"), Some("short")),
            (Some("https://x.test"), Some("token with spaces in it")),
        ] {
            assert_eq!(
                args_of(url.map(Into::into), pair.map(Into::into)),
                None,
                "{url:?} {pair:?}"
            );
        }
    }
}
