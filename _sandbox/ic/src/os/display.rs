use serde_json::{json, Value};

use super::sway::{self, number};
use super::Paths;
use crate::util::{bail, Result};

/* `ic os display`: THE SCREENS, THEIR RESOLUTION AND HOW BIG EVERYTHING IS DRAWN. Read from sway's `get_outputs` (the
shape sway 1.10 answers), changed with sway's `output` command, and kept in /etc/intentic/sway.d/50-display.conf so
the next session starts the same way: one `output <name> mode … scale …` line per screen this has set, which this
verb rewrites and nothing else does. A screen is named by its connector (`HDMI-A-1`): the one plugged into the same
socket keeps what was set for it. Desktop edition only (sway.rs). */

/// The file the settings are kept in, under the session's settings folder.
pub fn config_path(paths: &Paths) -> std::path::PathBuf {
    sway::settings_dir(paths).join("50-display.conf")
}

/// What heads the file: who writes it, so a person reading it knows not to.
const CONFIG_HEAD: &str = "# Written by `ic os display set` (This computer, Screens): each screen's resolution and size.\n# Changed from there; a line edited by hand is replaced the next time its screen is set.\n";

/// A mode: pixels across and down, and the refresh rate in millihertz, as sway counts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub millihertz: u32,
}

impl Mode {
    fn of(value: &Value) -> Option<Mode> {
        Some(Mode {
            width: u32::try_from(value["width"].as_u64()?).ok()?,
            height: u32::try_from(value["height"].as_u64()?).ok()?,
            millihertz: u32::try_from(value["refresh"].as_u64().unwrap_or(0)).ok()?,
        })
    }

    fn value(self) -> Value {
        json!({
            "width": self.width,
            "height": self.height,
            "refresh": number(f64::from(self.millihertz) / 1000.0),
        })
    }

    /// As sway's `output … mode` takes it: `1920x1080@59.940Hz`.
    pub fn sway(self) -> String {
        format!(
            "{}x{}@{}.{:03}Hz",
            self.width,
            self.height,
            self.millihertz / 1000,
            self.millihertz % 1000
        )
    }
}

/// A mode as a person types it (`1920x1080@60`, `1920x1080@59.94`, `1920x1080`): the size, and the rate in mHz when
/// given. Pure.
pub fn parse_mode(text: &str) -> Option<(u32, u32, Option<u32>)> {
    let text = text.trim().trim_end_matches("Hz");
    let (size, rate) = match text.split_once('@') {
        Some((size, rate)) => (size, Some(rate)),
        None => (text, None),
    };
    let (width, height) = size.split_once('x')?;
    let millihertz = match rate {
        Some(rate) => {
            let hz: f64 = rate.parse().ok()?;
            if !(1.0..=1000.0).contains(&hz) {
                return None;
            }
            Some((hz * 1000.0).round() as u32)
        }
        None => None,
    };
    Some((width.parse().ok()?, height.parse().ok()?, millihertz))
}

/// The screen's own mode closest to what was asked: the same size, and the rate within half a hertz (60 is 59.94 on
/// many screens), or the fastest rate of that size when none was given. Pure.
pub fn pick_mode(modes: &[Mode], width: u32, height: u32, millihertz: Option<u32>) -> Option<Mode> {
    let sized = modes
        .iter()
        .copied()
        .filter(|mode| mode.width == width && mode.height == height);
    match millihertz {
        None => sized.max_by_key(|mode| mode.millihertz),
        Some(asked) => sized
            .filter(|mode| mode.millihertz.abs_diff(asked) <= 500)
            .min_by_key(|mode| mode.millihertz.abs_diff(asked)),
    }
}

/// A screen's modes, each once (sway lists one per picture aspect ratio). Pure.
pub fn modes_of(output: &Value) -> Vec<Mode> {
    let mut modes: Vec<Mode> = Vec::new();
    for mode in output["modes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Mode::of)
    {
        if !modes.contains(&mode) {
            modes.push(mode);
        }
    }
    modes
}

/// What a screen says it is, or null where sway has nothing better than `Unknown`. Pure.
fn named(value: &Value) -> Value {
    match value.as_str().map(str::trim) {
        Some(text) if !text.is_empty() && text != "Unknown" => json!(text),
        _ => Value::Null,
    }
}

/// `ic os display list --json` from sway's `get_outputs`. Pure.
pub fn list_value(outputs: &Value) -> Value {
    let screens: Vec<Value> = outputs
        .as_array()
        .into_iter()
        .flatten()
        .filter(|output| output["non_desktop"] != true)
        .map(|output| {
            let enabled = output["active"] == true;
            let current = if enabled {
                Mode::of(&output["current_mode"])
                    .filter(|mode| mode.width > 0)
                    .map(Mode::value)
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            json!({
                "name": output["name"].as_str().unwrap_or_default(),
                "make": named(&output["make"]),
                "model": named(&output["model"]),
                "enabled": enabled,
                "current": current,
                "modes": modes_of(output).into_iter().map(Mode::value).collect::<Vec<_>>(),
                "scale": if enabled { output["scale"].as_f64().map(number).unwrap_or(Value::Null) } else { Value::Null },
            })
        })
        .collect();
    json!({ "outputs": screens })
}

/// A scale ic sets: between half and four times. Pure.
pub fn valid_scale(scale: f64) -> bool {
    (0.5..=4.0).contains(&scale)
}

/// The scale as sway and the file spell it: `1.5`, `2`. Pure.
fn scale_word(scale: f64) -> String {
    number(scale).to_string()
}

/// The settings file with this screen's line made to say `mode` and `scale` (each kept from the line it had when not
/// given), every other screen's line as it was. Pure.
pub fn config_with(existing: &str, name: &str, mode: Option<Mode>, scale: Option<f64>) -> String {
    let mut kept_mode: Option<String> = None;
    let mut kept_scale: Option<String> = None;
    let mut others: Vec<String> = Vec::new();
    for line in existing.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.first() == Some(&"#") || line.trim_start().starts_with('#') || words.is_empty() {
            continue;
        }
        if words.first() == Some(&"output") && words.get(1) == Some(&name) {
            for pair in words[2..].windows(2) {
                match pair[0] {
                    "mode" => kept_mode = Some(pair[1].to_string()),
                    "scale" => kept_scale = Some(pair[1].to_string()),
                    _ => {}
                }
            }
            continue;
        }
        others.push(line.trim_end().to_string());
    }
    let mode = mode.map(Mode::sway).or(kept_mode);
    let scale = scale.map(scale_word).or(kept_scale);
    let mut line = format!("output {name}");
    if let Some(mode) = mode {
        line.push_str(&format!(" mode {mode}"));
    }
    if let Some(scale) = scale {
        line.push_str(&format!(" scale {scale}"));
    }
    others.push(line);
    others.sort();
    format!("{CONFIG_HEAD}{}\n", others.join("\n"))
}

/// A screen's connector name as ic takes it. Pure.
pub fn valid_output_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `ic os display list [--json]`.
pub fn list(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    sway::require_screen()?;
    let socket = sway::require_socket()?;
    let screens = list_value(&sway::get(&socket, "get_outputs")?);
    if json {
        super::emit_json(&screens);
        return Ok(());
    }
    crate::ui::report("Screens", None);
    let fields: Vec<(String, String)> = screens["outputs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|screen| {
            let what = [&screen["make"], &screen["model"]]
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let shows = match (&screen["current"], screen["scale"].as_f64()) {
                (Value::Null, _) => "off".to_string(),
                (current, scale) => format!(
                    "{}x{} at {} Hz, scale {}",
                    current["width"],
                    current["height"],
                    current["refresh"],
                    scale.map(scale_word).unwrap_or_else(|| "1".to_string())
                ),
            };
            (
                screen["name"].as_str().unwrap_or_default().to_string(),
                if what.is_empty() {
                    shows
                } else {
                    format!("{what}: {shows}")
                },
            )
        })
        .collect();
    crate::ui::fields(&fields);
    Ok(())
}

/// `ic os display set <output> [--mode WxH@Hz] [--scale N]`: checked against what the screen offers, kept in the
/// settings file, then shown at once.
pub fn set(name: &str, mode: Option<&str>, scale: Option<f64>) -> Result<()> {
    sway::require_screen()?;
    if !valid_output_name(name) {
        bail!("{name:?} is not a screen's name (ic os display list).");
    }
    if mode.is_none() && scale.is_none() {
        bail!("Say what to change: --mode WxH@Hz, --scale, or both.");
    }
    if let Some(scale) = scale.filter(|scale| !valid_scale(*scale)) {
        bail!("A scale is between 0.5 and 4 (1 is actual size, 2 twice as big), not {scale}.");
    }
    let socket = sway::require_socket()?;
    let outputs = sway::get(&socket, "get_outputs")?;
    let Some(output) = outputs
        .as_array()
        .into_iter()
        .flatten()
        .find(|output| output["name"] == name)
    else {
        bail!(
            "{}",
            crate::ui::explain(
                &format!("There is no screen called {name} on this machine."),
                None,
                Some("ic os display list"),
            )
        );
    };
    let mode = match mode {
        None => None,
        Some(asked) => {
            let Some((width, height, millihertz)) = parse_mode(asked) else {
                bail!("{asked:?} is not a mode: write it like 1920x1080@60.");
            };
            let Some(picked) = pick_mode(&modes_of(output), width, height, millihertz) else {
                bail!(
                    "{}",
                    crate::ui::explain(
                        &format!("{name} does not offer {asked}."),
                        None,
                        Some("ic os display list (each screen's modes are under `modes`)"),
                    )
                );
            };
            Some(picked)
        }
    };
    let paths = Paths::here();
    let path = config_path(&paths);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    super::write_atomic(&path, config_with(&existing, name, mode, scale).as_bytes())?;
    let mut change = format!("output {name}");
    if let Some(mode) = mode {
        change.push_str(&format!(" mode {}", mode.sway()));
    }
    if let Some(scale) = scale {
        change.push_str(&format!(" scale {}", scale_word(scale)));
    }
    sway::command(&socket, &[change])?;
    crate::ui::done(&format!("{name} is set, now and at every start."));
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixture {
    use serde_json::{json, Value};

    /// `swaymsg -r -t get_outputs` as sway 1.10 answers it (the fields this reads, in sway's own spelling; the tree and
    /// rect fields recorded from a headless sway 1.10.1 are left out): a laptop's panel at 150%, a 4K screen at 200%
    /// that lists 1080p60 twice (one per picture aspect ratio), and a TV switched off.
    pub fn outputs() -> Value {
        json!([
            {
                "id": 3, "type": "output", "name": "eDP-1", "active": true, "dpms": true, "power": true,
                "primary": false, "make": "BOE", "model": "0x095F", "serial": "Unknown", "non_desktop": false,
                "modes": [
                    { "width": 2256, "height": 1504, "refresh": 59999, "picture_aspect_ratio": "none" },
                    { "width": 2256, "height": 1504, "refresh": 48000, "picture_aspect_ratio": "none" }
                ],
                "current_mode": { "width": 2256, "height": 1504, "refresh": 59999, "picture_aspect_ratio": "none" },
                "scale": 1.5, "scale_filter": "smart", "transform": "normal", "adaptive_sync_status": "disabled",
                "current_workspace": "1", "focused": true
            },
            {
                "id": 4, "type": "output", "name": "DP-2", "active": true, "dpms": true, "power": true,
                "primary": false, "make": "Dell Inc.", "model": "DELL U2720Q", "serial": "8XKQ123", "non_desktop": false,
                "modes": [
                    { "width": 3840, "height": 2160, "refresh": 60000, "picture_aspect_ratio": "none" },
                    { "width": 3840, "height": 2160, "refresh": 29981, "picture_aspect_ratio": "none" },
                    { "width": 2560, "height": 1440, "refresh": 59951, "picture_aspect_ratio": "none" },
                    { "width": 1920, "height": 1080, "refresh": 60000, "picture_aspect_ratio": "16:9" },
                    { "width": 1920, "height": 1080, "refresh": 60000, "picture_aspect_ratio": "none" },
                    { "width": 1920, "height": 1080, "refresh": 59940, "picture_aspect_ratio": "none" }
                ],
                "current_mode": { "width": 3840, "height": 2160, "refresh": 60000, "picture_aspect_ratio": "none" },
                "scale": 2.0, "scale_filter": "smart", "transform": "normal", "adaptive_sync_status": "disabled",
                "current_workspace": "2", "focused": false
            },
            {
                "type": "output", "name": "HDMI-A-1", "active": false, "dpms": false, "power": false,
                "primary": false, "make": "Unknown", "model": "Unknown", "serial": "Unknown", "non_desktop": false,
                "modes": [ { "width": 1920, "height": 1080, "refresh": 60000, "picture_aspect_ratio": "none" } ],
                "current_workspace": null
            }
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_screen_list_the_contract_shows_is_what_the_mapping_makes() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/golden/intentic-os.json"
        ))
        .expect("the golden file is JSON");
        assert_eq!(list_value(&fixture::outputs()), golden["displayList"][0]);
        assert_eq!(list_value(&json!([])), json!({ "outputs": [] }));
    }

    #[test]
    fn a_mode_is_typed_as_people_say_it_and_matched_to_what_the_screen_offers() {
        assert_eq!(parse_mode("1920x1080@60"), Some((1920, 1080, Some(60_000))));
        assert_eq!(
            parse_mode("1920x1080@59.94Hz"),
            Some((1920, 1080, Some(59_940)))
        );
        assert_eq!(parse_mode("1920x1080"), Some((1920, 1080, None)));
        for bad in ["1920", "x1080@60", "1920x1080@", "1920x1080@0", "axb"] {
            assert_eq!(parse_mode(bad), None, "{bad}");
        }
        let modes = modes_of(&fixture::outputs()[1]);
        // The duplicate 1080p60 is listed once.
        assert_eq!(modes.len(), 5);
        let at = |w, h, mhz| Mode {
            width: w,
            height: h,
            millihertz: mhz,
        };
        // 60 picks 60.000 over 59.940, and 59.94 the other way round.
        assert_eq!(
            pick_mode(&modes, 1920, 1080, Some(60_000)),
            Some(at(1920, 1080, 60_000))
        );
        assert_eq!(
            pick_mode(&modes, 1920, 1080, Some(59_940)),
            Some(at(1920, 1080, 59_940))
        );
        // 30 is 29.981 (within half a hertz); no size given a rate is the fastest.
        assert_eq!(
            pick_mode(&modes, 3840, 2160, Some(30_000)),
            Some(at(3840, 2160, 29_981))
        );
        assert_eq!(
            pick_mode(&modes, 3840, 2160, None),
            Some(at(3840, 2160, 60_000))
        );
        assert_eq!(pick_mode(&modes, 1280, 720, None), None);
        assert_eq!(pick_mode(&modes, 2560, 1440, Some(144_000)), None);
        assert_eq!(at(1920, 1080, 59_940).sway(), "1920x1080@59.940Hz");
        assert_eq!(at(2256, 1504, 48_000).sway(), "2256x1504@48.000Hz");
    }

    #[test]
    fn the_settings_file_keeps_one_line_per_screen_and_what_was_not_changed() {
        let first = config_with(
            "",
            "DP-2",
            Some(Mode {
                width: 3840,
                height: 2160,
                millihertz: 60_000,
            }),
            None,
        );
        assert!(first.starts_with("# Written by `ic os display set`"));
        assert!(first.ends_with("output DP-2 mode 3840x2160@60.000Hz\n"));
        // The scale alone: the mode it had stays.
        let scaled = config_with(&first, "DP-2", None, Some(1.5));
        assert!(
            scaled.ends_with("output DP-2 mode 3840x2160@60.000Hz scale 1.5\n"),
            "{scaled}"
        );
        assert_eq!(scaled.matches("output DP-2").count(), 1);
        // Another screen gets its own line; the first is untouched.
        let both = config_with(&scaled, "eDP-1", None, Some(2.0));
        assert!(both.contains("output DP-2 mode 3840x2160@60.000Hz scale 1.5\n"));
        assert!(both.contains("output eDP-1 scale 2\n"));
        assert_eq!(both.matches("# Written by").count(), 1);
        // Setting again is the same file: nothing accumulates.
        assert_eq!(config_with(&both, "eDP-1", None, Some(2.0)), both);
    }

    #[test]
    fn a_scale_and_a_screen_name_are_what_sway_would_take() {
        assert!(valid_scale(1.0) && valid_scale(0.5) && valid_scale(4.0) && valid_scale(1.25));
        assert!(!valid_scale(0.25) && !valid_scale(5.0) && !valid_scale(f64::NAN));
        for good in ["HDMI-A-1", "eDP-1", "DP-2", "Virtual-1"] {
            assert!(valid_output_name(good), "{good}");
        }
        for bad in ["", "-x", "*", "DP 2", "a;b", "DP-2,", "\"DP-2\""] {
            assert!(!valid_output_name(bad), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_kept_under_the_sessions_settings_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = config_path(&Paths::under(dir.path()));
        assert_eq!(path, dir.path().join("etc/intentic/sway.d/50-display.conf"));
        super::super::write_atomic(&path, config_with("", "eDP-1", None, Some(1.25)).as_bytes())
            .expect("written");
        assert!(std::fs::read_to_string(&path)
            .expect("there")
            .contains("output eDP-1 scale 1.25"));
    }
}
