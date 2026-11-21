//! Linux's screens, whichever of three cases this computer is (looked at again every few seconds, and said in `/info`
//! as `screen.mode`):
//!
//! - **`x11`**: a person's X11 session (Xorg on a seat). Its display and cookie file are found from the session's own
//!   processes ([`session`]) when remoted's environment does not name them, and every monitor RandR lists is a screen
//!   of its own (`screen-<output name>`), a crop of the X screen captured with MIT-SHM GetImage and XDamage. The
//!   person's pointer stays on their display; viewers draw it from its shape.
//! - **`wayland`**: a Wayland session (GNOME, KDE, wlroots). Xwayland's root shows X clients only, so it is not
//!   captured; the desktop portal is the way in ([`wayland`]): its screen cast over PipeWire, its RemoteDesktop for
//!   input, the person at the computer asked once.
//! - **`virtual`**: no display at all. A virtual desktop ([`desktop`]) is started on the first viewer and served like
//!   the sandbox's own; `/info` names the packages it needs when they are missing.
//!
//! `INTENTIC_REMOTED_SCREEN` decides instead of looking: `virtual`, `x11:<display>` (with `XAUTHORITY`), or `wayland`
//! (the session bus in `DBUS_SESSION_BUS_ADDRESS`).

pub mod desktop;
pub mod encoders;
pub mod session;
pub mod wayland;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cast_core::capture::{Capture, ScreenSource};
use cast_core::geometry::Rect;
use cast_core::hub::Hub;
use cast_core::video::VideoConfig;
use serde_json::json;
use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::xproto::ConnectionExt as _;

use super::Monitor;
use super::platform::{Opened, Platform};

/// How long what was found about the session is trusted before it is looked at again.
const LOOK_EVERY: Duration = Duration::from_secs(3);

/// The virtual desktop's one screen.
pub const VIRTUAL_ID: &str = "virtual";

/// A wheel notch on X, in CSS pixels: what a scroll of that many picture pixels turns into one click of.
const SCROLL_PX_PER_NOTCH: f64 = 120.0;

/// Which case this computer is now.
#[derive(Debug, Clone)]
enum Mode {
    X11 {
        display: String,
        authority: Option<PathBuf>,
        desktop: Option<String>,
    },
    Wayland {
        desktop: Option<String>,
        /// The session bus the portal is on.
        bus: String,
    },
    Virtual(Result<desktop::Plan, desktop::Missing>),
}

struct State {
    looked: Option<Instant>,
    mode: Mode,
    monitors: Vec<Monitor>,
    /// The virtual desktop remoted started, while it runs.
    desktop: Option<desktop::Desktop>,
}

pub struct Linux {
    state: Mutex<State>,
    probe: Arc<encoders::Probe>,
    /// A Wayland session's portal session, kept across looks.
    wayland: wayland::Wayland,
}

impl Default for Linux {
    fn default() -> Self {
        Self::new()
    }
}

impl Linux {
    pub fn new() -> Linux {
        Linux {
            state: Mutex::new(State {
                looked: None,
                mode: Mode::Virtual(desktop::plan()),
                monitors: Vec::new(),
                desktop: None,
            }),
            probe: encoders::Probe::start(),
            wayland: wayland::Wayland::default(),
        }
    }

    /// The state, looked at again when it is older than [`LOOK_EVERY`].
    fn fresh(&self) -> std::sync::MutexGuard<'_, State> {
        let mut state = self.state.lock().expect("linux screens poisoned");
        if state.looked.is_none_or(|at| at.elapsed() >= LOOK_EVERY) {
            look(&mut state, &self.wayland);
            state.looked = Some(Instant::now());
        }
        state
    }
}

/// Finds which case this computer is, and its monitors.
fn look(state: &mut State, wayland: &wayland::Wayland) {
    let running = state.desktop.as_mut().is_some_and(|d| d.alive());
    if !running && state.desktop.take().is_some() {
        log::info!("the virtual desktop ended (its session exited)");
    }
    let skip: Vec<String> = state.desktop.iter().map(|d| d.display.clone()).collect();
    state.mode = if running {
        // A virtual desktop stays the screen while it runs, even if someone logs in at the computer meanwhile.
        Mode::Virtual(desktop::plan())
    } else {
        find_mode(&skip)
    };
    state.monitors = match &state.mode {
        Mode::X11 {
            display, authority, ..
        } => {
            cast_x11::connect::set_authority(authority.clone());
            match x11_monitors(display) {
                Ok((monitors, _)) => monitors,
                Err(e) => {
                    log::warn!("the monitors of {display} cannot be read: {e}");
                    Vec::new()
                }
            }
        }
        Mode::Wayland { .. } => match wayland::pipewire::available() {
            Ok(_) => {
                let (width, height) = wayland.size();
                vec![Monitor {
                    id: wayland::SCREEN_ID.into(),
                    name: "Screen".into(),
                    x: 0,
                    y: 0,
                    width,
                    height,
                    scale: 1.0,
                    primary: true,
                }]
            }
            Err(_) => Vec::new(),
        },
        Mode::Virtual(Ok(plan)) => {
            let size = state
                .desktop
                .as_ref()
                .and_then(|d| d.size())
                .unwrap_or(desktop::INITIAL_SIZE);
            vec![Monitor {
                id: VIRTUAL_ID.into(),
                name: format!("Virtual desktop ({})", plan.session.0),
                x: 0,
                y: 0,
                width: size.0,
                height: size.1,
                scale: 1.0,
                primary: true,
            }]
        }
        Mode::Virtual(Err(_)) => Vec::new(),
    };
}

fn find_mode(skip: &[String]) -> Mode {
    if let Ok(forced) = std::env::var("INTENTIC_REMOTED_SCREEN") {
        if forced == "virtual" {
            return Mode::Virtual(desktop::plan());
        }
        if forced == "wayland" {
            return Mode::Wayland {
                desktop: std::env::var("XDG_CURRENT_DESKTOP").ok(),
                bus: own_bus(),
            };
        }
        if let Some(display) = forced.strip_prefix("x11:") {
            return Mode::X11 {
                display: display.to_owned(),
                authority: std::env::var_os("XAUTHORITY").map(PathBuf::from),
                desktop: None,
            };
        }
        log::warn!(
            "INTENTIC_REMOTED_SCREEN={forced}: expected `virtual`, `x11:<display>` or `wayland`; looking instead"
        );
    }
    // remoted's own environment first: started from inside a session, it is that session's.
    let own_desktop = std::env::var("XDG_CURRENT_DESKTOP").ok();
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Mode::Wayland {
            desktop: own_desktop,
            bus: own_bus(),
        };
    }
    if let Ok(display) = std::env::var("DISPLAY")
        && !skip.contains(&display)
    {
        let authority = std::env::var_os("XAUTHORITY").map(PathBuf::from);
        if connects(&display, authority.clone()) {
            return Mode::X11 {
                display,
                authority,
                desktop: own_desktop,
            };
        }
    }
    if let Some(found) = session::find(skip) {
        if found.is_wayland() {
            return Mode::Wayland {
                bus: wayland::portal::bus_address(
                    found.bus.as_deref(),
                    found.runtime_dir.as_deref(),
                    found.uid,
                ),
                desktop: found.desktop,
            };
        }
        if let Some(display) = found.display.clone()
            && connects(&display, found.authority.clone())
        {
            return Mode::X11 {
                display,
                authority: found.authority,
                desktop: found.desktop,
            };
        }
    }
    Mode::Virtual(desktop::plan())
}

/// remoted's own session bus, started from inside a session.
fn own_bus() -> String {
    wayland::portal::bus_address(
        std::env::var("DBUS_SESSION_BUS_ADDRESS").ok().as_deref(),
        std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
        unsafe { libc::geteuid() },
    )
}

/// Whether `display` takes a connection with `authority`'s cookie.
fn connects(display: &str, authority: Option<PathBuf>) -> bool {
    let before = cast_x11::connect::authority();
    cast_x11::connect::set_authority(authority);
    let ok = cast_x11::connect::connect(Some(display)).is_ok();
    if !ok {
        cast_x11::connect::set_authority(before);
    }
    ok
}

/// The monitors RandR lists on `display` (one for the whole screen where it lists none), and the screen's size.
pub fn x11_monitors(display: &str) -> Result<(Vec<Monitor>, (u32, u32)), String> {
    let (conn, n) = cast_x11::connect::connect(Some(display))?;
    let screen = &conn.setup().roots[n];
    let root = screen.root;
    let size = (
        u32::from(screen.width_in_pixels),
        u32::from(screen.height_in_pixels),
    );
    let whole = || Monitor {
        id: "0".into(),
        name: "Screen".into(),
        x: 0,
        y: 0,
        width: size.0,
        height: size.1,
        scale: 1.0,
        primary: true,
    };
    let listed = conn
        .randr_query_version(1, 5)
        .ok()
        .and_then(|c| c.reply().ok())
        .filter(|v| (v.major_version, v.minor_version) >= (1, 5))
        .and_then(|_| conn.randr_get_monitors(root, true).ok()?.reply().ok());
    let Some(listed) = listed else {
        return Ok((vec![whole()], size));
    };
    let mut monitors = Vec::new();
    for (i, info) in listed.monitors.iter().enumerate() {
        let name = conn
            .get_atom_name(info.name)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.name).into_owned())
            .unwrap_or_else(|| format!("monitor-{i}"));
        let id = monitor_id(&name, i);
        if info.width < 16 || info.height < 16 || monitors.iter().any(|m: &Monitor| m.id == id) {
            continue;
        }
        monitors.push(Monitor {
            id,
            name,
            x: i32::from(info.x),
            y: i32::from(info.y),
            width: u32::from(info.width),
            height: u32::from(info.height),
            scale: 1.0,
            primary: info.primary,
        });
    }
    if monitors.is_empty() {
        monitors.push(whole());
    }
    if !monitors.iter().any(|m| m.primary) {
        monitors[0].primary = true;
    }
    Ok((monitors, size))
}

/// A monitor's id from RandR's name for it (`DP-1`, `HDMI-A-0`): stable while it is plugged in the same port, and a
/// session name's characters.
pub fn monitor_id(name: &str, index: usize) -> String {
    let id: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(57)
        .collect();
    if id.trim_matches('_').is_empty() {
        format!("monitor-{index}")
    } else {
        id
    }
}

/// One monitor of a person's X screen: the whole screen when it is the only one, else a crop of it, looked up again
/// on every reopen so a monitor the person moved or resized is followed (and one unplugged ends the screen).
struct MonitorScreen {
    display: String,
    id: String,
}

impl ScreenSource for MonitorScreen {
    fn open(&mut self, _crop: Option<Rect>) -> Result<Box<dyn Capture>, String> {
        let (monitors, size) = x11_monitors(&self.display)?;
        let monitor = monitors
            .iter()
            .find(|m| m.id == self.id)
            .ok_or_else(|| format!("monitor {} is no longer connected", self.id))?;
        let whole = monitor.x == 0 && monitor.y == 0 && (monitor.width, monitor.height) == size;
        let crop = (!whole).then(|| Rect {
            x: monitor.x.max(0) as u32,
            y: monitor.y.max(0) as u32,
            w: monitor.width,
            h: monitor.height,
        });
        Ok(Box::new(cast_x11::capture::Capturer::new(
            Some(&self.display),
            crop,
        )?))
    }
}

impl Platform for Linux {
    fn monitors(&self) -> Vec<Monitor> {
        self.fresh().monitors.clone()
    }

    fn encoders(&self) -> Vec<String> {
        match self.probe.peek() {
            Some(picked) => picked
                .notes
                .iter()
                .filter(|(_, note)| note == "ok")
                .map(|(name, _)| name.clone())
                .collect(),
            None => vec![super::software().name().to_owned()],
        }
    }

    fn describe(&self) -> serde_json::Value {
        let state = self.fresh();
        let encoders: serde_json::Map<String, serde_json::Value> = self
            .probe
            .peek()
            .map(|p| p.notes.into_iter().map(|(n, w)| (n, json!(w))).collect())
            .unwrap_or_default();
        let mut out = match &state.mode {
            Mode::X11 {
                display, desktop, ..
            } => json!({ "mode": "x11", "display": display, "desktop": desktop }),
            Mode::Wayland { desktop, .. } => {
                let (consent, words) = self.wayland.consent();
                match wayland::pipewire::available() {
                    Ok(version) => json!({
                        "mode": "wayland",
                        "desktop": desktop,
                        "pipewire": version,
                        "consent": consent,
                        "reason": words,
                    }),
                    Err(why) => json!({
                        "mode": "wayland",
                        "desktop": desktop,
                        "missing": ["pipewire"],
                        "reason": format!("this computer's session is Wayland, whose screen comes through PipeWire: {why}"),
                    }),
                }
            }
            Mode::Virtual(Ok(plan)) => json!({
                "mode": "virtual",
                "session": plan.session.0,
                "server": match plan.server { desktop::Server::Xvfb(_) => "Xvfb", desktop::Server::XorgDummy(_) => "Xorg (dummy)" },
                "running": state.desktop.as_ref().map(|d| d.display.clone()),
            }),
            Mode::Virtual(Err(missing)) => json!({
                "mode": "virtual",
                "missing": missing.packages,
                "reason": missing.words,
            }),
        };
        out["encoders"] = json!(encoders);
        out
    }

    fn shutdown(&self) {
        let desktop = self
            .state
            .lock()
            .expect("linux screens poisoned")
            .desktop
            .take();
        drop(desktop);
    }

    fn open(&self, monitor: &str, hub: &Arc<Hub>, base: VideoConfig) -> Result<Opened, String> {
        let video = VideoConfig {
            encoder: self.probe.encoders(),
            ..base
        };
        let mut state = self.fresh();
        match state.mode.clone() {
            Mode::X11 {
                display, authority, ..
            } => {
                cast_x11::connect::set_authority(authority);
                drop(state);
                let source = MonitorScreen {
                    display: display.clone(),
                    id: monitor.to_owned(),
                };
                // The person's pointer stays drawn on their display; GetImage leaves it out of the picture.
                let (input, stops) = x11_extras(&display, monitor, hub, false);
                Ok(Opened {
                    source: Box::new(source),
                    video,
                    input,
                    audio: None,
                    stops,
                })
            }
            Mode::Wayland { bus, .. } => {
                drop(state);
                if monitor != wayland::SCREEN_ID {
                    return Err(format!(
                        "no screen {monitor} on this computer's Wayland session"
                    ));
                }
                let opened = self.wayland.open(&bus, hub)?;
                let input = match opened.input.map(cast_core::input::spawn).transpose() {
                    Ok(input) => input,
                    Err(e) => {
                        log::warn!("wayland: no input: {e}");
                        None
                    }
                };
                Ok(Opened {
                    source: opened.source,
                    video,
                    input,
                    audio: None,
                    stops: vec![opened.stop],
                })
            }
            Mode::Virtual(Err(missing)) => Err(missing.words),
            Mode::Virtual(Ok(plan)) => {
                if monitor != VIRTUAL_ID {
                    return Err(format!(
                        "no screen {monitor} on this computer's virtual desktop"
                    ));
                }
                if !state.desktop.as_mut().is_some_and(|d| d.alive()) {
                    state.desktop = None;
                    state.desktop = Some(desktop::Desktop::start(&plan)?);
                }
                let running = state.desktop.as_ref().expect("a desktop");
                let display = running.display.clone();
                let source = running.source();
                cast_x11::connect::set_authority(Some(running.authority.clone()));
                state.looked = None;
                drop(state);
                // Xvfb draws its pointer into the framebuffer read in place: hidden there, drawn by the viewers.
                let (input, stops) = x11_extras(&display, monitor, hub, true);
                Ok(Opened {
                    source: Box::new(source),
                    video,
                    input,
                    audio: None,
                    stops,
                })
            }
        }
    }
}

/// The cursor and clipboard thread and the input thread on an X display. Either failing leaves the screen watchable.
fn x11_extras(
    display: &str,
    monitor: &str,
    hub: &Arc<Hub>,
    hide_cursor: bool,
) -> (Option<cast_core::input::Input>, Vec<super::Stop>) {
    let clipboard =
        match cast_x11::desktop::spawn_with(Some(display.to_owned()), hub.clone(), hide_cursor) {
            Ok(clipboard) => Some(clipboard),
            Err(e) => {
                log::warn!("{display}: no cursor or clipboard: {e}");
                None
            }
        };
    let input = match cast_x11::input::spawn(
        Some(display.to_owned()),
        &format!("remoted-{monitor}"),
        clipboard,
        SCROLL_PX_PER_NOTCH,
        hub.clone(),
    ) {
        Ok(input) => Some(input),
        Err(e) => {
            log::warn!("{display}: no input: {e}");
            None
        }
    };
    // The cursor and clipboard thread ends by itself once the hub is stopped.
    (input, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_monitor_id_is_its_output_name_made_a_session_name() {
        assert_eq!(monitor_id("DP-1", 0), "DP-1");
        assert_eq!(monitor_id("HDMI-A-0", 1), "HDMI-A-0");
        assert_eq!(monitor_id("eDP 1/2", 2), "eDP_1_2");
        assert_eq!(monitor_id("", 3), "monitor-3");
        assert_eq!(monitor_id("::", 4), "monitor-4");
        assert_eq!(monitor_id(&"x".repeat(80), 0).len(), 57);
    }
}
