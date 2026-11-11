use super::unsaved::is_local_window;
use super::WORKSPACE;
use crate::state::{read_json, write_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};

/* THE ACCOUNT'S PREFERENCES ON EVERY PAGE OF THE APP (2026-11-11). The workspace and This computer are two pages of one
window, each its own origin with a storage of its own, and only the workspace's page reaches the account. Until this, a
local page kept whatever its own storage held, and every switch between a sandbox and This computer resized the rail
(a comfortable rail and large text there, a compact rail and default text in the workspace).

The workspace says everything that follows the account whenever any of it changes (`intentic://window?do=prefs`, the web's
desktopPreferences.ts); kept here (`ui-prefs.json`), it is what every local page is handed before it paints (local.html)
and is told as it changes. A choice made on a local page goes the other way: told to the workspace's page, which takes it
as its own so the account keeps it, and handed to it when it is next built if it is not up. Until the workspace says that
choice back, its own word on that preference waits, so a page that spoke before it heard is never taken over the choice. */

/// Preference key to the string a page stores for it, `None` for one nobody chose.
pub type Values = BTreeMap<String, Option<String>>;

/// What the app holds of the carried preferences, as `ui-prefs.json` keeps it.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Carried {
    /// Grows with every change, and is never below the clock's milliseconds at that change, so a page that took a version
    /// before this file was lost never reads a newer one as old.
    pub version: u64,
    /// What every local page wears: the workspace's word, with any choice made on a local page laid over it.
    pub values: Values,
    /// Choices made on a local page that the workspace has not said back yet.
    #[serde(default)]
    pub chosen: Values,
}

/// The most preferences one link may carry, and the longest key and value: well past what any page sends, and a bound on
/// what a link can make the app keep and hand every page.
const MOST: usize = 32;
const KEY_MAX: usize = 48;
const VALUE_MAX: usize = 64;

/// A preference's key as the pages name them: `ui-` and lowercase words. Pure.
fn is_key(key: &str) -> bool {
    key.len() <= KEY_MAX
        && key.strip_prefix("ui-").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// A stored preference string: a short token (`comfortable`, `135`, `sanctum`, `pl`). Pure.
fn is_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= VALUE_MAX
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// `do=prefs`'s `values`, a JSON object of key to string or `null`: the entries that pass, or no link at all for one that
/// is not such an object or carries more than [`MOST`]. Pure.
pub(crate) fn values_of(json: &str) -> Option<Values> {
    let told: BTreeMap<String, Option<String>> = serde_json::from_str(json).ok()?;
    if told.len() > MOST {
        return None;
    }
    Some(
        told.into_iter()
            .filter(|(key, value)| is_key(key) && value.as_deref().is_none_or(is_value))
            .collect(),
    )
}

/// What `told` changes in `carried`, from the workspace's page when `from_workspace`, else from a local page, at `now_ms`:
/// the values every local page now wears differently. Pure.
fn hear(carried: &mut Carried, told: Values, from_workspace: bool, now_ms: u64) -> Values {
    let mut changed = Values::new();
    for (key, value) in told {
        if from_workspace {
            match carried.chosen.get(&key) {
                // The workspace has taken the choice: it is its word from here.
                Some(chosen) if *chosen == value => {
                    carried.chosen.remove(&key);
                }
                // Said before it heard of the choice; it will say again once it has.
                Some(_) => continue,
                None => {}
            }
        } else if carried.values.get(&key) != Some(&value) {
            carried.chosen.insert(key.clone(), value.clone());
        }
        if carried.values.get(&key) != Some(&value) {
            carried.values.insert(key.clone(), value.clone());
            changed.insert(key, value);
        }
    }
    if !changed.is_empty() {
        carried.version = (carried.version + 1).max(now_ms);
    }
    changed
}

/// What a page is handed: the version and the values, as the web's desktopPreferences.ts reads them. Pure.
fn handover(version: u64, values: &Values) -> String {
    serde_json::json!({ "version": version, "values": values }).to_string()
}

/// `window.__INTENTIC_PREFS__`, set before any script of the page runs. Nothing before any page has said. Pure.
fn init_script(version: u64, values: &Values) -> String {
    if values.is_empty() {
        return String::new();
    }
    format!("window.__INTENTIC_PREFS__ = {};", handover(version, values))
}

/// What a page already up runs to take a change; a page without the receiver (one older than this) ignores it. Pure.
fn tell_script(version: u64, values: &Values) -> String {
    format!(
        "window.__INTENTIC_PREFS_IN__ && window.__INTENTIC_PREFS_IN__({});",
        handover(version, values)
    )
}

/* WHAT THE APP HOLDS, read from its file the first time it is asked for. */

const FILE: &str = "ui-prefs.json";

static HELD: LazyLock<Mutex<Option<Carried>>> = LazyLock::new(Mutex::default);

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

/// `work` on what the app holds, loaded first if it has not been.
fn with_held<T>(app: &AppHandle, work: impl FnOnce(&mut Carried) -> T) -> T {
    let mut held = HELD.lock().unwrap();
    let carried = held.get_or_insert_with(|| {
        file(app)
            .and_then(|path| read_json(&path))
            .unwrap_or_default()
    });
    work(carried)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// What a local page (local_pages.rs) is handed before it paints: what the workspace holds.
pub(crate) fn local_init_script(app: &AppHandle) -> String {
    with_held(app, |carried| init_script(carried.version, &carried.values))
}

/// What the workspace's page is handed as it is built: the choices made on a local page it has not taken yet.
pub(crate) fn workspace_init_script(app: &AppHandle) -> String {
    with_held(app, |carried| init_script(carried.version, &carried.chosen))
}

/// A page saying its preferences (`do=prefs`): the workspace's whole set, or one choice made on a local page. Kept, and
/// told to the pages that wear it: every local page but the one that spoke, and the workspace's for a local choice. Any
/// other page (a floating panel of the workspace's, which its own page speaks for) is not heard.
pub(crate) fn heard(app: &AppHandle, from: &str, told: Values) {
    let from_workspace = from == WORKSPACE;
    if !from_workspace && !is_local_window(from) {
        return;
    }
    let (version, changed) = with_held(app, |carried| {
        let before = carried.clone();
        let changed = hear(carried, told, from_workspace, now_ms());
        if *carried != before {
            if let Some(path) = file(app) {
                write_json(&path, carried);
            }
        }
        (carried.version, changed)
    });
    if changed.is_empty() {
        return;
    }
    let script = tell_script(version, &changed);
    for page in app.webviews().into_values() {
        let label = page.label();
        let wears =
            label != from && (is_local_window(label) || (label == WORKSPACE && !from_workspace));
        if wears {
            let _ = page.eval(&script);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(entries: &[(&str, Option<&str>)]) -> Values {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.map(str::to_string)))
            .collect()
    }

    #[test]
    fn a_link_keeps_only_preference_keys_and_short_tokens() {
        assert_eq!(
            values_of(
                r#"{"ui-icon-rail-size":"comfortable","ui-text-size":null,"intentic.x":"1","ui-skin":"a b","ui-locale":"pl"}"#
            ),
            Some(values(&[
                ("ui-icon-rail-size", Some("comfortable")),
                ("ui-locale", Some("pl")),
                ("ui-text-size", None),
            ]))
        );
        assert_eq!(values_of("[]"), None, "not an object");
        assert_eq!(
            values_of(r#"{"ui-a":1}"#),
            None,
            "a value that is not a string"
        );
        let many: BTreeMap<String, &str> = (0..=MOST).map(|n| (format!("ui-k{n}"), "x")).collect();
        assert_eq!(
            values_of(&serde_json::to_string(&many).unwrap()),
            None,
            "too many"
        );
        assert!(!is_key("ui-"));
        assert!(!is_key("ui-Upper"));
        assert!(!is_value(""));
        assert!(!is_value(&"x".repeat(VALUE_MAX + 1)));
    }

    #[test]
    fn the_workspace_is_worn_by_local_pages_and_only_what_changed_is_told() {
        let mut carried = Carried::default();
        let told = values(&[
            ("ui-icon-rail-size", None),
            ("ui-text-size", Some("default")),
        ]);
        assert_eq!(hear(&mut carried, told.clone(), true, 1_000), told);
        assert_eq!(carried.version, 1_000);
        assert_eq!(carried.values, told);
        assert!(carried.chosen.is_empty());
        assert!(
            hear(&mut carried, told, true, 2_000).is_empty(),
            "the same set again"
        );
        assert_eq!(carried.version, 1_000, "nothing changed, no new version");
        let changed = hear(
            &mut carried,
            values(&[("ui-icon-rail-size", None), ("ui-text-size", Some("large"))]),
            true,
            900,
        );
        assert_eq!(changed, values(&[("ui-text-size", Some("large"))]));
        assert_eq!(
            carried.version, 1_001,
            "never below the last one, whatever the clock says"
        );
    }

    #[test]
    fn a_local_choice_holds_until_the_workspace_says_it_back() {
        let mut carried = Carried::default();
        hear(
            &mut carried,
            values(&[("ui-text-size", Some("default"))]),
            true,
            1,
        );
        let chosen = values(&[("ui-text-size", Some("large"))]);
        assert_eq!(hear(&mut carried, chosen.clone(), false, 2), chosen);
        assert_eq!(carried.chosen, chosen);
        // The workspace's set from before it took the choice changes nothing.
        assert!(hear(
            &mut carried,
            values(&[("ui-text-size", Some("default"))]),
            true,
            3
        )
        .is_empty());
        assert_eq!(carried.values, chosen);
        // Said back, it is the workspace's word again, and its later changes are worn.
        assert!(hear(&mut carried, chosen.clone(), true, 4).is_empty());
        assert!(carried.chosen.is_empty());
        let next = values(&[("ui-text-size", None)]);
        assert_eq!(hear(&mut carried, next.clone(), true, 5), next);
    }

    #[test]
    fn a_local_choice_the_workspace_already_holds_is_no_choice_to_carry() {
        let mut carried = Carried::default();
        hear(
            &mut carried,
            values(&[("ui-skin", Some("sanctum"))]),
            true,
            1,
        );
        assert!(hear(
            &mut carried,
            values(&[("ui-skin", Some("sanctum"))]),
            false,
            2
        )
        .is_empty());
        assert!(carried.chosen.is_empty());
    }

    #[test]
    fn pages_are_handed_the_set_before_they_paint_and_told_changes_after() {
        let set = values(&[
            ("ui-icon-rail-size", Some("compact")),
            ("ui-text-size", None),
        ]);
        assert_eq!(
            init_script(7, &set),
            r#"window.__INTENTIC_PREFS__ = {"values":{"ui-icon-rail-size":"compact","ui-text-size":null},"version":7};"#
        );
        assert_eq!(
            init_script(7, &Values::new()),
            "",
            "nothing held, nothing handed"
        );
        assert_eq!(
            tell_script(8, &values(&[("ui-text-size", Some("large"))])),
            r#"window.__INTENTIC_PREFS_IN__ && window.__INTENTIC_PREFS_IN__({"values":{"ui-text-size":"large"},"version":8});"#
        );
    }

    #[test]
    fn a_file_from_before_chosen_was_kept_still_reads() {
        let carried: Carried =
            serde_json::from_str(r#"{"version":3,"values":{"ui-text-size":"large"}}"#).unwrap();
        assert_eq!(carried.version, 3);
        assert!(carried.chosen.is_empty());
    }
}
