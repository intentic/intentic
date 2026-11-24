use std::path::PathBuf;

use serde_json::{json, Value};

use super::sway;
use super::Paths;
use crate::util::{bail, Result};

/* `ic os keyboard`: WHICH KEYBOARD LAYOUT THE SCREEN USES. The layouts are xkb's own list (`evdev.lst`, which
xkeyboard-config installs with every Wayland desktop), read by the pure functions below. A layout set here is written
to /etc/intentic/sway.d/40-keyboard.conf, so it holds at the next start, and applied to the running session through
sway's `input type:keyboard` commands. That file is the record of what was chosen: `status` reads it, and only when
nothing was ever chosen asks the running session what it uses. Desktop edition only (sway.rs). */

/// xkb's list of models, layouts, variants and options, as the session's keymaps are built from it.
pub fn evdev_list(paths: &Paths) -> PathBuf {
    paths.at("/usr/share/X11/xkb/rules/evdev.lst")
}

/// The file the chosen layout is kept in.
pub fn config_path(paths: &Paths) -> PathBuf {
    sway::settings_dir(paths).join("40-keyboard.conf")
}

/// The layout every machine starts with until someone picks another.
const DEFAULT_LAYOUT: &str = "us";

/// One layout and its variants, as xkb names them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub layout: String,
    pub name: String,
    pub variants: Vec<(String, String)>,
}

/// `evdev.lst` read: its `! layout` section (`  us              English (US)`) and its `! variant` section
/// (`  intl            us: English (US, intl., with dead keys)`), each variant under its layout, in xkb's order. Pure.
pub fn layouts(evdev: &str) -> Vec<Layout> {
    let mut found: Vec<Layout> = Vec::new();
    let mut section = "";
    for line in evdev.lines() {
        if let Some(name) = line.strip_prefix('!') {
            section = match name.trim() {
                "layout" => "layout",
                "variant" => "variant",
                _ => "",
            };
            continue;
        }
        let line = line.trim();
        let Some((code, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let rest = rest.trim();
        match section {
            "layout" => found.push(Layout {
                layout: code.to_string(),
                name: rest.to_string(),
                variants: Vec::new(),
            }),
            "variant" => {
                let Some((layout, name)) = rest.split_once(": ") else {
                    continue;
                };
                if let Some(owner) = found.iter_mut().find(|found| found.layout == layout) {
                    owner
                        .variants
                        .push((code.to_string(), name.trim().to_string()));
                }
            }
            _ => {}
        }
    }
    found
}

/// `ic os keyboard layouts --json`. Pure.
pub fn layouts_value(layouts: &[Layout]) -> Value {
    json!({
        "layouts": layouts
            .iter()
            .map(|layout| json!({
                "layout": layout.layout,
                "name": layout.name,
                "variants": layout
                    .variants
                    .iter()
                    .map(|(variant, name)| json!({ "variant": variant, "name": name }))
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
    })
}

/// The name a person reads for a layout and variant: the variant's own (it names the layout too), else the layout's.
/// Pure.
pub fn name_of(layouts: &[Layout], layout: &str, variant: Option<&str>) -> Option<String> {
    let found = layouts.iter().find(|found| found.layout == layout)?;
    match variant {
        None => Some(found.name.clone()),
        Some(variant) => found
            .variants
            .iter()
            .find(|(code, _)| code == variant)
            .map(|(_, name)| name.clone()),
    }
}

/// The layout and variant a name stands for, the way sway reports the active one (`xkb_active_layout_name`). Pure.
pub fn by_name(layouts: &[Layout], name: &str) -> Option<(String, Option<String>)> {
    for layout in layouts {
        if layout.name == name {
            return Some((layout.layout.clone(), None));
        }
        if let Some((variant, _)) = layout.variants.iter().find(|(_, named)| named == name) {
            return Some((layout.layout.clone(), Some(variant.clone())));
        }
    }
    None
}

/// What the settings file chose: its `xkb_layout` and `xkb_variant`, in a block or on one line each. Pure.
pub fn chosen(config: &str) -> Option<(String, Option<String>)> {
    let mut layout = None;
    let mut variant = None;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let words: Vec<&str> = line.split_whitespace().collect();
        for pair in words.windows(2) {
            match pair[0] {
                "xkb_layout" => layout = Some(pair[1].to_string()),
                "xkb_variant" => variant = Some(pair[1].to_string()).filter(|v| v != "\"\""),
                _ => {}
            }
        }
    }
    Some((layout?, variant))
}

/// The settings file for a layout and variant. Pure.
pub fn config_for(layout: &str, variant: Option<&str>) -> String {
    let mut text = String::from(
        "# Written by `ic os keyboard set` (This computer, Keyboard): the layout of every keyboard on this screen.\n# Changed from there; a hand edit is replaced the next time a layout is chosen.\ninput type:keyboard {\n",
    );
    text.push_str(&format!("    xkb_layout {layout}\n"));
    if let Some(variant) = variant {
        text.push_str(&format!("    xkb_variant {variant}\n"));
    }
    text.push_str("}\n");
    text
}

/// The sway commands that move the running session to a layout: the variant cleared first, so every keymap on the way
/// is one xkb can build (sway keeps the old one when a step cannot be built, and a layout set over another layout's
/// variant cannot). Pure.
pub fn live_commands(layout: &str, variant: Option<&str>) -> Vec<String> {
    let mut commands = vec![
        "input type:keyboard xkb_variant \"\"".to_string(),
        format!("input type:keyboard xkb_layout {layout}"),
    ];
    if let Some(variant) = variant {
        commands.push(format!("input type:keyboard xkb_variant {variant}"));
    }
    commands
}

/// `ic os keyboard status --json`: the file's choice, else the running session's, else the default. Pure.
pub fn status_value(
    layouts: &[Layout],
    chosen: Option<(String, Option<String>)>,
    active_name: Option<&str>,
) -> Value {
    let (layout, variant) = chosen
        .or_else(|| active_name.and_then(|name| by_name(layouts, name)))
        .unwrap_or_else(|| (DEFAULT_LAYOUT.to_string(), None));
    json!({
        "layout": layout,
        "variant": variant,
        "name": name_of(layouts, &layout, variant.as_deref()),
    })
}

/// An xkb layout or variant name as ic takes it. Pure.
pub fn valid_xkb_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
}

fn read_layouts(paths: &Paths) -> Result<Vec<Layout>> {
    let path = evdev_list(paths);
    let text = std::fs::read_to_string(&path).map_err(|err| {
        crate::util::Fail(format!(
            "could not read the keyboard layouts ({}): {err}",
            path.display()
        ))
    })?;
    Ok(layouts(&text))
}

/// The active layout's name, from the running session's first keyboard; None when none runs or none is plugged in.
fn active_name() -> Option<String> {
    let socket = sway::socket()?;
    let inputs = sway::get(&socket, "get_inputs").ok()?;
    inputs
        .as_array()?
        .iter()
        .filter(|input| input["type"] == "keyboard")
        .find_map(|input| input["xkb_active_layout_name"].as_str().map(str::to_string))
}

/// `ic os keyboard status [--json]`.
pub fn status(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    sway::require_screen()?;
    let paths = Paths::here();
    let layouts = read_layouts(&paths)?;
    let chosen = std::fs::read_to_string(config_path(&paths))
        .ok()
        .and_then(|config| chosen(&config));
    let active = if chosen.is_none() {
        active_name()
    } else {
        None
    };
    let status = status_value(&layouts, chosen, active.as_deref());
    if json {
        super::emit_json(&status);
    } else {
        crate::ui::done(&format!(
            "The keyboard layout is {}.",
            status["name"]
                .as_str()
                .or(status["layout"].as_str())
                .unwrap_or(DEFAULT_LAYOUT)
        ));
    }
    Ok(())
}

/// `ic os keyboard layouts [--json]`.
pub fn list(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    sway::require_screen()?;
    let layouts = read_layouts(&Paths::here())?;
    if json {
        super::emit_json(&layouts_value(&layouts));
        return Ok(());
    }
    crate::ui::report("Keyboard layouts", None);
    let fields: Vec<(String, String)> = layouts
        .iter()
        .map(|layout| {
            let name = if layout.variants.is_empty() {
                layout.name.clone()
            } else {
                format!(
                    "{} (variants: {})",
                    layout.name,
                    layout
                        .variants
                        .iter()
                        .map(|(variant, _)| variant.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            (layout.layout.clone(), name)
        })
        .collect();
    crate::ui::fields(&fields);
    Ok(())
}

/// `ic os keyboard set <layout> [--variant v]`: checked against xkb's list, kept in the settings file, then applied to
/// the running session when there is one.
pub fn set(layout: &str, variant: Option<&str>) -> Result<()> {
    sway::require_screen()?;
    if !valid_xkb_name(layout) || variant.is_some_and(|variant| !valid_xkb_name(variant)) {
        bail!("Name a layout and variant as xkb does (ic os keyboard layouts), like de or nodeadkeys.");
    }
    let paths = Paths::here();
    let layouts = read_layouts(&paths)?;
    let Some(name) = name_of(&layouts, layout, variant) else {
        bail!(
            "{}",
            crate::ui::explain(
                &match variant {
                    Some(variant) => format!("{layout} has no variant called {variant}."),
                    None => format!("There is no keyboard layout called {layout}."),
                },
                None,
                Some("ic os keyboard layouts"),
            )
        );
    };
    super::write_atomic(&config_path(&paths), config_for(layout, variant).as_bytes())?;
    match sway::socket() {
        Some(socket) => {
            sway::command(&socket, &live_commands(layout, variant))?;
            crate::ui::done(&format!("The keyboard is {name} now, and at every start."));
        }
        None => crate::ui::done(&format!(
            "The keyboard is {name} from the next time the screen starts (its session is not running now)."
        )),
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixture {
    /// Lines of `/usr/share/X11/xkb/rules/evdev.lst` from xkeyboard-config 2.42, as they are there: a model, three
    /// layouts, their variants (one, `us` of `ba`, named like a layout), and an option.
    pub const EVDEV: &str = "! model
  pc105           Generic 105-key PC

! layout
  us              English (US)
  de              German
  pl              Polish

! variant
  intl            us: English (US, intl., with dead keys)
  dvorak          us: English (Dvorak)
  nodeadkeys      de: German (no dead keys)
  us              ba: Bosnian (US)

! option
  grp                  Switching to another layout
  grp:switch           Right Alt (while pressed)
";
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
    fn xkbs_list_reads_as_layouts_with_their_variants() {
        let read = layouts(fixture::EVDEV);
        assert_eq!(read.len(), 3);
        assert_eq!(read[0].layout, "us");
        assert_eq!(
            read[0].variants,
            vec![
                (
                    "intl".to_string(),
                    "English (US, intl., with dead keys)".to_string()
                ),
                ("dvorak".to_string(), "English (Dvorak)".to_string())
            ]
        );
        // A variant whose layout is not in the list is left out, not hung on another.
        assert_eq!(read[2].variants, vec![]);
        assert_eq!(layouts_value(&read), golden()["keyboardLayouts"][0]);
    }

    #[test]
    fn every_keyboard_status_the_contract_shows_is_what_the_mapping_makes() {
        let read = layouts(fixture::EVDEV);
        let examples = golden()["keyboardStatus"].clone();
        assert_eq!(
            status_value(&read, chosen(&config_for("de", Some("nodeadkeys"))), None),
            examples[0]
        );
        // Nothing chosen and no session: the default.
        assert_eq!(status_value(&read, None, None), examples[1]);
        // Nothing chosen: the running session's own, by its name.
        assert_eq!(
            status_value(&read, None, Some("German (no dead keys)")),
            examples[0]
        );
        // A choice xkb has no name for still says what it is.
        assert_eq!(
            status_value(&read, Some(("xx".into(), None)), None),
            json!({ "layout": "xx", "variant": null, "name": null })
        );
    }

    #[test]
    fn the_settings_file_says_the_choice_and_reads_back_as_it() {
        let file = config_for("de", Some("nodeadkeys"));
        assert!(file
            .contains("input type:keyboard {\n    xkb_layout de\n    xkb_variant nodeadkeys\n}\n"));
        assert_eq!(
            chosen(&file),
            Some(("de".to_string(), Some("nodeadkeys".to_string())))
        );
        assert_eq!(
            chosen(&config_for("pl", None)),
            Some(("pl".to_string(), None))
        );
        assert_eq!(
            chosen("input type:keyboard xkb_layout fr\ninput type:keyboard xkb_variant \"\"\n"),
            Some(("fr".to_string(), None))
        );
        assert_eq!(chosen("# nothing yet\n"), None);
    }

    #[test]
    fn the_running_session_moves_through_keymaps_xkb_can_build() {
        assert_eq!(
            live_commands("us", Some("intl")),
            vec![
                "input type:keyboard xkb_variant \"\"",
                "input type:keyboard xkb_layout us",
                "input type:keyboard xkb_variant intl"
            ]
        );
        assert_eq!(live_commands("pl", None).len(), 2);
    }

    #[test]
    fn names_go_both_ways_and_only_xkbs_names_are_taken() {
        let read = layouts(fixture::EVDEV);
        assert_eq!(
            name_of(&read, "us", Some("dvorak")).as_deref(),
            Some("English (Dvorak)")
        );
        assert_eq!(name_of(&read, "us", Some("nodeadkeys")), None);
        assert_eq!(by_name(&read, "Polish"), Some(("pl".to_string(), None)));
        assert_eq!(by_name(&read, "Klingon"), None);
        for good in [
            "us",
            "de",
            "nodeadkeys",
            "alt-intl",
            "mac_nodeadkeys",
            "ch+fr",
        ] {
            assert!(valid_xkb_name(good), "{good}");
        }
        for bad in ["", "-de", "de;exec x", "de fr", "\"\"", "de,fr"] {
            assert!(!valid_xkb_name(bad), "{bad}");
        }
    }

    /// The real list on this machine, when it has one: every layout named and none lost.
    #[test]
    fn the_installed_list_reads_whole_where_there_is_one() {
        let Ok(text) = std::fs::read_to_string("/usr/share/X11/xkb/rules/evdev.lst") else {
            return;
        };
        let read = layouts(&text);
        assert!(read.len() > 50, "{}", read.len());
        assert!(read
            .iter()
            .any(|layout| layout.layout == "us" && !layout.variants.is_empty()));
    }
}
