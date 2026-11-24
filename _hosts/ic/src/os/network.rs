use std::io::{IsTerminal as _, Read as _};
use std::time::Duration;

use serde_json::{json, Value};

use super::tool;
use crate::util::{bail, Result};

/* `ic os network`: HOW THIS MACHINE IS ONLINE, AND THE WI-FI IT JOINS. NetworkManager runs the network on Intentic OS;
this reads it through `nmcli`'s terse output (`-t`: fields split by `:`, a `:` or `\` inside a value escaped with `\`),
parsed by the pure functions below and tested on output in the shape nmcli 1.56 prints (Fedora 44's; the lines of a
NetworkManager run in the server image were recorded on 2026-10-16, the Wi-Fi scan lines modelled, since no radio was
there to scan). The `intentic`
user may change Wi-Fi without a password because the image's polkit rule allows it exactly that
(/usr/share/polkit-1/rules.d/50-intentic.rules); a profile it adds is the machine's, so the machine rejoins at boot
before anyone signs in.

A password never rides on a command line, where anyone on the machine reads it (`ps`): ic takes it on its stdin
(`--password-stdin`) or from a hidden prompt, and hands it to nmcli the same way, as a `passwd-file` read from nmcli's
stdin when the profile is brought up. NetworkManager keeps it in the profile once the network accepted it. */

/// Reading what NetworkManager knows: it answers from memory.
const READ_LIMIT: Duration = Duration::from_secs(15);
/// A Wi-Fi rescan: the adapter listens on each channel in turn.
const SCAN_LIMIT: Duration = Duration::from_secs(30);
/// How long nmcli itself waits for a network to be joined (`-w`), and ic for nmcli a little longer.
const JOIN_WAIT_SECS: &str = "45";
const JOIN_LIMIT: Duration = Duration::from_secs(60);
/// Adding, deleting a profile, turning the radio on or off.
const CHANGE_LIMIT: Duration = Duration::from_secs(20);

/// The exit code for a network that needs a password it was not given, or refused the one given (the contract's
/// IC_OS_WIFI_PASSWORD_EXIT).
pub const WIFI_PASSWORD: i32 = 5;

/// One line of nmcli's terse output, split into its fields: `:` separates them, and `\:` and `\\` inside a value are
/// the characters themselves. Pure.
pub fn terse_fields(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    fields.last_mut().expect("one field").push(next);
                }
            }
            ':' => fields.push(String::new()),
            other => fields.last_mut().expect("one field").push(other),
        }
    }
    fields
}

/// One network device as `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub name: String,
    pub kind: String,
    pub state: String,
    pub connection: String,
}

impl Device {
    /// It carries a connection: `connected`, or `connected (externally)` for one set up outside NetworkManager.
    pub fn connected(&self) -> bool {
        self.state == "connected" || self.state.starts_with("connected (")
    }
}

/// The device listing, read. Pure.
pub fn devices(listing: &str) -> Vec<Device> {
    listing
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let fields = terse_fields(line);
            let [name, kind, state, connection] = <[String; 4]>::try_from(fields).ok()?;
            Some(Device {
                name,
                kind,
                state,
                connection,
            })
        })
        .collect()
}

/// One access point as `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list` lists it: every radio broadcasting a
/// network is a line of its own, so one network can be several.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessPoint {
    pub in_use: bool,
    pub ssid: String,
    pub signal: u8,
    pub security: String,
}

/// The access point listing, read; a hidden network (no name) is left out, since nothing could name it to join. Pure.
pub fn access_points(listing: &str) -> Vec<AccessPoint> {
    listing
        .lines()
        .filter_map(|line| {
            let fields = terse_fields(line);
            let [in_use, ssid, signal, security] = <[String; 4]>::try_from(fields).ok()?;
            if ssid.is_empty() || ssid == "--" {
                return None;
            }
            Some(AccessPoint {
                in_use: in_use.trim() == "*",
                ssid,
                signal: signal.trim().parse::<u8>().ok()?.min(100),
                security: security.trim().to_string(),
            })
        })
        .collect()
}

/// What a network asks of whoever joins it, from the access point's SECURITY field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Security {
    /// Nothing (`OWE`, enhanced open, encrypts without a password).
    Open,
    /// A password: WPA1/2 personal, and a WPA3 network that also takes WPA2.
    Psk,
    /// A password, WPA3 personal only.
    Sae,
    /// A WEP key, the oldest kind.
    Wep,
    /// A user name and a password (a work or school network, 802.1X): not something these verbs can join yet.
    Enterprise,
}

impl Security {
    /// The profile's `wifi-sec.key-mgmt`, for the kinds a password joins.
    fn key_mgmt(self) -> Option<&'static str> {
        match self {
            Security::Psk => Some("wpa-psk"),
            Security::Sae => Some("sae"),
            Security::Wep => Some("none"),
            Security::Open | Security::Enterprise => None,
        }
    }
}

/// The SECURITY field read: `WPA2`, `WPA1 WPA2`, `WPA2 WPA3`, `WPA3`, `WEP`, `WPA2 802.1X`, `OWE`, empty or `--` for
/// none. Pure.
pub fn security_of(field: &str) -> Security {
    let words: Vec<&str> = field.split_whitespace().collect();
    let has = |word: &str| words.contains(&word);
    if has("802.1X") {
        Security::Enterprise
    } else if has("WPA1") || has("WPA2") || has("WPA") {
        Security::Psk
    } else if has("WPA3") {
        Security::Sae
    } else if has("WEP") {
        Security::Wep
    } else {
        Security::Open
    }
}

/// The secret a `passwd-file` hands NetworkManager for a profile of this kind, one `setting.property:value` line.
/// Pure.
pub fn secret_line(key_mgmt: &str, password: &str) -> String {
    let property = if key_mgmt == "none" {
        "802-11-wireless-security.wep-key0"
    } else {
        "802-11-wireless-security.psk"
    };
    format!("{property}:{password}\n")
}

/// `ic os network status --json`: `{connected, kind, name, signal}`. A wire counts first (it carries the machine's
/// default route ahead of Wi-Fi), then Wi-Fi; `name` is the network's name on Wi-Fi and the connection's on a wire.
/// Pure.
pub fn status_value(devices: &[Device], access_points: &[AccessPoint]) -> Value {
    let up = |kind: &str| {
        devices
            .iter()
            .find(|device| device.kind == kind && device.connected())
    };
    if let Some(wired) = up("ethernet") {
        return json!({
            "connected": true,
            "kind": "ethernet",
            "name": Some(&wired.connection).filter(|name| !name.is_empty()),
            "signal": null,
        });
    }
    if let Some(wifi) = up("wifi") {
        let in_use = access_points.iter().find(|ap| ap.in_use);
        let name = in_use
            .map(|ap| ap.ssid.clone())
            .or_else(|| Some(wifi.connection.clone()).filter(|name| !name.is_empty()));
        return json!({
            "connected": true,
            "kind": "wifi",
            "name": name,
            "signal": in_use.map(|ap| ap.signal),
        });
    }
    json!({ "connected": false, "kind": "none", "name": null, "signal": null })
}

/// `ic os network wifi list --json`: each network once, however many access points broadcast it (the strongest signal,
/// in use when any of them is), strongest first. Pure.
pub fn list_value(
    adapter: bool,
    enabled: bool,
    access_points: &[AccessPoint],
    known: &[String],
) -> Value {
    let mut networks: Vec<(String, u8, bool, bool)> = Vec::new();
    for ap in access_points {
        let secured = !matches!(security_of(&ap.security), Security::Open);
        match networks.iter_mut().find(|(ssid, ..)| *ssid == ap.ssid) {
            Some(seen) => {
                seen.1 = seen.1.max(ap.signal);
                seen.2 |= secured;
                seen.3 |= ap.in_use;
            }
            None => networks.push((ap.ssid.clone(), ap.signal, secured, ap.in_use)),
        }
    }
    networks.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let listed = if adapter && enabled {
        networks
    } else {
        Vec::new()
    };
    json!({
        "adapter": adapter,
        "enabled": adapter && enabled,
        "networks": listed
            .into_iter()
            .map(|(ssid, signal, secured, active)| json!({
                "ssid": ssid,
                "signal": signal,
                "secured": secured,
                "known": known.contains(&ssid),
                "active": active,
            }))
            .collect::<Vec<_>>(),
    })
}

/// The Wi-Fi profiles in `nmcli -t -f NAME,UUID,TYPE connection show`: their UUIDs. Pure.
pub fn wifi_profile_uuids(listing: &str) -> Vec<String> {
    listing
        .lines()
        .filter_map(|line| {
            let fields = terse_fields(line);
            let [_name, uuid, kind] = <[String; 3]>::try_from(fields).ok()?;
            (kind == "802-11-wireless" || kind == "wifi").then_some(uuid)
        })
        .collect()
}

/// A saved Wi-Fi profile: which network it joins.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub uuid: String,
    pub ssid: String,
    pub key_mgmt: String,
}

/// The profiles in `nmcli -t -e no -f connection.uuid,802-11-wireless.ssid,802-11-wireless-security.key-mgmt
/// connection show uuid …`: one `field:value` line each, profile after profile, unescaped (`-e no`), so everything after
/// the field's own colon is the value. Pure.
pub fn profiles(details: &str) -> Vec<Profile> {
    let mut found: Vec<Profile> = Vec::new();
    for line in details.lines() {
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        match field {
            "connection.uuid" => found.push(Profile {
                uuid: value.to_string(),
                ssid: String::new(),
                key_mgmt: String::new(),
            }),
            "802-11-wireless.ssid" => {
                if let Some(profile) = found.last_mut() {
                    profile.ssid = value.to_string();
                }
            }
            "802-11-wireless-security.key-mgmt" => {
                if let Some(profile) = found.last_mut() {
                    profile.key_mgmt = value.to_string();
                }
            }
            _ => {}
        }
    }
    found.retain(|profile| !profile.ssid.is_empty());
    found
}

/// The UUID in what `nmcli connection add` answers: `Connection 'Home Fiber' (0f6e…) successfully added.` Pure.
pub fn added_uuid(said: &str) -> Option<String> {
    let open = said.rfind('(')?;
    let close = said[open..].find(')')? + open;
    let uuid = &said[open + 1..close];
    (uuid.len() == 36 && uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| uuid.to_string())
}

/// Whether a failed join failed for its password: NetworkManager asked for secrets and got none it could use. Pure.
pub fn wanted_password(said: &str) -> bool {
    let said = said.to_ascii_lowercase();
    [
        "secrets were required",
        "no secrets",
        "supplicant",
        "password",
        "(7)",
    ]
    .iter()
    .any(|sign| said.contains(sign))
}

/// A network's name as ic takes it: what a network can broadcast, 1 to 32 bytes. Pure.
pub fn valid_ssid(ssid: &str) -> bool {
    !ssid.is_empty() && ssid.len() <= 32
}

/* RUNNING nmcli. */

fn nmcli(args: &[&str], limit: Duration) -> Result<String> {
    tool::capture("nmcli", args, limit)
}

fn read_devices() -> Result<Vec<Device>> {
    Ok(devices(&nmcli(
        &[
            "-t",
            "-f",
            "DEVICE,TYPE,STATE,CONNECTION",
            "device",
            "status",
        ],
        READ_LIMIT,
    )?))
}

fn scan(rescan: bool) -> Result<Vec<AccessPoint>> {
    let args = |how: &'static str| -> [&'static str; 8] {
        [
            "-t",
            "-f",
            "IN-USE,SSID,SIGNAL,SECURITY",
            "device",
            "wifi",
            "list",
            "--rescan",
            how,
        ]
    };
    if rescan {
        // A rescan NetworkManager will not start (one already running, a radio just turned on) still leaves what it
        // last heard, which is the answer then.
        if let Ok(listing) = nmcli(&args("yes"), SCAN_LIMIT) {
            return Ok(access_points(&listing));
        }
    }
    Ok(access_points(&nmcli(&args("no"), READ_LIMIT)?))
}

fn wifi_enabled() -> Result<bool> {
    Ok(nmcli(&["radio", "wifi"], READ_LIMIT)?.trim() == "enabled")
}

/// Every saved Wi-Fi profile with the network it joins.
fn saved_profiles() -> Result<Vec<Profile>> {
    let uuids = wifi_profile_uuids(&nmcli(
        &["-t", "-f", "NAME,UUID,TYPE", "connection", "show"],
        READ_LIMIT,
    )?);
    if uuids.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec![
        "-t",
        "-e",
        "no",
        "-f",
        "connection.uuid,802-11-wireless.ssid,802-11-wireless-security.key-mgmt",
        "connection",
        "show",
    ];
    for uuid in &uuids {
        args.push("uuid");
        args.push(uuid);
    }
    Ok(profiles(&nmcli(&args, READ_LIMIT)?))
}

/// `ic os network status [--json]`.
pub fn status(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    let devices = read_devices()?;
    let wifi_up = devices
        .iter()
        .any(|device| device.kind == "wifi" && device.connected());
    let access_points = if wifi_up { scan(false)? } else { Vec::new() };
    let status = status_value(&devices, &access_points);
    if json {
        super::emit_json(&status);
        return Ok(());
    }
    if status["connected"] != true {
        crate::ui::quiet("This machine is not connected to a network.");
        return Ok(());
    }
    let name = status["name"].as_str().unwrap_or("a network");
    match status["signal"].as_u64() {
        Some(signal) => crate::ui::done(&format!(
            "Connected to the Wi-Fi network {name} (signal {signal}%)."
        )),
        None if status["kind"] == "wifi" => {
            crate::ui::done(&format!("Connected to the Wi-Fi network {name}."))
        }
        None => crate::ui::done(&format!("Connected by cable ({name}).")),
    }
    Ok(())
}

/// `ic os network wifi list [--json]`: rescans first.
pub fn wifi_list(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    let adapter = read_devices()?.iter().any(|device| device.kind == "wifi");
    let enabled = adapter && wifi_enabled()?;
    let access_points = if enabled { scan(true)? } else { Vec::new() };
    let known: Vec<String> = if enabled {
        saved_profiles()?
            .into_iter()
            .map(|profile| profile.ssid)
            .collect()
    } else {
        Vec::new()
    };
    let list = list_value(adapter, enabled, &access_points, &known);
    if json {
        super::emit_json(&list);
        return Ok(());
    }
    if !adapter {
        crate::ui::quiet("This machine has no Wi-Fi.");
        return Ok(());
    }
    if !enabled {
        crate::ui::quiet("Wi-Fi is turned off (ic os network wifi on).");
        return Ok(());
    }
    let networks = list["networks"].as_array().cloned().unwrap_or_default();
    if networks.is_empty() {
        crate::ui::quiet("No Wi-Fi network is in reach.");
        return Ok(());
    }
    crate::ui::report("Wi-Fi networks in reach", None);
    let fields: Vec<(String, String)> = networks
        .iter()
        .map(|network| {
            let mut words = vec![format!("{}%", network["signal"])];
            if network["secured"] == true {
                words.push("password".to_string());
            }
            if network["known"] == true {
                words.push("joined before".to_string());
            }
            if network["active"] == true {
                words.push("in use".to_string());
            }
            (
                network["ssid"].as_str().unwrap_or_default().to_string(),
                words.join(", "),
            )
        })
        .collect();
    crate::ui::fields(&fields);
    Ok(())
}

/// The password the caller handed over on stdin: its first line, nothing when it sent none.
fn password_from_stdin() -> Result<Option<String>> {
    let mut text = String::new();
    std::io::stdin()
        .take(4096)
        .read_to_string(&mut text)
        .map_err(|err| {
            crate::util::Fail(format!("could not read the password from stdin: {err}"))
        })?;
    let line = text.lines().next().unwrap_or_default().to_string();
    Ok(Some(line).filter(|line| !line.is_empty()))
}

/// Bring a saved profile up, with a password from a `passwd-file` on nmcli's stdin when one is given.
fn bring_up(uuid: &str, key_mgmt: &str, password: Option<&str>) -> Result<String> {
    let mut args = vec!["-w", JOIN_WAIT_SECS, "connection", "up", "uuid", uuid];
    match password {
        None => nmcli(&args, JOIN_LIMIT),
        Some(password) => {
            args.extend(["passwd-file", "/dev/stdin"]);
            tool::capture_with_input(
                "nmcli",
                &args,
                secret_line(key_mgmt, password).as_bytes(),
                JOIN_LIMIT,
            )
        }
    }
}

/// `ic os network wifi connect [--password-stdin] <ssid>`.
pub fn wifi_connect(ssid: &str, password_stdin: bool) -> Result<()> {
    if !valid_ssid(ssid) {
        bail!("{ssid:?} is not a Wi-Fi network's name (1 to 32 bytes).");
    }
    let mut password = if password_stdin {
        password_from_stdin()?
    } else {
        None
    };
    let known: Vec<Profile> = saved_profiles()?
        .into_iter()
        .filter(|profile| profile.ssid == ssid)
        .collect();
    if let Some(profile) = known.first() {
        crate::ui::note(&format!(
            "joining {ssid}, which this machine has joined before…"
        ));
        return match bring_up(&profile.uuid, &profile.key_mgmt, password.as_deref()) {
            Ok(_) => {
                crate::ui::done(&format!("Connected to {ssid}."));
                Ok(())
            }
            Err(err) if wanted_password(&err.0) => tool::exit_with(
                WIFI_PASSWORD,
                &if password.is_some() {
                    format!("{ssid} did not take that password. ({})", err.0)
                } else {
                    format!("{ssid} needs its password again: give it on stdin with --password-stdin. ({})", err.0)
                },
            ),
            Err(err) => bail!("Could not join {ssid}: {}", err.0),
        };
    }
    let mut heard = scan(false)?;
    if !heard.iter().any(|ap| ap.ssid == ssid) {
        heard = scan(true)?;
    }
    let Some(ap) = heard.iter().find(|ap| ap.ssid == ssid) else {
        bail!("No Wi-Fi network called {ssid} is in reach of this machine.");
    };
    let security = security_of(&ap.security);
    let Some(key_mgmt) = security.key_mgmt() else {
        if security == Security::Enterprise {
            bail!("{ssid} asks for a user name as well as a password (a work or school network); this machine cannot join that kind yet.");
        }
        crate::ui::note(&format!("joining {ssid}…"));
        nmcli(
            &["-w", JOIN_WAIT_SECS, "device", "wifi", "connect", ssid],
            JOIN_LIMIT,
        )
        .map_err(|err| crate::util::Fail(format!("Could not join {ssid}: {}", err.0)))?;
        crate::ui::done(&format!("Connected to {ssid}."));
        return Ok(());
    };
    if password.is_none() && std::io::stdin().is_terminal() {
        password = crate::ui::secret(
            &format!("{ssid} needs its password."),
            "It is kept on this machine, which rejoins the network by itself from now on.",
        )
        .filter(|password| !password.is_empty());
    }
    let Some(password) = password else {
        tool::exit_with(
            WIFI_PASSWORD,
            &format!("{ssid} needs its password: give it on stdin with --password-stdin."),
        );
    };
    crate::ui::note(&format!("joining {ssid}…"));
    // The profile first, with no secret in it (nothing secret on a command line), then brought up with the password
    // handed over on stdin; NetworkManager keeps it in the profile once the network took it.
    let added = nmcli(
        &[
            "connection",
            "add",
            "type",
            "wifi",
            "con-name",
            ssid,
            "ssid",
            ssid,
            "wifi-sec.key-mgmt",
            key_mgmt,
        ],
        CHANGE_LIMIT,
    )?;
    let Some(uuid) = added_uuid(&added) else {
        bail!("nmcli added a profile for {ssid} but did not say which: {added}");
    };
    match bring_up(&uuid, key_mgmt, Some(&password)) {
        Ok(_) => {
            crate::ui::done(&format!(
                "Connected to {ssid}. This machine rejoins it by itself from now on."
            ));
            Ok(())
        }
        Err(err) => {
            // A profile that never joined is not a network this machine knows: it goes, so a wrong password is not
            // tried again at every boot.
            let _ = nmcli(&["connection", "delete", "uuid", &uuid], CHANGE_LIMIT);
            if wanted_password(&err.0) {
                tool::exit_with(
                    WIFI_PASSWORD,
                    &format!("{ssid} did not take that password. ({})", err.0),
                );
            }
            bail!("Could not join {ssid}: {}", err.0)
        }
    }
}

/// `ic os network wifi forget <ssid>`: every saved profile for that network goes; nothing to forget is not a failure.
pub fn wifi_forget(ssid: &str) -> Result<()> {
    if !valid_ssid(ssid) {
        bail!("{ssid:?} is not a Wi-Fi network's name (1 to 32 bytes).");
    }
    let uuids: Vec<String> = saved_profiles()?
        .into_iter()
        .filter(|profile| profile.ssid == ssid)
        .map(|profile| profile.uuid)
        .collect();
    if uuids.is_empty() {
        crate::ui::quiet(&format!(
            "This machine does not know a Wi-Fi network called {ssid}; nothing to forget."
        ));
        return Ok(());
    }
    let mut args = vec!["connection", "delete"];
    for uuid in &uuids {
        args.push("uuid");
        args.push(uuid);
    }
    nmcli(&args, CHANGE_LIMIT)?;
    crate::ui::done(&format!(
        "Forgot {ssid}: this machine no longer joins it by itself."
    ));
    Ok(())
}

/// `ic os network wifi on|off`.
pub fn wifi_radio(on: bool) -> Result<()> {
    nmcli(
        &["radio", "wifi", if on { "on" } else { "off" }],
        CHANGE_LIMIT,
    )?;
    crate::ui::done(if on { "Wi-Fi is on." } else { "Wi-Fi is off." });
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixture {
    /* What nmcli 1.56 prints for a laptop on its home Wi-Fi, with Docker's bridge and an unplugged cable beside it
    (`-t`, so `:` separates fields and an escaped `\:` is part of a value). */

    pub const DEVICES_ON_WIFI: &str = "wlp2s0:wifi:connected:Home Fiber\n\
enp3s0:ethernet:unavailable:\n\
docker0:bridge:connected (externally):docker0\n\
lo:loopback:connected (externally):lo\n\
p2p-dev-wlp2s0:wifi-p2p:disconnected:\n";

    pub const DEVICES_ON_A_WIRE: &str = "enp3s0:ethernet:connected:Wired connection 1\n\
wlp2s0:wifi:connected:Home Fiber\n\
docker0:bridge:connected (externally):docker0\n\
lo:loopback:connected (externally):lo\n";

    pub const DEVICES_OFFLINE: &str = "wlp2s0:wifi:disconnected:\n\
enp3s0:ethernet:unavailable:\n\
lo:loopback:connected (externally):lo\n";

    pub const DEVICES_WITHOUT_WIFI: &str = "enp3s0:ethernet:connected:Wired connection 1\n\
lo:loopback:connected (externally):lo\n";

    /// `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`: the home network on two radios, a café with a colon
    /// in its name and no password, a WPA2/WPA3 neighbour, a hidden network and an office's 802.1X.
    pub const ACCESS_POINTS: &str = "*:Home Fiber:72:WPA2\n \
:Home Fiber:40:WPA2\n \
:Café\\: Guest:55:\n \
:Neighbours 5G:31:WPA2 WPA3\n \
::20:WPA2\n \
:Office:48:WPA2 802.1X\n";

    /// `nmcli -t -f NAME,UUID,TYPE connection show`.
    pub const CONNECTIONS: &str =
        "Home Fiber:5f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b:802-11-wireless\n\
Wired connection 1:9e8d7c6b-5a49-3827-1605-f4e3d2c1b0a9:802-3-ethernet\n\
docker0:2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a:bridge\n\
Office old:7a6b5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d:802-11-wireless\n";

    /// `nmcli -t -e no -f connection.uuid,802-11-wireless.ssid,802-11-wireless-security.key-mgmt connection show uuid
    /// … uuid …`.
    pub const PROFILES: &str = "connection.uuid:5f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b\n\
802-11-wireless.ssid:Home Fiber\n\
802-11-wireless-security.key-mgmt:wpa-psk\n\
connection.uuid:7a6b5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d\n\
802-11-wireless.ssid:Office\n\
802-11-wireless-security.key-mgmt:wpa-eap\n";
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/golden/intentic-os.json"
        ))
        .expect("the golden file is JSON")
    }

    #[test]
    fn a_terse_line_splits_on_colons_and_keeps_escaped_ones() {
        assert_eq!(terse_fields("a:b::c"), vec!["a", "b", "", "c"]);
        assert_eq!(
            terse_fields(" :Café\\: Guest:55:"),
            vec![" ", "Café: Guest", "55", ""]
        );
        assert_eq!(terse_fields("back\\\\slash:x"), vec!["back\\slash", "x"]);
        assert_eq!(terse_fields(""), vec![""]);
    }

    #[test]
    fn devices_and_access_points_read_as_nmcli_lists_them() {
        let listed = devices(fixture::DEVICES_ON_WIFI);
        assert_eq!(listed.len(), 5);
        assert_eq!(
            listed[0],
            Device {
                name: "wlp2s0".into(),
                kind: "wifi".into(),
                state: "connected".into(),
                connection: "Home Fiber".into()
            }
        );
        assert!(listed[2].connected(), "connected (externally) is connected");
        assert!(!listed[1].connected());
        let heard = access_points(fixture::ACCESS_POINTS);
        // The hidden network is left out.
        assert_eq!(heard.len(), 5);
        assert!(heard[0].in_use && !heard[1].in_use);
        assert_eq!(heard[2].ssid, "Café: Guest");
        assert_eq!(heard[2].security, "");
    }

    #[test]
    fn every_network_status_the_contract_shows_is_what_the_mapping_makes() {
        let golden = golden();
        let examples = golden["networkStatus"].as_array().expect("examples");
        let heard = access_points(fixture::ACCESS_POINTS);
        assert_eq!(
            status_value(&devices(fixture::DEVICES_ON_WIFI), &heard),
            examples[0]
        );
        // A wire wins over Wi-Fi that is also up: it carries the default route.
        assert_eq!(
            status_value(&devices(fixture::DEVICES_ON_A_WIRE), &heard),
            examples[1]
        );
        assert_eq!(
            status_value(&devices(fixture::DEVICES_OFFLINE), &[]),
            examples[2]
        );
        // Wi-Fi up but no access point marked in use (a scan between radios): the connection's name, no signal.
        assert_eq!(
            status_value(&devices(fixture::DEVICES_ON_WIFI), &[]),
            json!({ "connected": true, "kind": "wifi", "name": "Home Fiber", "signal": null })
        );
    }

    #[test]
    fn every_wifi_list_the_contract_shows_is_what_the_mapping_makes() {
        let golden = golden();
        let examples = golden["wifiList"].as_array().expect("examples");
        let known: Vec<String> = profiles(fixture::PROFILES)
            .into_iter()
            .map(|profile| profile.ssid)
            .collect();
        let heard = access_points(fixture::ACCESS_POINTS);
        assert_eq!(list_value(true, true, &heard, &known), examples[0]);
        assert_eq!(list_value(true, false, &heard, &known), examples[1]);
        assert_eq!(list_value(false, true, &heard, &known), examples[2]);
        let adapter = devices(fixture::DEVICES_WITHOUT_WIFI)
            .iter()
            .any(|device| device.kind == "wifi");
        assert!(!adapter);
    }

    #[test]
    fn saved_profiles_are_read_with_the_network_each_joins() {
        assert_eq!(
            wifi_profile_uuids(fixture::CONNECTIONS),
            vec![
                "5f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b",
                "7a6b5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d"
            ]
        );
        assert_eq!(
            profiles(fixture::PROFILES),
            vec![
                Profile {
                    uuid: "5f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b".into(),
                    ssid: "Home Fiber".into(),
                    key_mgmt: "wpa-psk".into()
                },
                Profile {
                    uuid: "7a6b5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d".into(),
                    ssid: "Office".into(),
                    key_mgmt: "wpa-eap".into()
                },
            ]
        );
        // A name with a colon in it, unescaped (`-e no`): everything after the field's own colon.
        assert_eq!(
            profiles("connection.uuid:u\n802-11-wireless.ssid:Café: Guest\n")[0].ssid,
            "Café: Guest"
        );
    }

    /// Recorded from nmcli 1.56.1 (NetworkManager running in the server image, 2026-10-16): a name with a colon comes
    /// escaped in a listing and whole in details, and a profile with no password has no key-mgmt line at all.
    #[test]
    fn what_nmcli_1_56_printed_reads_back() {
        let listing = "lo:1d8fc18d-5785-41af-a6f9-f91f6c922df2:loopback\n\
eth0:bd8a152b-68e2-41ce-bb07-da63b3de2735:802-3-ethernet\n\
Café\\: Guest:b4b87915-4212-43e4-8ba0-08bd9595fe53:802-11-wireless\n\
Home Fiber:5d08e76a-5499-4355-bfdf-abb4cb758251:802-11-wireless\n\
Wired connection 1:4b99df03-8e31-353d-bf28-5aea93cef444:802-3-ethernet\n";
        assert_eq!(
            wifi_profile_uuids(listing),
            vec![
                "b4b87915-4212-43e4-8ba0-08bd9595fe53",
                "5d08e76a-5499-4355-bfdf-abb4cb758251"
            ]
        );
        let details = "connection.uuid:b4b87915-4212-43e4-8ba0-08bd9595fe53\n\
802-11-wireless.ssid:Café: Guest\n\
connection.uuid:5d08e76a-5499-4355-bfdf-abb4cb758251\n\
802-11-wireless.ssid:Home Fiber\n\
802-11-wireless-security.key-mgmt:wpa-psk\n";
        assert_eq!(
            profiles(details),
            vec![
                Profile {
                    uuid: "b4b87915-4212-43e4-8ba0-08bd9595fe53".into(),
                    ssid: "Café: Guest".into(),
                    key_mgmt: String::new()
                },
                Profile {
                    uuid: "5d08e76a-5499-4355-bfdf-abb4cb758251".into(),
                    ssid: "Home Fiber".into(),
                    key_mgmt: "wpa-psk".into()
                },
            ]
        );
        assert_eq!(
            added_uuid("Connection 'Café: Guest' (b4b87915-4212-43e4-8ba0-08bd9595fe53) successfully added."),
            Some("b4b87915-4212-43e4-8ba0-08bd9595fe53".to_string())
        );
        let status = devices(
            "lo:loopback:connected (externally):lo\neth0:ethernet:connected (externally):eth0\n",
        );
        assert_eq!(
            status_value(&status, &[]),
            json!({ "connected": true, "kind": "ethernet", "name": "eth0", "signal": null })
        );
        // No Wi-Fi adapter: nmcli lists nothing and says so with exit 0.
        assert_eq!(access_points(""), vec![]);
    }

    #[test]
    fn what_a_network_asks_for_is_read_off_its_security_field() {
        for (field, security) in [
            ("", Security::Open),
            ("--", Security::Open),
            ("OWE", Security::Open),
            ("WPA2", Security::Psk),
            ("WPA1 WPA2", Security::Psk),
            ("WPA2 WPA3", Security::Psk),
            ("WPA3", Security::Sae),
            ("WEP", Security::Wep),
            ("WPA2 802.1X", Security::Enterprise),
            ("WPA3 802.1X", Security::Enterprise),
        ] {
            assert_eq!(security_of(field), security, "{field:?}");
        }
        assert_eq!(
            secret_line("wpa-psk", "pa:ss word"),
            "802-11-wireless-security.psk:pa:ss word\n"
        );
        assert_eq!(secret_line("sae", "x"), "802-11-wireless-security.psk:x\n");
        assert_eq!(
            secret_line("none", "abcde"),
            "802-11-wireless-security.wep-key0:abcde\n"
        );
    }

    #[test]
    fn an_added_profile_is_named_by_its_uuid_and_a_refused_password_is_told_apart() {
        assert_eq!(
            added_uuid(
                "Connection 'Home (2)' (0f6e1b4c-8d2a-4e6f-9b1c-3d5e7f9a1b2c) successfully added."
            ),
            Some("0f6e1b4c-8d2a-4e6f-9b1c-3d5e7f9a1b2c".to_string())
        );
        assert_eq!(added_uuid("Connection 'x' successfully added."), None);
        for said in [
            "nmcli: Connection activation failed: Secrets were required, but not provided.",
            "nmcli: Connection activation failed: (7) Secrets were required, but not provided",
            "nmcli: Connection activation failed: 802.1X supplicant took too long to authenticate",
        ] {
            assert!(wanted_password(said), "{said}");
        }
        for said in [
            "nmcli: Connection activation failed: The Wi-Fi network could not be found",
            "nmcli: NetworkManager is not running.",
        ] {
            assert!(!wanted_password(said), "{said}");
        }
    }

    #[test]
    fn a_network_name_is_one_to_thirty_two_bytes() {
        assert!(valid_ssid("Home Fiber"));
        assert!(valid_ssid(&"x".repeat(32)));
        assert!(!valid_ssid(""));
        assert!(!valid_ssid(&"x".repeat(33)));
        // Sixteen two-byte letters fit; seventeen do not.
        assert!(valid_ssid(&"ü".repeat(16)));
        assert!(!valid_ssid(&"ü".repeat(17)));
    }
}
