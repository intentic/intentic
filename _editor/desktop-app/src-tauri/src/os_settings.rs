//! THIS COMPUTER'S OWN SETTINGS, ON INTENTIC OS (2026-10-16): the network, the sound, the screens, the keyboard and the
//! drives a person plugs in, as This device's This computer cards show and change them (src/device/intenticOs/). Each is
//! a verb of the OS's own `ic os` (_os/README.md, "Settings"), read as the JSON the contract pins
//! (_shared/sandbox-contract/src/schemas/intentic-os.ts, "THE MACHINE'S OWN SETTINGS"). This app never speaks to
//! NetworkManager, WirePlumber, sway or udisks itself, so a person here and the agent in the machine's own sandbox change
//! the same things the same way. Like os.rs, it runs the OS's own `ic` (`/usr/bin/ic`), never the one beside this app.
//!
//! A thread of its own watches the drives ([`start`]): every few seconds it asks ic which are plugged in, tells every
//! window ([`DRIVES_EVENT`]), and puts up a notification for one that was not there before, in the reader's language
//! ([`os_drive_words`]), which opens This device when pressed. A copy off a drive into a sandbox streams its progress to
//! every window ([`IMPORT_EVENT`]), one copy at a time.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use intentic_bounded::{Captured, Reach};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::os::{self, Image, Reading};
use crate::scripts::{self, Heard, Stream};
use crate::setup_link::{NoticeArgs, NoticeKind};

/* THE EXITS `ic os` ANSWERS WITH, as the contract names them. */

/// Not Intentic OS (`IC_OS_NOT_INTENTIC_OS_EXIT`): nothing here has a card.
const EXIT_NOT_OS: i32 = 3;
/// The screen verbs on an edition with no screen, the server edition (`IC_OS_NO_SCREEN_EXIT`).
const EXIT_NO_SCREEN: i32 = 4;
/// The network wants a password it was not given, or refused the one it was (`IC_OS_WIFI_PASSWORD_EXIT`).
const EXIT_WIFI_PASSWORD: i32 = 5;
/// What is on the drive would not fit in the sandbox, and nothing was copied (`IC_OS_DRIVE_NO_ROOM_EXIT`).
const EXIT_NO_ROOM: i32 = 6;

/* HOW LONG EACH MAY TAKE: every call is bounded, and a hung one is killed with all it started. */

/// A status or a list: NetworkManager, WirePlumber, sway and udisks each answer in well under a second.
const READ_LIMIT: Duration = Duration::from_secs(20);
/// The Wi-Fi list rescans first, which takes the adapter a few seconds, more on a busy band.
const WIFI_LIST_LIMIT: Duration = Duration::from_secs(30);
/// Joining a network: associating, the password checked, an address handed out.
const WIFI_JOIN_LIMIT: Duration = Duration::from_secs(90);
/// A setting changed: the radio, a volume, a screen's mode, a layout, a network forgotten.
const CHANGE_LIMIT: Duration = Duration::from_secs(30);
/// Ejecting writes out whatever is still on its way to the drive first.
const EJECT_LIMIT: Duration = Duration::from_secs(120);
/// A copy off a whole disk of photos over USB 2 runs for hours.
const IMPORT_LIMIT: Duration = Duration::from_secs(12 * 60 * 60);

/// What the commands answer on a computer that is not Intentic OS.
const NOT_OS: &str = "This computer doesn't run Intentic OS.";
/// What a screen change answers on an edition with no screen.
const NO_SCREEN: &str = "This computer has no screen to set up.";

/* WHAT `ic os` IS ASKED: the contract's argv builders (intentic-os.ts `icOs…Args`), spelled the same here, each checked
 * the way the contract's schemas check it, so nothing reaches ic's command line as a flag or a path out of where it
 * belongs. */

const NETWORK_STATUS_ARGS: [&str; 4] = ["os", "network", "status", "--json"];
const WIFI_LIST_ARGS: [&str; 5] = ["os", "network", "wifi", "list", "--json"];
const SOUND_STATUS_ARGS: [&str; 4] = ["os", "sound", "status", "--json"];
const SOUND_OUTPUTS_ARGS: [&str; 4] = ["os", "sound", "outputs", "--json"];
const DISPLAY_LIST_ARGS: [&str; 4] = ["os", "display", "list", "--json"];
const KEYBOARD_STATUS_ARGS: [&str; 4] = ["os", "keyboard", "status", "--json"];
const KEYBOARD_LAYOUTS_ARGS: [&str; 4] = ["os", "keyboard", "layouts", "--json"];
const DRIVES_LIST_ARGS: [&str; 4] = ["os", "drives", "list", "--json"];

fn owned(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_string()).collect()
}

/// The contract's names: a letter or digit first, then at most `rest` letters, digits or `extra`. Pure.
fn is_name(text: &str, extra: &str, rest: usize) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && text.len() <= rest + 1
        && chars.all(|character| character.is_ascii_alphanumeric() || extra.contains(character))
}

/// A screen's connector (`HDMI-A-1`, `eDP-1`).
pub fn is_output_name(text: &str) -> bool {
    is_name(text, "_.-", 63)
}

/// An xkb layout or variant (`de`, `nodeadkeys`).
pub fn is_xkb_name(text: &str) -> bool {
    is_name(text, "_+-", 63)
}

/// A drive's device (`/dev/sdb1`).
pub fn is_block_device(text: &str) -> bool {
    text.strip_prefix("/dev/")
        .is_some_and(|name| is_name(name, "._-", 63))
}

/// A sandbox's slug.
pub fn is_sandbox_slug(text: &str) -> bool {
    is_name(text, "_.-", 127) && !text.contains("..")
}

/// A Wi-Fi network's name: whatever it broadcasts, at most 32 bytes. It goes after `--`, so a hyphen is no flag; a NUL
/// cannot ride on a command line at all.
pub fn is_ssid(text: &str) -> bool {
    (1..=32).contains(&text.len()) && !text.contains('\0')
}

/// A folder inside the sandbox's /work: relative, no `..`, no leading slash or hyphen, at most 255 characters as the
/// contract counts them (UTF-16).
pub fn is_import_path(text: &str) -> bool {
    (1..=255).contains(&text.encode_utf16().count())
        && !text.starts_with('/')
        && !text.starts_with('-')
        && !text.contains('\0')
        && text.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

/// How much bigger a screen draws everything: 0.5 to 4 times. NaN is no scale.
fn is_scale(scale: f64) -> bool {
    (0.5..=4.0).contains(&scale)
}

/// A screen's mode as `--mode` takes it, `1920x1080@60`: the rate to three decimals at most, written the way the
/// contract's `displayModeArg` writes it (`Number(refresh.toFixed(3))`). Pure.
pub fn mode_arg(mode: &Mode) -> String {
    let refresh = (mode.refresh * 1000.0).round() / 1000.0;
    format!("{}x{}@{refresh}", mode.width, mode.height)
}

pub fn wifi_connect_args(ssid: &str, with_password: bool) -> Result<Vec<String>, String> {
    if !is_ssid(ssid) {
        return Err(format!("{ssid:?} is not a Wi-Fi network's name"));
    }
    let mut args = owned(&["os", "network", "wifi", "connect"]);
    if with_password {
        args.push("--password-stdin".into());
    }
    args.extend(["--".into(), ssid.to_string()]);
    Ok(args)
}

pub fn wifi_forget_args(ssid: &str) -> Result<Vec<String>, String> {
    if !is_ssid(ssid) {
        return Err(format!("{ssid:?} is not a Wi-Fi network's name"));
    }
    Ok(owned(&["os", "network", "wifi", "forget", "--", ssid]))
}

pub fn wifi_radio_args(on: bool) -> Vec<String> {
    owned(&["os", "network", "wifi", if on { "on" } else { "off" }])
}

/// At least one of the two: a volume 0-100 (rounded, as the contract rounds it), and muted or not.
pub fn sound_set_args(volume: Option<f64>, muted: Option<bool>) -> Result<Vec<String>, String> {
    let mut args = owned(&["os", "sound", "set"]);
    if let Some(volume) = volume {
        let rounded = volume.round();
        if !(0.0..=100.0).contains(&rounded) {
            return Err(format!("{volume} is not a volume from 0 to 100"));
        }
        // Whole, as the contract's `String(Math.round(volume))` writes it: never `-0` for a hair under nothing.
        args.extend(["--volume".into(), (rounded as u8).to_string()]);
    }
    if let Some(muted) = muted {
        args.push(if muted { "--mute" } else { "--unmute" }.into());
    }
    if args.len() == 3 {
        return Err("a sound change names a volume, muted, or both".into());
    }
    args.push("--json".into());
    Ok(args)
}

pub fn sound_output_args(id: u32) -> Vec<String> {
    owned(&["os", "sound", "output", &id.to_string()])
}

/// At least one of the two: a mode the screen offers, and how much bigger everything is drawn.
pub fn display_set_args(
    output: &str,
    mode: Option<&Mode>,
    scale: Option<f64>,
) -> Result<Vec<String>, String> {
    if !is_output_name(output) {
        return Err(format!("{output:?} is not a screen's name"));
    }
    let mut args = owned(&["os", "display", "set", output]);
    if let Some(mode) = mode {
        if !mode.valid() {
            return Err("a screen's mode has pixels across and down, and a rate".into());
        }
        args.extend(["--mode".into(), mode_arg(mode)]);
    }
    if let Some(scale) = scale {
        if !is_scale(scale) {
            return Err(format!("{scale} is not a size from 0.5 to 4 times"));
        }
        args.extend(["--scale".into(), format!("{scale}")]);
    }
    if args.len() == 4 {
        return Err("a display change names a mode, a scale, or both".into());
    }
    Ok(args)
}

pub fn keyboard_set_args(layout: &str, variant: Option<&str>) -> Result<Vec<String>, String> {
    if !is_xkb_name(layout) {
        return Err(format!("{layout:?} is not a keyboard layout"));
    }
    let mut args = owned(&["os", "keyboard", "set", layout]);
    if let Some(variant) = variant {
        if !is_xkb_name(variant) {
            return Err(format!("{variant:?} is not a keyboard layout's variant"));
        }
        args.extend(["--variant".into(), variant.to_string()]);
    }
    Ok(args)
}

pub fn drive_import_args(
    device: &str,
    sandbox: &str,
    path: Option<&str>,
) -> Result<Vec<String>, String> {
    if !is_block_device(device) {
        return Err(format!("{device:?} is not a drive"));
    }
    if !is_sandbox_slug(sandbox) {
        return Err(format!("{sandbox:?} is not a sandbox"));
    }
    let mut args = owned(&["os", "drives", "import", device, "--to", sandbox]);
    if let Some(path) = path {
        if !is_import_path(path) {
            return Err(format!("{path:?} is not a folder inside the sandbox"));
        }
        args.extend(["--path".into(), path.to_string()]);
    }
    args.push("--json".into());
    Ok(args)
}

pub fn drive_eject_args(device: &str) -> Result<Vec<String>, String> {
    if !is_block_device(device) {
        return Err(format!("{device:?} is not a drive"));
    }
    Ok(owned(&["os", "drives", "eject", device]))
}

/// A Wi-Fi password goes on ic's stdin as one line, never on its command line (`ps` shows that to anyone here).
fn check_password(password: &str) -> Result<(), String> {
    if password.len() > 256 || password.contains(['\n', '\r', '\0']) {
        return Err("A Wi-Fi password is one line.".into());
    }
    Ok(())
}

/* WHAT `ic os` SAID: the contract's shapes, read strictly, so what reaches a card is what its types say. A key a newer ic
 * adds is dropped, as the contract's schemas drop it. */

/// An answer of ic's, checked past what its type says: a percentage is at most 100, a mode has pixels.
trait Answer: DeserializeOwned {
    fn valid(&self) -> bool {
        true
    }
}

/// The answer in what ic printed: its one object, read and checked. Pure.
fn answer<T: Answer>(stdout: &str) -> Option<T> {
    scripts::json_object_in(stdout)
        .and_then(|object| serde_json::from_value::<T>(object).ok())
        .filter(T::valid)
}

fn percent(value: u8) -> bool {
    value <= 100
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkKind {
    Wifi,
    Ethernet,
    #[serde(rename = "none")]
    Offline,
}

/// `ic os network status --json`: how this machine is online right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub connected: bool,
    pub kind: NetworkKind,
    pub name: Option<String>,
    pub signal: Option<u8>,
}

impl Answer for NetworkStatus {
    fn valid(&self) -> bool {
        self.signal.is_none_or(percent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    pub ssid: String,
    pub signal: u8,
    pub secured: bool,
    pub known: bool,
    pub active: bool,
}

/// `ic os network wifi list --json`: the networks in reach, strongest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiList {
    pub adapter: bool,
    pub enabled: bool,
    pub networks: Vec<WifiNetwork>,
}

impl Answer for WifiList {
    fn valid(&self) -> bool {
        self.networks.iter().all(|network| percent(network.signal))
    }
}

/// `ic os sound status --json`, and what `ic os sound set --json` says after a change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundStatus {
    pub volume: u8,
    pub muted: bool,
    pub output: Option<String>,
}

impl Answer for SoundStatus {
    fn valid(&self) -> bool {
        percent(self.volume)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundOutput {
    pub id: u32,
    pub name: String,
    pub default: bool,
}

/// `ic os sound outputs --json`: every speaker, headphone and screen that plays sound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundOutputs {
    pub outputs: Vec<SoundOutput>,
}

impl Answer for SoundOutputs {}

/// A screen's mode: pixels across and down, and how many times a second it redraws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub refresh: f64,
}

impl Mode {
    fn valid(&self) -> bool {
        self.width > 0 && self.height > 0 && self.refresh.is_finite() && self.refresh >= 0.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub name: String,
    pub make: Option<String>,
    pub model: Option<String>,
    pub enabled: bool,
    pub current: Option<Mode>,
    pub modes: Vec<Mode>,
    pub scale: Option<f64>,
}

/// `ic os display list --json`: every screen, by the connector the other verbs name it by.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayList {
    pub outputs: Vec<Display>,
}

impl Answer for DisplayList {
    fn valid(&self) -> bool {
        self.outputs.iter().all(|output| {
            output.modes.iter().chain(&output.current).all(Mode::valid)
                && output.scale.is_none_or(|scale| scale > 0.0)
        })
    }
}

/// `ic os keyboard status --json`: the layout in use, its variant, and its name for a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardStatus {
    pub layout: String,
    pub variant: Option<String>,
    pub name: Option<String>,
}

impl Answer for KeyboardStatus {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardVariant {
    pub variant: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardLayout {
    pub layout: String,
    pub name: String,
    pub variants: Vec<KeyboardVariant>,
}

/// `ic os keyboard layouts --json`: every layout xkb knows, each with its variants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardLayouts {
    pub layouts: Vec<KeyboardLayout>,
}

impl Answer for KeyboardLayouts {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DriveKind {
    Usb,
    Card,
    Other,
}

/// One removable drive as `ic os drives list --json` says it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub device: String,
    pub label: Option<String>,
    pub size: u64,
    pub filesystem: Option<String>,
    pub mounted_at: Option<String>,
    pub read_only: bool,
    pub model: Option<String>,
    pub kind: DriveKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drives {
    pub drives: Vec<Drive>,
}

impl Answer for Drives {}

/// How far a copy has got, as `ic os drives import --json` prints it every few seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Progress {
    pub bytes: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
struct ProgressLine {
    progress: Progress,
}

/// What a copy brought in: the folder inside the sandbox, and how many bytes in how many files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub device: String,
    pub sandbox: String,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
}

/* RUNNING `ic os`. */

/// `ic os <args>`, from the OS's own ic, to its exit or killed at `limit` with all it started; `input` on its stdin.
fn call<S: AsRef<str>>(
    image: &Image,
    args: &[S],
    input: Option<&[u8]>,
    limit: Duration,
) -> Result<Captured, String> {
    let borrowed: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    let command = os::ic_os_command(image, &borrowed)?;
    let ran = match input {
        Some(input) => intentic_bounded::capture_with_input(command, input, limit, Reach::Tree),
        None => intentic_bounded::capture(command, limit, Reach::Tree),
    }
    .map_err(|error| format!("ic os would not run: {error}"))?;
    if ran.timed_out {
        return Err(format!(
            "{} did not answer within {}s",
            said_as(&borrowed),
            limit.as_secs()
        ));
    }
    Ok(ran)
}

/// A call as its errors name it: ic and its verb, up to the first flag. Pure.
fn said_as<S: AsRef<str>>(args: &[S]) -> String {
    let verb: Vec<&str> = args
        .iter()
        .map(AsRef::as_ref)
        .take_while(|part| !part.starts_with('-'))
        .collect();
    format!("ic {}", verb.join(" "))
}

/// ic says there is nothing here for this card: not Intentic OS, or (a screen verb) an edition with no screen. Pure.
fn not_here(code: Option<i32>, screen: bool) -> bool {
    code == Some(EXIT_NOT_OS) || (screen && code == Some(EXIT_NO_SCREEN))
}

/// A read: none where ic says there is nothing here for it ([`not_here`]), `Err` with ic's words when it failed.
fn read<T: Answer, S: AsRef<str>>(
    image: &Image,
    args: &[S],
    limit: Duration,
    screen: bool,
) -> Result<Option<T>, String> {
    let ran = call(image, args, None, limit)?;
    if not_here(ran.code, screen) {
        return Ok(None);
    }
    let what = said_as(args);
    if !ran.success() {
        return Err(os::last_words(&ran.stdout, &ran.stderr, &what));
    }
    answer(&ran.stdout)
        .map(Some)
        .ok_or_else(|| format!("{what} said nothing this app can read"))
}

/// A change: what ic printed when it was made, `Err` with ic's words when it was not.
fn change<S: AsRef<str>>(image: &Image, args: &[S], limit: Duration) -> Result<Captured, String> {
    let ran = call(image, args, None, limit)?;
    match ran.code {
        Some(0) => Ok(ran),
        Some(EXIT_NOT_OS) => Err(NOT_OS.into()),
        Some(EXIT_NO_SCREEN) => Err(NO_SCREEN.into()),
        _ => Err(os::last_words(&ran.stdout, &ran.stderr, &said_as(args))),
    }
}

/// `job` with the OS's own ic, on a thread that may block: every call waits on a child.
async fn off_thread<T: Send + 'static>(
    job: impl FnOnce(&Image) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || job(&Image::installed()))
        .await
        .map_err(|error| error.to_string())?
}

fn intentic_os() -> Result<(), String> {
    if os::is_intentic_os() {
        Ok(())
    } else {
        Err(NOT_OS.into())
    }
}

/* THE NETWORK. */

/// `ic os network status --json`. Null on a computer that is not Intentic OS.
#[tauri::command]
pub async fn os_network_status() -> Result<Option<NetworkStatus>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    off_thread(|image| read(image, &NETWORK_STATUS_ARGS, READ_LIMIT, false)).await
}

/// `ic os network wifi list --json`: rescans first, so it takes a few seconds. Null on a computer that is not Intentic OS.
#[tauri::command]
pub async fn os_wifi_list() -> Result<Option<WifiList>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    off_thread(|image| read(image, &WIFI_LIST_ARGS, WIFI_LIST_LIMIT, false)).await
}

/// How joining a network went. `needsPassword`: it asks for one and none was given; `wrongPassword`: the one given was
/// refused; `failed`: something else, in ic's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiJoin {
    pub outcome: &'static str,
    pub reason: Option<String>,
}

/// The join's outcome from ic's exit. Pure.
fn join_from(ran: &Captured, with_password: bool) -> WifiJoin {
    let (outcome, reason) = match ran.code {
        Some(0) => ("joined", None),
        Some(EXIT_WIFI_PASSWORD) if with_password => ("wrongPassword", None),
        Some(EXIT_WIFI_PASSWORD) => ("needsPassword", None),
        Some(EXIT_NOT_OS) => ("notOs", None),
        _ => (
            "failed",
            Some(os::last_words(
                &ran.stdout,
                &ran.stderr,
                "ic os network wifi connect",
            )),
        ),
    };
    WifiJoin { outcome, reason }
}

/// `ic os network wifi connect [--password-stdin] -- <ssid>`: a known network or an open one joins without a password;
/// one that wants a password answers `needsPassword`, and the page asks the person and comes back with it. The
/// password goes on ic's stdin, never on its command line.
#[tauri::command]
pub async fn os_wifi_connect(ssid: String, password: Option<String>) -> Result<WifiJoin, String> {
    intentic_os()?;
    let password = password.filter(|password| !password.is_empty());
    if let Some(password) = &password {
        check_password(password)?;
    }
    let with_password = password.is_some();
    let args = wifi_connect_args(&ssid, with_password)?;
    off_thread(move |image| {
        let line = password.map(|password| format!("{password}\n").into_bytes());
        let ran = call(image, &args, line.as_deref(), WIFI_JOIN_LIMIT)?;
        Ok(join_from(&ran, with_password))
    })
    .await
}

/// `ic os network wifi forget -- <ssid>`: this computer no longer rejoins it by itself.
#[tauri::command]
pub async fn os_wifi_forget(ssid: String) -> Result<(), String> {
    intentic_os()?;
    let args = wifi_forget_args(&ssid)?;
    off_thread(move |image| change(image, &args, CHANGE_LIMIT).map(drop)).await
}

/// `ic os network wifi on|off`.
#[tauri::command]
pub async fn os_wifi_radio(on: bool) -> Result<(), String> {
    intentic_os()?;
    off_thread(move |image| change(image, &wifi_radio_args(on), CHANGE_LIMIT).map(drop)).await
}

/* THE SOUND. */

/// `ic os sound status --json`. Null on a computer that is not Intentic OS.
#[tauri::command]
pub async fn os_sound_status() -> Result<Option<SoundStatus>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    off_thread(|image| read(image, &SOUND_STATUS_ARGS, READ_LIMIT, false)).await
}

/// `ic os sound set [--volume N] [--mute|--unmute] --json`: the status after, or null where ic printed none this app
/// can read (the page reads it again).
#[tauri::command]
pub async fn os_sound_set(
    volume: Option<f64>,
    muted: Option<bool>,
) -> Result<Option<SoundStatus>, String> {
    intentic_os()?;
    let args = sound_set_args(volume, muted)?;
    off_thread(move |image| Ok(answer(&change(image, &args, CHANGE_LIMIT)?.stdout))).await
}

/// `ic os sound outputs --json`. Null on a computer that is not Intentic OS.
#[tauri::command]
pub async fn os_sound_outputs() -> Result<Option<SoundOutputs>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    off_thread(|image| read(image, &SOUND_OUTPUTS_ARGS, READ_LIMIT, false)).await
}

/// `ic os sound output <id>`: play through that one from now on.
#[tauri::command]
pub async fn os_sound_output(id: u32) -> Result<(), String> {
    intentic_os()?;
    off_thread(move |image| change(image, &sound_output_args(id), CHANGE_LIMIT).map(drop)).await
}

/* THE SCREENS AND THE KEYBOARD: none on the server edition, where ic exits IC_OS_NO_SCREEN_EXIT and the cards hide. */

/// `ic os display list --json`. Null on a computer that is not Intentic OS, or has no screen.
#[tauri::command]
pub async fn os_display_list() -> Result<Option<DisplayList>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    off_thread(|image| read(image, &DISPLAY_LIST_ARGS, READ_LIMIT, true)).await
}

/// `ic os display set <output> [--mode WxH@Hz] [--scale N]`.
#[tauri::command]
pub async fn os_display_set(
    output: String,
    mode: Option<Mode>,
    scale: Option<f64>,
) -> Result<(), String> {
    intentic_os()?;
    let args = display_set_args(&output, mode.as_ref(), scale)?;
    off_thread(move |image| change(image, &args, CHANGE_LIMIT).map(drop)).await
}

/// `ic os keyboard status --json`. Null on a computer that is not Intentic OS, or has no screen.
#[tauri::command]
pub async fn os_keyboard_status() -> Result<Option<KeyboardStatus>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    off_thread(|image| read(image, &KEYBOARD_STATUS_ARGS, READ_LIMIT, true)).await
}

/// `ic os keyboard layouts --json`: every layout xkb knows (about 40 KB). Null where the status is.
#[tauri::command]
pub async fn os_keyboard_layouts() -> Result<Option<KeyboardLayouts>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    off_thread(|image| read(image, &KEYBOARD_LAYOUTS_ARGS, READ_LIMIT, true)).await
}

/// `ic os keyboard set <layout> [--variant v]`.
#[tauri::command]
pub async fn os_keyboard_set(layout: String, variant: Option<String>) -> Result<(), String> {
    intentic_os()?;
    let args = keyboard_set_args(&layout, variant.as_deref())?;
    off_thread(move |image| change(image, &args, CHANGE_LIMIT).map(drop)).await
}

/* THE DRIVES A PERSON PLUGS IN, watched by a thread of their own. */

/// What every window hears of the drives: the list whenever it changes ([`DrivesSeen`]).
pub const DRIVES_EVENT: &str = "desktop://os-drives";

/// How often the watcher asks ic which drives are in: a drive plugged in shows within a few seconds.
const WATCH_EVERY: Duration = Duration::from_secs(3);

/// The drives plugged in, and which of them arrived since the reader last looked at the Drives card: the card lights
/// those up, and This device brings the card into view for them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrivesSeen {
    pub drives: Vec<Drive>,
    pub fresh: Vec<String>,
}

/// The same drive as before: the same device holding the same stick, not another put in its place between two reads.
fn same_drive(one: &Drive, other: &Drive) -> bool {
    one.device == other.device && one.size == other.size && one.model == other.model
}

/// What changed between two reads of the drives.
#[derive(Debug, Default, PartialEq, Eq)]
struct Turn {
    /// Plugged in since the last read, each worth a notification.
    arrived: Vec<Drive>,
    /// Gone since the last read: their notifications come down.
    left: Vec<String>,
    /// The windows are told again.
    changed: bool,
}

/// What the watcher knows.
#[derive(Debug, Default)]
struct Watch {
    /// What the last read listed; none before the first, whose drives were already in and are nobody's news.
    known: Option<Vec<Drive>>,
    /// Devices plugged in since, not yet seen on the Drives card.
    fresh: BTreeSet<String>,
}

impl Watch {
    /// Take a read of the drives. Pure.
    fn take(&mut self, drives: Vec<Drive>) -> Turn {
        let Some(known) = self.known.replace(drives.clone()) else {
            return Turn {
                changed: true,
                ..Turn::default()
            };
        };
        let arrived: Vec<Drive> = drives
            .iter()
            .filter(|drive| !known.iter().any(|old| same_drive(old, drive)))
            .cloned()
            .collect();
        let left: Vec<String> = known
            .iter()
            .filter(|old| !drives.iter().any(|drive| same_drive(old, drive)))
            .map(|old| old.device.clone())
            .collect();
        let fresh_before = self.fresh.clone();
        for device in &left {
            self.fresh.remove(device);
        }
        for drive in &arrived {
            self.fresh.insert(drive.device.clone());
        }
        Turn {
            changed: drives != known || self.fresh != fresh_before,
            arrived,
            left,
        }
    }

    /// The reader has seen these on the Drives card, or copied or ejected them: they are news no more. Answers whether
    /// any was. Pure.
    fn seen(&mut self, devices: &[String]) -> bool {
        // Every one taken out: `any` would stop at the first.
        let mut any = false;
        for device in devices {
            any |= self.fresh.remove(device);
        }
        any
    }

    fn snapshot(&self) -> Option<DrivesSeen> {
        self.known.as_ref().map(|drives| DrivesSeen {
            drives: drives.clone(),
            fresh: self.fresh.iter().cloned().collect(),
        })
    }
}

static WATCH: LazyLock<Mutex<Watch>> = LazyLock::new(Mutex::default);

fn watch() -> MutexGuard<'static, Watch> {
    WATCH.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The words of a drive's notification, in the reader's language: the page hands them over (`os_drive_words`), since
/// this side has no translations; English until a page has. `{name}` is the drive's label, else its model.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveWords {
    pub usb_named: String,
    pub usb: String,
    pub card_named: String,
    pub card: String,
    pub other_named: String,
    pub other: String,
    pub body: String,
}

impl Default for DriveWords {
    fn default() -> DriveWords {
        DriveWords {
            usb_named: "USB drive {name} plugged in".into(),
            usb: "USB drive plugged in".into(),
            card_named: "Memory card {name} put in".into(),
            card: "Memory card put in".into(),
            other_named: "Drive {name} plugged in".into(),
            other: "Drive plugged in".into(),
            body: "Choose where it goes".into(),
        }
    }
}

/// The longest a notification's line may be: a lock screen's worth.
const WORDS_MAX: usize = 120;
/// The longest a drive's name may be in one: a label is 11 characters on a FAT stick, a model a few words.
const NAME_MAX: usize = 48;

impl DriveWords {
    /// Lines a notification can carry, each naming the drive where it is to. Pure.
    fn valid(&self) -> bool {
        let line = |text: &str| {
            (1..=WORDS_MAX).contains(&text.chars().count()) && !text.chars().any(char::is_control)
        };
        [&self.usb_named, &self.card_named, &self.other_named]
            .iter()
            .all(|named| line(named) && named.contains("{name}"))
            && [&self.usb, &self.card, &self.other, &self.body]
                .iter()
                .all(|text| line(text))
    }
}

static WORDS: LazyLock<Mutex<DriveWords>> = LazyLock::new(Mutex::default);

/// What a person calls a drive: its label, else its model, without anything a notification cannot show. Pure.
fn drive_name(drive: &Drive) -> Option<String> {
    [&drive.label, &drive.model]
        .into_iter()
        .flatten()
        .map(|name| {
            name.chars()
                .filter(|character| !character.is_control())
                .collect::<String>()
                .trim()
                .chars()
                .take(NAME_MAX)
                .collect::<String>()
        })
        .find(|name| !name.is_empty())
}

/// The notification a drive's notice is kept under, so the same drive replaces it and its leaving takes it down.
fn notice_key(device: &str) -> String {
    format!("os-drive:{device}")
}

/// The notification for a drive just plugged in: a press opens This device, where its card says where it can go. Pure.
fn notice_for(words: &DriveWords, drive: &Drive) -> NoticeArgs {
    let (named, plain) = match drive.kind {
        DriveKind::Usb => (&words.usb_named, &words.usb),
        DriveKind::Card => (&words.card_named, &words.card),
        DriveKind::Other => (&words.other_named, &words.other),
    };
    let title = match drive_name(drive) {
        Some(name) => named.replace("{name}", &name),
        None => plain.clone(),
    };
    NoticeArgs {
        key: notice_key(&drive.device),
        kind: NoticeKind::Asks,
        title,
        body: Some(words.body.clone()),
        path: Some(crate::notice::THIS_DEVICE.to_string()),
        silent: false,
    }
}

fn tell(app: &AppHandle, seen: Option<DrivesSeen>) {
    if let Some(seen) = seen {
        if let Err(error) = app.emit(DRIVES_EVENT, &seen) {
            eprintln!("intentic: the windows could not be told about the drives: {error}");
        }
    }
}

/// A drive is settled (copied, ejected, seen): no longer fresh, and its notification comes down.
fn settle(app: &AppHandle, devices: &[String]) {
    let snapshot = {
        let mut watch = watch();
        watch.seen(devices).then(|| watch.snapshot()).flatten()
    };
    for device in devices {
        crate::notice::withdraw(app, &notice_key(device));
    }
    tell(app, snapshot);
}

/// One read of the drives, and what follows from it. False once ic says this is not Intentic OS: nothing to watch.
fn round(app: &AppHandle, failing: &mut bool) -> bool {
    let drives = match read::<Drives, _>(&Image::installed(), &DRIVES_LIST_ARGS, READ_LIMIT, false)
    {
        Ok(Some(list)) => list.drives,
        Ok(None) => return false,
        Err(error) => {
            // Said once when it starts failing, not every few seconds while it goes on.
            if !std::mem::replace(failing, true) {
                eprintln!("intentic: the drives could not be read: {error}");
            }
            return true;
        }
    };
    *failing = false;
    let (turn, snapshot) = {
        let mut watch = watch();
        let turn = watch.take(drives);
        let snapshot = turn.changed.then(|| watch.snapshot()).flatten();
        (turn, snapshot)
    };
    tell(app, snapshot);
    for device in &turn.left {
        crate::notice::withdraw(app, &notice_key(device));
    }
    if !turn.arrived.is_empty() {
        let words = WORDS.lock().unwrap_or_else(PoisonError::into_inner).clone();
        for drive in &turn.arrived {
            crate::notice::show(app, notice_for(&words, drive));
        }
    }
    true
}

/// Start watching the drives (lib.rs, once the app's notifications are managed). Nothing anywhere but Intentic OS.
pub fn start(app: &AppHandle) {
    if !os::is_intentic_os() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("os-drives".into())
        .spawn(move || {
            let mut failing = false;
            while round(&app, &mut failing) {
                std::thread::sleep(WATCH_EVERY);
            }
        });
    if let Err(error) = spawned {
        eprintln!("intentic: no thread to watch the drives: {error}");
    }
}

/// The drives plugged in and which are fresh, as the watcher last read them; read now where it has not yet. Null on a
/// computer that is not Intentic OS.
#[tauri::command]
pub async fn os_drives_list() -> Result<Option<DrivesSeen>, String> {
    if !os::is_intentic_os() {
        return Ok(None);
    }
    let snapshot = watch().snapshot();
    if snapshot.is_some() {
        return Ok(snapshot);
    }
    off_thread(|image| {
        Ok(
            read::<Drives, _>(image, &DRIVES_LIST_ARGS, READ_LIMIT, false)?.map(|list| {
                DrivesSeen {
                    drives: list.drives,
                    fresh: Vec::new(),
                }
            }),
        )
    })
    .await
}

/// The reader has seen these drives on the Drives card: no longer lit up, and their notifications come down.
#[tauri::command]
pub fn os_drives_seen(app: AppHandle, devices: Vec<String>) {
    settle(&app, &devices);
}

/// The page's words for a drive's notification, in the reader's language (its i18n catalog): a window hands them over
/// as it starts, and each language change after.
#[tauri::command]
pub fn os_drive_words(words: DriveWords) -> Result<(), String> {
    if !words.valid() {
        return Err(
            "a drive's notification is a few words on a line, with {name} where named".into(),
        );
    }
    *WORDS.lock().unwrap_or_else(PoisonError::into_inner) = words;
    Ok(())
}

/// `ic os drives eject <device>`: unmounted, everything written out, and powered off, so it can be pulled out.
#[tauri::command]
pub async fn os_drive_eject(app: AppHandle, device: String) -> Result<(), String> {
    intentic_os()?;
    let args = drive_eject_args(&device)?;
    off_thread(move |image| change(image, &args, EJECT_LIMIT).map(drop)).await?;
    settle(&app, &[device]);
    Ok(())
}

/* A COPY OFF A DRIVE INTO A SANDBOX: minutes or hours long, one at a time, followed by every window. */

/// What every window hears of a copy ([`Copying`]).
pub const IMPORT_EVENT: &str = "desktop://os-drive-import";

/// The run a copy streams under (`desktop://run`, its transcript, what `run_stop` stops).
pub const IMPORT_RUN: &str = "os-drive-import";

/// How a copy ended, for the window that asked and every window following it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEnd {
    pub device: String,
    pub sandbox: String,
    /// `done`: copied ([`Imported`] says what). `noRoom`: it would not fit, and nothing was copied. `stopped`: the
    /// reader stopped it. `failed`: it stopped of itself. `notOs`: ic says this is not Intentic OS. `busy`: another copy
    /// was running, and this one never started.
    pub outcome: &'static str,
    pub copied: Option<Imported>,
    pub code: Option<i32>,
    pub timed_out: bool,
    /// Why it stopped, in ic's words: for `noRoom`, how much it needs and how much is free.
    pub reason: Option<String>,
    pub log: Option<String>,
    /// ic ran, so its progress and this end reached every window.
    pub ran: bool,
}

/// What every window hears of a copy, in order: `started`, `progress` every few seconds, then `exit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Copying {
    Started {
        device: String,
        sandbox: String,
    },
    Progress {
        device: String,
        sandbox: String,
        bytes: u64,
        total: u64,
    },
    Exit(ImportEnd),
}

/// What a copy said that its ending is read from: its result line, and ic's words on stderr.
#[derive(Debug, Default)]
struct ImportReading {
    copied: Option<Imported>,
    words: Reading,
}

impl ImportReading {
    /// One line of the copy; answers the progress it reports, when it is a progress line. Pure.
    fn hear(&mut self, stream: Stream, line: &str) -> Option<Progress> {
        if stream == Stream::Stderr {
            self.words.hear(stream, line);
            return None;
        }
        let line = line.trim();
        if let Ok(said) = serde_json::from_str::<ProgressLine>(line) {
            return Some(said.progress);
        }
        if let Ok(copied) = serde_json::from_str::<Imported>(line) {
            self.copied = Some(copied);
        }
        None
    }

    /// How the copy ended, from ic's exit and what it said on the way. Pure.
    fn end(
        &self,
        device: String,
        sandbox: String,
        code: Option<i32>,
        timed_out: bool,
        log: Option<String>,
    ) -> ImportEnd {
        let outcome = match code {
            Some(0) if !timed_out => "done",
            Some(EXIT_NO_ROOM) => "noRoom",
            Some(EXIT_NOT_OS) => "notOs",
            // Killed with no exit of its own and not by the limit: the reader's Stop.
            None if !timed_out => "stopped",
            _ => "failed",
        };
        ImportEnd {
            device,
            sandbox,
            outcome,
            copied: (outcome == "done").then(|| self.copied.clone()).flatten(),
            code,
            timed_out,
            reason: matches!(outcome, "noRoom" | "failed")
                .then(|| self.words.reason())
                .flatten(),
            log,
            ran: true,
        }
    }
}

/// A copy refused before it began: another is running. Told to no window. Pure.
fn import_refused(device: String, sandbox: String) -> ImportEnd {
    ImportEnd {
        device,
        sandbox,
        outcome: "busy",
        copied: None,
        code: None,
        timed_out: false,
        reason: None,
        log: None,
        ran: false,
    }
}

static IMPORTING: AtomicBool = AtomicBool::new(false);

/// The one copy at a time, given back when dropped.
struct ImportClaim(());

impl Drop for ImportClaim {
    fn drop(&mut self) {
        IMPORTING.store(false, Ordering::SeqCst);
    }
}

fn claim_import() -> Option<ImportClaim> {
    if IMPORTING.swap(true, Ordering::SeqCst) {
        None
    } else {
        Some(ImportClaim(()))
    }
}

/// Run the copy with the OS's own ic and tell every window how far it got ([`IMPORT_EVENT`]). BLOCKING, for as long as
/// the copy takes. `Err` only when it never started.
fn import(
    app: &AppHandle,
    image: &Image,
    args: &[String],
    device: String,
    sandbox: String,
) -> Result<ImportEnd, String> {
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let command = os::ic_os_command(image, &borrowed)?;
    let _ = app.emit(
        IMPORT_EVENT,
        Copying::Started {
            device: device.clone(),
            sandbox: sandbox.clone(),
        },
    );
    let reading = Arc::new(Mutex::new(ImportReading::default()));
    let heard: Heard = {
        let app = app.clone();
        let reading = Arc::clone(&reading);
        let (device, sandbox) = (device.clone(), sandbox.clone());
        Arc::new(move |stream: Stream, line: &str| {
            let progress = reading
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .hear(stream, line);
            if let Some(Progress { bytes, total }) = progress {
                let _ = app.emit(
                    IMPORT_EVENT,
                    Copying::Progress {
                        device: device.clone(),
                        sandbox: sandbox.clone(),
                        bytes,
                        total,
                    },
                );
            }
        })
    };
    let ended = match scripts::run_command_heard(
        app,
        IMPORT_RUN,
        "ic os drives import",
        command,
        Some(IMPORT_LIMIT),
        Some(heard),
    ) {
        Ok(ended) => ended,
        Err(error) => {
            // The windows were told it began: they are told it is over, with why.
            let _ = app.emit(
                IMPORT_EVENT,
                Copying::Exit(ImportEnd {
                    outcome: "failed",
                    reason: Some(error.clone()),
                    ..import_refused(device, sandbox)
                }),
            );
            return Err(error);
        }
    };
    let end = reading.lock().unwrap_or_else(PoisonError::into_inner).end(
        device,
        sandbox,
        ended.code,
        ended.timed_out,
        ended.log,
    );
    let _ = app.emit(IMPORT_EVENT, Copying::Exit(end.clone()));
    if end.outcome == "done" {
        settle(app, std::slice::from_ref(&end.device));
    }
    Ok(end)
}

/// `ic os drives import <device> --to <sandbox> [--path <folder>] --json`: everything on the drive copied into the
/// sandbox, into `/work/Imports/<label>-<date>/` unless a folder is named. Answered `busy` while another copy runs.
#[tauri::command]
pub async fn os_drive_import(
    app: AppHandle,
    device: String,
    sandbox: String,
    path: Option<String>,
) -> Result<ImportEnd, String> {
    intentic_os()?;
    let path = path.filter(|path| !path.trim().is_empty());
    let args = drive_import_args(&device, &sandbox, path.as_deref())?;
    let Some(claim) = claim_import() else {
        return Ok(import_refused(device, sandbox));
    };
    off_thread(move |image| {
        let _claim = claim;
        import(&app, image, &args, device, sandbox)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn strings(parts: &[&str]) -> Vec<String> {
        owned(parts)
    }

    /// What a builder answered, and the contract's array for it.
    type Case<'a> = (Result<Vec<String>, String>, &'a [&'a str]);

    /// The contract's argv builders (intentic-os.ts), array for array.
    #[test]
    fn each_verb_is_spelled_as_the_contract_spells_it() {
        assert_eq!(NETWORK_STATUS_ARGS, ["os", "network", "status", "--json"]);
        assert_eq!(WIFI_LIST_ARGS, ["os", "network", "wifi", "list", "--json"]);
        assert_eq!(SOUND_STATUS_ARGS, ["os", "sound", "status", "--json"]);
        assert_eq!(SOUND_OUTPUTS_ARGS, ["os", "sound", "outputs", "--json"]);
        assert_eq!(DISPLAY_LIST_ARGS, ["os", "display", "list", "--json"]);
        assert_eq!(KEYBOARD_STATUS_ARGS, ["os", "keyboard", "status", "--json"]);
        assert_eq!(
            KEYBOARD_LAYOUTS_ARGS,
            ["os", "keyboard", "layouts", "--json"]
        );
        assert_eq!(DRIVES_LIST_ARGS, ["os", "drives", "list", "--json"]);
        let cases: [Case; 17] = [
            (
                wifi_connect_args("Café: Guest", false),
                &["os", "network", "wifi", "connect", "--", "Café: Guest"],
            ),
            (
                wifi_connect_args("--forget-me", true),
                &[
                    "os",
                    "network",
                    "wifi",
                    "connect",
                    "--password-stdin",
                    "--",
                    "--forget-me",
                ],
            ),
            (
                wifi_forget_args("Office"),
                &["os", "network", "wifi", "forget", "--", "Office"],
            ),
            (Ok(wifi_radio_args(true)), &["os", "network", "wifi", "on"]),
            (
                Ok(wifi_radio_args(false)),
                &["os", "network", "wifi", "off"],
            ),
            (
                sound_set_args(Some(39.6), None),
                &["os", "sound", "set", "--volume", "40", "--json"],
            ),
            (
                sound_set_args(Some(0.0), Some(true)),
                &["os", "sound", "set", "--volume", "0", "--mute", "--json"],
            ),
            (
                sound_set_args(Some(-0.4), None),
                &["os", "sound", "set", "--volume", "0", "--json"],
            ),
            (
                sound_set_args(None, Some(false)),
                &["os", "sound", "set", "--unmute", "--json"],
            ),
            (Ok(sound_output_args(58)), &["os", "sound", "output", "58"]),
            (
                display_set_args(
                    "DP-2",
                    Some(&Mode {
                        width: 1920,
                        height: 1080,
                        refresh: 59.94,
                    }),
                    Some(1.25),
                ),
                &[
                    "os",
                    "display",
                    "set",
                    "DP-2",
                    "--mode",
                    "1920x1080@59.94",
                    "--scale",
                    "1.25",
                ],
            ),
            (
                display_set_args("eDP-1", None, Some(2.0)),
                &["os", "display", "set", "eDP-1", "--scale", "2"],
            ),
            (
                keyboard_set_args("de", Some("nodeadkeys")),
                &["os", "keyboard", "set", "de", "--variant", "nodeadkeys"],
            ),
            (
                keyboard_set_args("us", None),
                &["os", "keyboard", "set", "us"],
            ),
            (
                drive_import_args("/dev/sda1", "work", None),
                &[
                    "os",
                    "drives",
                    "import",
                    "/dev/sda1",
                    "--to",
                    "work",
                    "--json",
                ],
            ),
            (
                drive_import_args("/dev/mmcblk0p1", "my.box", Some("Photos/2026")),
                &[
                    "os",
                    "drives",
                    "import",
                    "/dev/mmcblk0p1",
                    "--to",
                    "my.box",
                    "--path",
                    "Photos/2026",
                    "--json",
                ],
            ),
            (
                drive_eject_args("/dev/sdb1"),
                &["os", "drives", "eject", "/dev/sdb1"],
            ),
        ];
        for (args, expected) in cases {
            assert_eq!(args, Ok(strings(expected)), "{expected:?}");
        }
    }

    #[test]
    fn a_mode_is_written_to_three_decimals_at_most_as_the_contract_writes_it() {
        let mode = |refresh: f64| Mode {
            width: 2256,
            height: 1504,
            refresh,
        };
        assert_eq!(mode_arg(&mode(59.999)), "2256x1504@59.999");
        assert_eq!(mode_arg(&mode(60.0)), "2256x1504@60");
        assert_eq!(mode_arg(&mode(48.00049)), "2256x1504@48");
        assert_eq!(mode_arg(&mode(29.9814)), "2256x1504@29.981");
    }

    #[test]
    fn nothing_out_of_shape_reaches_ics_command_line() {
        for bad in ["", "-HDMI", "HDMI A", "HDMI/1", &"a".repeat(65)] {
            assert!(!is_output_name(bad), "{bad:?}");
        }
        for good in ["HDMI-A-1", "eDP-1", "DP-2", "Virtual.1"] {
            assert!(is_output_name(good), "{good:?}");
        }
        for bad in ["", "-de", "de nodeadkeys", "de;us", "de.x"] {
            assert!(!is_xkb_name(bad), "{bad:?}");
        }
        for good in ["us", "de", "nodeadkeys", "alt-intl", "dvorak+x"] {
            assert!(is_xkb_name(good), "{good:?}");
        }
        for bad in [
            "sda1",
            "/dev/",
            "/dev/-x",
            "/dev/../sda",
            "/dev/sda/1",
            "/dev/sd a",
        ] {
            assert!(!is_block_device(bad), "{bad:?}");
        }
        for good in ["/dev/sda1", "/dev/mmcblk0p1", "/dev/nvme0n1p2"] {
            assert!(is_block_device(good), "{good:?}");
        }
        for bad in ["", "-work", "a..b", "work/x", "my box"] {
            assert!(!is_sandbox_slug(bad), "{bad:?}");
        }
        for good in ["work", "my.box", "a_b-c"] {
            assert!(is_sandbox_slug(good), "{good:?}");
        }
        for bad in [
            "",
            "/Photos",
            "-x",
            "a/../b",
            "./a",
            "a//b",
            "a/",
            "a\0b",
            &"x".repeat(256),
        ] {
            assert!(!is_import_path(bad), "{bad:?}");
        }
        for good in ["Photos", "Photos/2026", "Fotos de mamá", "..hidden"] {
            assert!(is_import_path(good), "{good:?}");
        }
        assert!(is_ssid("Neighbours 5G"));
        assert!(is_ssid(&"é".repeat(16)));
        assert!(!is_ssid(&"é".repeat(17)));
        assert!(!is_ssid(""));
        assert!(!is_ssid("a\0b"));
        // Each builder refuses what its schema refuses, and a change that names nothing.
        assert!(wifi_connect_args("", false).is_err());
        assert!(wifi_forget_args(&"x".repeat(33)).is_err());
        assert!(sound_set_args(None, None).is_err());
        assert!(sound_set_args(Some(101.0), None).is_err());
        assert!(sound_set_args(Some(-1.0), None).is_err());
        assert!(sound_set_args(Some(f64::NAN), None).is_err());
        assert!(display_set_args("DP-2", None, None).is_err());
        assert!(display_set_args("DP-2", None, Some(5.0)).is_err());
        assert!(display_set_args("DP-2", None, Some(f64::NAN)).is_err());
        assert!(display_set_args("--all", None, Some(1.0)).is_err());
        let flat = Mode {
            width: 0,
            height: 1080,
            refresh: 60.0,
        };
        assert!(display_set_args("DP-2", Some(&flat), None).is_err());
        assert!(keyboard_set_args("de", Some("--x")).is_err());
        assert!(drive_import_args("/dev/sda1", "work", Some("../etc")).is_err());
        assert!(drive_import_args("sda1", "work", None).is_err());
        assert!(drive_import_args("/dev/sda1", "-x", None).is_err());
        assert!(drive_eject_args("/dev/../sda").is_err());
        assert!(check_password("hunter22 with spaces").is_ok());
        assert!(check_password("two\nlines").is_err());
        assert!(check_password(&"x".repeat(257)).is_err());
    }

    /// Every number as a float, so ic's `60` and this app's `60.0` read the same.
    fn floats(value: Value) -> Value {
        match value {
            Value::Number(number) => json!(number.as_f64()),
            Value::Array(items) => Value::Array(items.into_iter().map(floats).collect()),
            Value::Object(fields) => Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (key, floats(value)))
                    .collect(),
            ),
            other => other,
        }
    }

    fn reads_as_printed<T: Answer + Serialize>(golden: &Value, key: &str) {
        let examples = golden[key].as_array().expect("the golden examples");
        assert!(!examples.is_empty(), "{key}");
        for example in examples {
            let read: T = answer(&format!("ic: a line first\n{example}\n"))
                .unwrap_or_else(|| panic!("{key}: {example}"));
            assert_eq!(
                floats(serde_json::to_value(read).unwrap()),
                floats(example.clone()),
                "{key}"
            );
        }
    }

    impl Answer for ProgressLine {}
    impl Answer for Imported {}

    impl Serialize for ProgressLine {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            json!({ "progress": self.progress }).serialize(serializer)
        }
    }

    /// The contract's examples of what `ic os` prints (_shared/sandbox-contract/golden/intentic-os.json): every one reads
    /// here, field for field.
    #[test]
    fn every_answer_the_contract_pins_reads_as_ic_printed_it() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/golden/intentic-os.json"
        ))
        .expect("the golden file is JSON");
        reads_as_printed::<NetworkStatus>(&golden, "networkStatus");
        reads_as_printed::<WifiList>(&golden, "wifiList");
        reads_as_printed::<SoundStatus>(&golden, "soundStatus");
        reads_as_printed::<SoundOutputs>(&golden, "soundOutputs");
        reads_as_printed::<DisplayList>(&golden, "displayList");
        reads_as_printed::<KeyboardStatus>(&golden, "keyboardStatus");
        reads_as_printed::<KeyboardLayouts>(&golden, "keyboardLayouts");
        reads_as_printed::<Drives>(&golden, "drives");
        reads_as_printed::<ProgressLine>(&golden, "driveImportProgress");
        reads_as_printed::<Imported>(&golden, "driveImport");
    }

    #[test]
    fn an_answer_out_of_shape_is_none() {
        assert_eq!(
            answer::<NetworkStatus>(r#"{"connected":true,"kind":"wifi","name":"x","signal":101}"#),
            None
        );
        assert_eq!(
            answer::<NetworkStatus>(
                r#"{"connected":true,"kind":"cable","name":null,"signal":null}"#
            ),
            None
        );
        assert_eq!(
            answer::<SoundStatus>(r#"{"volume":140,"muted":false,"output":null}"#),
            None
        );
        assert_eq!(
            answer::<SoundStatus>(r#"{"volume":40.5,"muted":false,"output":null}"#),
            None
        );
        assert_eq!(
            answer::<DisplayList>(
                r#"{"outputs":[{"name":"x","make":null,"model":null,"enabled":true,"current":{"width":0,"height":1,"refresh":60},"modes":[],"scale":1}]}"#
            ),
            None
        );
        assert_eq!(
            answer::<Drives>(
                r#"{"drives":[{"device":"/dev/sda1","label":null,"size":1,"filesystem":null,"mountedAt":null,"readOnly":false,"model":null,"kind":"floppy"}]}"#
            ),
            None
        );
        assert_eq!(answer::<KeyboardStatus>("us"), None);
        assert_eq!(answer::<WifiList>(""), None);
        // A key a newer ic adds is dropped.
        assert_eq!(
            answer::<KeyboardStatus>(
                r#"{"layout":"us","variant":null,"name":"English (US)","model":"pc105"}"#
            ),
            Some(KeyboardStatus {
                layout: "us".into(),
                variant: None,
                name: Some("English (US)".into()),
            })
        );
    }

    #[test]
    fn a_call_is_named_by_its_verb_and_ic_says_when_there_is_nothing_here() {
        assert_eq!(said_as(&WIFI_LIST_ARGS), "ic os network wifi list");
        assert_eq!(
            said_as(&wifi_connect_args("Office", true).unwrap()),
            "ic os network wifi connect"
        );
        assert!(not_here(Some(3), false));
        assert!(not_here(Some(4), true));
        assert!(!not_here(Some(4), false));
        assert!(!not_here(Some(0), true));
        assert!(!not_here(None, true));
    }

    fn ran(code: Option<i32>, stderr: &str) -> Captured {
        Captured {
            code,
            timed_out: false,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn joining_says_whether_a_password_is_wanted_or_was_wrong() {
        let joined = |outcome: &'static str, reason: Option<&str>| WifiJoin {
            outcome,
            reason: reason.map(str::to_string),
        };
        assert_eq!(join_from(&ran(Some(0), ""), false), joined("joined", None));
        assert_eq!(join_from(&ran(Some(0), ""), true), joined("joined", None));
        assert_eq!(
            join_from(&ran(Some(5), "error: Office needs a password"), false),
            joined("needsPassword", None)
        );
        assert_eq!(
            join_from(&ran(Some(5), "error: the password was refused"), true),
            joined("wrongPassword", None)
        );
        assert_eq!(join_from(&ran(Some(3), ""), false), joined("notOs", None));
        assert_eq!(
            join_from(
                &ran(Some(1), "error: no network called Office in reach"),
                true
            ),
            joined("failed", Some("no network called Office in reach"))
        );
        assert_eq!(
            serde_json::to_value(joined("needsPassword", None)).unwrap(),
            json!({ "outcome": "needsPassword", "reason": null })
        );
    }

    fn drive(device: &str, label: Option<&str>, model: Option<&str>, kind: DriveKind) -> Drive {
        Drive {
            device: device.into(),
            label: label.map(str::to_string),
            size: 7_743_733_760,
            filesystem: Some("vfat".into()),
            mounted_at: None,
            read_only: false,
            model: model.map(str::to_string),
            kind,
        }
    }

    #[test]
    fn the_drives_in_at_the_first_read_are_nobodys_news_and_each_one_after_is() {
        let stick = drive("/dev/sda1", Some("KINGSTON"), None, DriveKind::Usb);
        let card = drive("/dev/mmcblk0p1", Some("CANON_DC"), None, DriveKind::Card);
        let mut watch = Watch::default();
        assert_eq!(watch.snapshot(), None, "nothing read yet");
        let first = watch.take(vec![stick.clone()]);
        assert_eq!((first.arrived.len(), first.changed), (0, true));
        assert_eq!(
            watch.snapshot(),
            Some(DrivesSeen {
                drives: vec![stick.clone()],
                fresh: vec![],
            })
        );
        // The same again: nothing to tell.
        assert_eq!(watch.take(vec![stick.clone()]), Turn::default());

        let second = watch.take(vec![stick.clone(), card.clone()]);
        assert_eq!(second.arrived, vec![card.clone()]);
        assert!(second.changed);
        assert_eq!(
            watch.snapshot().unwrap().fresh,
            vec!["/dev/mmcblk0p1".to_string()]
        );

        // Opened by the system on the way: the list changed, the card is still news.
        let mounted = Drive {
            mounted_at: Some("/run/media/intentic/CANON_DC".into()),
            ..card.clone()
        };
        let third = watch.take(vec![stick.clone(), mounted.clone()]);
        assert_eq!(
            (third.arrived.len(), third.left.len(), third.changed),
            (0, 0, true)
        );
        assert_eq!(
            watch.snapshot().unwrap().fresh,
            vec!["/dev/mmcblk0p1".to_string()]
        );

        // Pulled out: gone from the list and from what is fresh.
        let fourth = watch.take(vec![stick.clone()]);
        assert_eq!(fourth.left, vec!["/dev/mmcblk0p1".to_string()]);
        assert!(watch.snapshot().unwrap().fresh.is_empty());
    }

    #[test]
    fn another_stick_in_the_same_place_is_news_and_a_seen_one_is_not() {
        let stick = drive(
            "/dev/sda1",
            Some("KINGSTON"),
            Some("DataTraveler 3.0"),
            DriveKind::Usb,
        );
        let other = Drive {
            size: 4_026_531_840,
            model: Some("Flash Disk".into()),
            ..stick.clone()
        };
        let mut watch = Watch::default();
        watch.take(vec![]);
        assert_eq!(watch.take(vec![stick.clone()]).arrived, vec![stick.clone()]);
        let swapped = watch.take(vec![other.clone()]);
        assert_eq!(swapped.arrived, vec![other.clone()]);
        assert_eq!(swapped.left, vec!["/dev/sda1".to_string()]);
        assert_eq!(
            watch.snapshot().unwrap().fresh,
            vec!["/dev/sda1".to_string()]
        );
        assert!(watch.seen(&["/dev/sda1".to_string(), "/dev/sdz".to_string()]));
        assert!(!watch.seen(&["/dev/sda1".to_string()]));
        assert!(watch.snapshot().unwrap().fresh.is_empty());
    }

    #[test]
    fn a_drives_notification_names_it_in_the_readers_words_and_opens_this_device() {
        let words = DriveWords::default();
        assert!(words.valid());
        let named = notice_for(
            &words,
            &drive(
                "/dev/sda1",
                Some("KINGSTON"),
                Some("DataTraveler"),
                DriveKind::Usb,
            ),
        );
        assert_eq!(named.title, "USB drive KINGSTON plugged in");
        assert_eq!(named.body.as_deref(), Some("Choose where it goes"));
        assert_eq!(named.key, "os-drive:/dev/sda1");
        assert_eq!(named.path.as_deref(), Some(crate::notice::THIS_DEVICE));
        assert_eq!(named.kind, NoticeKind::Asks);
        // No label: its model; neither (or only blanks): what it is.
        assert_eq!(
            notice_for(
                &words,
                &drive("/dev/sdc", Some("  "), Some("Flash Disk"), DriveKind::Usb)
            )
            .title,
            "USB drive Flash Disk plugged in"
        );
        assert_eq!(
            notice_for(
                &words,
                &drive("/dev/mmcblk0p1", None, None, DriveKind::Card)
            )
            .title,
            "Memory card put in"
        );
        assert_eq!(
            notice_for(
                &words,
                &drive("/dev/sdd1", Some("Backup"), None, DriveKind::Other)
            )
            .title,
            "Drive Backup plugged in"
        );
        // A label cannot break the line, nor run on.
        let long = notice_for(
            &words,
            &drive(
                "/dev/sda1",
                Some(&format!("A\u{7}B{}", "x".repeat(80))),
                None,
                DriveKind::Usb,
            ),
        );
        assert!(!long.title.chars().any(char::is_control));
        assert_eq!(
            drive_name(&drive(
                "/dev/sda1",
                Some(&"x".repeat(80)),
                None,
                DriveKind::Usb
            ))
            .unwrap()
            .len(),
            NAME_MAX
        );

        let german = DriveWords {
            usb_named: "USB-Stick {name} angeschlossen".into(),
            ..DriveWords::default()
        };
        assert!(german.valid());
        assert_eq!(
            notice_for(
                &german,
                &drive("/dev/sda1", Some("FOTOS"), None, DriveKind::Usb)
            )
            .title,
            "USB-Stick FOTOS angeschlossen"
        );
        for bad in [
            DriveWords {
                usb_named: "USB drive plugged in".into(),
                ..DriveWords::default()
            },
            DriveWords {
                body: String::new(),
                ..DriveWords::default()
            },
            DriveWords {
                card: "two\nlines".into(),
                ..DriveWords::default()
            },
            DriveWords {
                other: "x".repeat(WORDS_MAX + 1),
                ..DriveWords::default()
            },
        ] {
            assert!(!bad.valid(), "{bad:?}");
        }
    }

    #[test]
    fn a_copy_is_read_line_by_line_to_its_end() {
        let mut reading = ImportReading::default();
        assert_eq!(
            reading.hear(
                Stream::Stdout,
                r#"{"progress":{"bytes":61728394,"total":123456789}}"#
            ),
            Some(Progress {
                bytes: 61_728_394,
                total: 123_456_789,
            })
        );
        assert_eq!(reading.hear(Stream::Stderr, "copying 42 files"), None);
        assert_eq!(reading.hear(Stream::Stdout, "not json"), None);
        assert_eq!(
            reading.hear(
                Stream::Stdout,
                r#"{"device":"/dev/sda1","sandbox":"work","path":"/work/Imports/KINGSTON-2026-10-16","bytes":123456789,"files":42}"#
            ),
            None
        );
        let end = reading.end(
            "/dev/sda1".into(),
            "work".into(),
            Some(0),
            false,
            Some("/l".into()),
        );
        assert_eq!(end.outcome, "done");
        assert_eq!(end.reason, None);
        assert_eq!(
            end.copied,
            Some(Imported {
                device: "/dev/sda1".into(),
                sandbox: "work".into(),
                path: "/work/Imports/KINGSTON-2026-10-16".into(),
                bytes: 123_456_789,
                files: 42,
            })
        );
    }

    #[test]
    fn a_copy_that_would_not_fit_says_how_much_it_needs_and_copies_nothing() {
        let mut reading = ImportReading::default();
        reading.hear(
            Stream::Stderr,
            "error: it needs 12.4 GB and the sandbox has 3.1 GB free",
        );
        let end = reading.end("/dev/sdb1".into(), "work".into(), Some(6), false, None);
        assert_eq!(end.outcome, "noRoom");
        assert_eq!(end.copied, None);
        assert_eq!(
            end.reason.as_deref(),
            Some("it needs 12.4 GB and the sandbox has 3.1 GB free")
        );
        let ended = |code: Option<i32>, timed_out: bool| {
            ImportReading::default()
                .end("/dev/sdb1".into(), "work".into(), code, timed_out, None)
                .outcome
        };
        assert_eq!(ended(None, false), "stopped");
        assert_eq!(ended(None, true), "failed");
        assert_eq!(ended(Some(0), true), "failed");
        assert_eq!(ended(Some(1), false), "failed");
        assert_eq!(ended(Some(3), false), "notOs");
    }

    #[test]
    fn the_windows_hear_a_copy_in_their_spelling() {
        assert_eq!(
            serde_json::to_value(Copying::Started {
                device: "/dev/sda1".into(),
                sandbox: "work".into(),
            })
            .unwrap(),
            json!({ "kind": "started", "device": "/dev/sda1", "sandbox": "work" })
        );
        assert_eq!(
            serde_json::to_value(Copying::Progress {
                device: "/dev/sda1".into(),
                sandbox: "work".into(),
                bytes: 1,
                total: 2,
            })
            .unwrap(),
            json!({ "kind": "progress", "device": "/dev/sda1", "sandbox": "work", "bytes": 1, "total": 2 })
        );
        let busy = import_refused("/dev/sda1".into(), "work".into());
        assert_eq!(
            serde_json::to_value(Copying::Exit(busy)).unwrap(),
            json!({
                "kind": "exit",
                "device": "/dev/sda1",
                "sandbox": "work",
                "outcome": "busy",
                "copied": null,
                "code": null,
                "timedOut": false,
                "reason": null,
                "log": null,
                "ran": false,
            })
        );
        assert_eq!(
            serde_json::to_value(DrivesSeen {
                drives: vec![drive("/dev/sda1", None, None, DriveKind::Card)],
                fresh: vec!["/dev/sda1".into()],
            })
            .unwrap()["drives"][0]["mountedAt"],
            Value::Null
        );
    }

    #[test]
    fn one_copy_at_a_time() {
        let first = claim_import().expect("nothing is copying yet");
        assert!(claim_import().is_none());
        drop(first);
        let second = claim_import().expect("the first gave its turn back");
        drop(second);
    }
}
