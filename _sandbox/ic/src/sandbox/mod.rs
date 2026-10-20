pub mod at_rest;
pub mod attention;
pub mod backup;
pub mod composition;
pub mod connect;
pub mod desired;
pub mod doctor;
pub mod fix;
#[cfg(test)]
mod host_files;
pub mod identity;
pub mod inside;
pub mod intent;
pub mod labels;
pub mod ledger;
pub mod listing;
pub mod lock;
pub mod logs;
pub mod loopback;
pub mod mirror;
pub mod outcome;
pub mod owner;
pub mod power;
pub mod preflight;
pub mod preparing;
pub mod probation;
pub mod project_dir;
pub mod recreate;
pub mod remove;
pub mod restore;
pub mod resume;
pub mod session;
pub mod side;
pub mod sleep;
pub mod staged;
pub mod storage;
pub mod swaps;
pub mod target_probe;
pub mod tidy;
pub mod trash;
pub mod versions;

use crate::docker;
use crate::util::{bail, Result};

/* The name shapes shared with the run contract (@intentic/sandbox-run sandboxNames) and cleanup.sh. */
pub const CONTAINER_PREFIX: &str = "intentic-sandbox-";
pub const TUNNEL_PREFIX: &str = "intentic-sandbox-tunnel-";
pub const DIND_PREFIX: &str = "intentic-dind-host-";
/// What a swap renames the container it is replacing to, until the new one has proved itself (recreate.rs).
pub const PARKED_SUFFIX: &str = ".previous";
/// What `ic engine move` renames a container it carried to the other engine to: the copy left behind, stopped, until
/// its days are up (engine/moves.rs). Never a sandbox of its own.
pub const MOVED_SUFFIX: &str = ".moved";

/// Epoch milliseconds, the unit every record and the sandbox's own files use.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// The container a sandbox runs as, and the one a swap parks it as.
pub fn container_of(slug: &str) -> String {
    format!("{CONTAINER_PREFIX}{slug}")
}

pub fn parked_of(slug: &str) -> String {
    format!("{CONTAINER_PREFIX}{slug}{PARKED_SUFFIX}")
}

/// Every sandbox slug on this machine — the primary containers only (`-tunnel-` shares the prefix).
/// `ps -a`, not `ps`: a daemon that broke badly enough left its container EXITED, and requiring it to run
/// made the one flow that could fix it the one flow you could not reach.
pub fn list_slugs() -> Vec<String> {
    live_slugs().unwrap_or_default()
}

/// The same slugs, or None when docker could not list its containers: a flow that deletes must not read an
/// unanswered question as "no sandbox is running".
pub fn live_slugs() -> Option<Vec<String>> {
    docker::ps_names(true, &format!("^{CONTAINER_PREFIX}")).map(|names| slugs_of(&names))
}

/// The sandboxes a container listing names. A PARKED container is the sandbox it was parked from, never a sandbox of
/// its own: beside the live container it is the previous version on probation and adds nothing, and alone it is a
/// sandbox an interrupted swap left down, which every verb must still be able to find by its own name (a bare
/// `ic sandbox update` that took `<slug>.previous` for the slug would boot it on new, empty volumes).
pub(crate) fn slugs_of(names: &[String]) -> Vec<String> {
    let mut slugs: Vec<String> = Vec::new();
    for name in names
        .iter()
        .filter(|name| !name.starts_with(TUNNEL_PREFIX) && !name.ends_with(MOVED_SUFFIX))
    {
        let Some(slug) = name.strip_prefix(CONTAINER_PREFIX) else {
            continue;
        };
        let slug = slug.strip_suffix(PARKED_SUFFIX).unwrap_or(slug);
        if !slugs.iter().any(|seen| seen == slug) {
            slugs.push(slug.to_string());
        }
    }
    slugs
}

/// Whether a name can be a sandbox's slug: the shapes ic makes (`sandbox-<12 hex>`, a token's 12 hex, a hostname's
/// first label, `runner-<name>`) and anything else docker takes after a container name's prefix — letters, digits,
/// `-`, `_` and `.`, starting with a letter or a digit. Never a path: a slug becomes a file name under ~/.intentic
/// (the sandbox's lock, its record), and `ic sandbox stop ../../x` made a lock file outside it (2026-10-11). Pure.
pub fn is_slug(slug: &str) -> bool {
    let mut chars = slug.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && slug.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !slug.contains("..")
}

/// The names a command gave, each once, in the order given: `ic sandbox remove a a` is one removal (its second pass
/// found the first one's work in the trash, and cleared it), and one purge, typed by the name rather than "2". Pure.
pub fn each_once(slugs: Vec<String>) -> Vec<String> {
    let mut once: Vec<String> = Vec::with_capacity(slugs.len());
    for slug in slugs {
        if !once.contains(&slug) {
            once.push(slug);
        }
    }
    once
}

/// The stop for a sandbox this device does not have, with the one command that says which it does have.
pub fn missing(slug: &str) -> String {
    crate::ui::explain(
        &format!("There is no sandbox named {slug} on this device."),
        None,
        Some("ic sandbox list"),
    )
}

/// An explicit slug names the sandbox; only its absence falls back to detecting the single one — never
/// guess which sandbox to touch when the device runs several (`verb` names the re-run, e.g. "ic sandbox
/// update").
pub fn resolve_slug(given: Option<String>, verb: &str) -> Result<String> {
    if let Some(slug) = given {
        // A name no sandbox can have is one this device does not have, said before anything is made in its name.
        if !is_slug(&slug) {
            bail!("{}", missing(&slug));
        }
        return Ok(slug_named(slug));
    }
    let slugs = list_slugs();
    match slugs.len() {
        0 => bail!(
            "{}",
            crate::ui::explain(
                "There is no sandbox on this device.",
                None,
                Some("run the setup command from your browser first."),
            )
        ),
        1 => Ok(slugs.into_iter().next().expect("one slug")),
        _ => bail!(
            "{}",
            crate::ui::explain(
                &format!(
                    "This device has {}, so the command has to name one.",
                    crate::util::plural(slugs.len(), "sandbox")
                ),
                Some(&format!("they are {}.", slugs.join(", "))),
                Some(&format!("{verb} {}", slugs[0])),
            )
        ),
    }
}

/// The slug a name given on the command line stands for. The sandbox's own messages (a daemon that cannot read its
/// owner file, the platform's pages) name it by its 12-hex sandbox id, while a sandbox set up from the platform runs
/// as `sandbox-<id>`: an id with no container of its own is taken for that one, when it exists.
fn slug_named(given: String) -> String {
    let exists = |slug: &str| {
        docker::container_exists(&container_of(slug)) || docker::container_exists(&parked_of(slug))
    };
    let prefixed = format!("sandbox-{given}");
    if !given.starts_with("sandbox-") && !exists(&given) && exists(&prefixed) {
        return prefixed;
    }
    given
}

/// The sandbox's own network, before any container joins it: docker mints a missing named volume at run
/// time but never a missing network, so `--network` naming one that is absent refuses the whole launch. A network
/// made here carries ic's labels (labels.rs); one that exists is used as it is.
pub fn ensure_network(slug: &str) -> Result<()> {
    let network = trash::network(slug);
    if !docker::ok(&["network", "inspect", &network]) {
        let mut args: Vec<String> = vec!["network".to_string(), "create".to_string()];
        args.extend(labels::here(slug, labels::Kind::Network));
        args.push(network);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        docker::capture(&refs)?;
    }
    Ok(())
}

pub fn container_status(slug: &str) -> String {
    docker::inspect(&format!("{CONTAINER_PREFIX}{slug}"), "{{.State.Status}}")
        .unwrap_or_else(|| "?".to_string())
}

/// `ic sandbox list` — what the pickers show, as a verb of its own; `--json` is the machine-readable answer the
/// desktop app and the machine agent read (listing.rs).
pub fn list() -> Result<()> {
    docker::require_daemon()?;
    let slugs = list_slugs();
    crate::ui::report("intentic · sandboxes on this device", None);
    if slugs.is_empty() {
        crate::ui::quiet("There is no sandbox on this device.");
    }
    let mut rows: Vec<crate::ui::Item> = Vec::new();
    for slug in &slugs {
        let asleep = crate::record::read(slug).is_ok_and(|record| record.asleep);
        let status = shown_status(&container_status(slug), asleep).to_string();
        // The log's row stays `<status> <slug>`, the shape anything reading a listing already knows.
        crate::ui::plain(&format!("{status:<9} {slug}"));
        rows.push(crate::ui::Item::new(
            status_tone(&status),
            slug.clone(),
            status,
        ));
    }
    if crate::ui::is_rich() {
        crate::ui::items(&rows);
    }
    print_recoverable();
    Ok(())
}

/// The glyph a listing row carries: running is well, stopped or asleep is neutral, anything else wants a look. Pure.
fn status_tone(status: &str) -> crate::ui::Tone {
    match status {
        "running" => crate::ui::Tone::Ok,
        "exited" | "created" | "asleep" => crate::ui::Tone::Skip,
        _ => crate::ui::Tone::Warn,
    }
}

/// The state a listing row shows: docker's word, or `asleep` for a sandbox the keeper put to sleep that is still down
/// (sleep.rs), which "exited" would make read as broken. Pure.
fn shown_status(status: &str, asleep: bool) -> &str {
    if asleep && status != "running" && status != "restarting" {
        "asleep"
    } else {
        status
    }
}

/// The trash, under the live listing rather than in it: these are not sandboxes you can open, only ones you can
/// still get back. Silent when empty, so the ordinary listing is unchanged.
pub fn print_recoverable() {
    let recoverable = trash::list();
    if recoverable.is_empty() {
        return;
    }
    let now = trash::now_secs();
    if crate::ui::is_rich() {
        crate::ui::section("removed, recoverable");
        let rows: Vec<crate::ui::Item> = recoverable
            .iter()
            .map(|entry| {
                crate::ui::Item::new(
                    crate::ui::Tone::Skip,
                    entry.slug.clone(),
                    days_left(entry.days_left(now)),
                )
            })
            .collect();
        crate::ui::items(&rows);
        crate::ui::later(&[(
            "bring one back".to_string(),
            format!("ic sandbox restore {}", recoverable[0].slug),
        )]);
        return;
    }
    crate::ui::plain("\nremoved, still recoverable ('ic sandbox restore <slug>'):");
    // The machine agent reads these rows by name (_devices/machine/src/sync/gone.ts `trashedSlugs`).
    for entry in &recoverable {
        crate::ui::plain(&format!(
            "{:<9} {} ({} day(s) left)",
            "removed",
            entry.slug,
            entry.days_left(now)
        ));
    }
}

/// How long a removed sandbox stays recoverable, spelled out. Pure.
pub fn days_left(days: u64) -> String {
    format!("{} left", crate::util::plural(days as usize, "day"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The run contract's own record of these names (`@intentic/sandbox-run`), which its TypeScript and the desktop
    /// app's Rust are held to as well: a prefix that moves in one place fails here instead of orphaning containers.
    #[test]
    fn the_name_prefixes_are_the_ones_the_run_contract_records() {
        let shared: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-run/src/names.fixture.json"
        ))
        .unwrap();
        assert_eq!(shared["containerPrefix"], CONTAINER_PREFIX);
        assert_eq!(shared["tunnelPrefix"], TUNNEL_PREFIX);
        let slug = shared["slug"].as_str().unwrap();
        assert_eq!(
            shared["names"]["container"],
            format!("{CONTAINER_PREFIX}{slug}")
        );
        assert_eq!(
            shared["names"]["tunnelContainer"],
            format!("{TUNNEL_PREFIX}{slug}")
        );
    }

    #[test]
    fn a_sandbox_asleep_is_listed_as_asleep_and_one_running_as_running() {
        assert_eq!(shown_status("exited", true), "asleep");
        assert_eq!(shown_status("exited", false), "exited");
        assert_eq!(shown_status("running", true), "running");
    }

    #[test]
    fn a_listing_row_wants_a_look_only_when_it_is_neither_running_nor_resting() {
        assert_eq!(status_tone("running"), crate::ui::Tone::Ok);
        assert_eq!(status_tone("asleep"), crate::ui::Tone::Skip);
        assert_eq!(status_tone("exited"), crate::ui::Tone::Skip);
        assert_eq!(status_tone("restarting"), crate::ui::Tone::Warn);
        assert_eq!(status_tone("?"), crate::ui::Tone::Warn);
        assert_eq!(days_left(1), "1 day left");
        assert_eq!(days_left(6), "6 days left");
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_slug_is_a_name_never_a_path() {
        for slug in [
            "sandbox-2e8d89d75865",
            "2e8d89d75865",
            "runner-a1b2c3",
            "workspace-2",
            "work",
            "My_box.1",
        ] {
            assert!(is_slug(slug), "{slug}");
        }
        for slug in [
            "",
            "../../x",
            "..",
            "a/b",
            "a\\b",
            "a..b",
            "-dash-first",
            ".hidden",
            "white space",
            "ünï",
        ] {
            assert!(!is_slug(slug), "{slug}");
        }
        assert!(!is_slug(&"a".repeat(129)));
    }

    #[test]
    fn a_name_given_twice_is_one_name_in_the_order_given() {
        assert_eq!(
            each_once(names(&["b", "a", "b", "a", "c"])),
            names(&["b", "a", "c"])
        );
        assert!(each_once(Vec::new()).is_empty());
    }

    #[test]
    fn a_parked_container_is_the_sandbox_it_was_parked_from_never_one_of_its_own() {
        // On probation: the live container and the parked previous version are one sandbox.
        assert_eq!(
            slugs_of(&names(&[
                "intentic-sandbox-abc",
                "intentic-sandbox-abc.previous"
            ])),
            vec!["abc".to_string()]
        );
        // Interrupted: only the parked one is left, and it is still found by its own name.
        assert_eq!(
            slugs_of(&names(&["intentic-sandbox-abc.previous"])),
            vec!["abc".to_string()]
        );
        // A copy a move between engines left behind is not a sandbox either.
        assert_eq!(
            slugs_of(&names(&[
                "intentic-sandbox-abc.moved",
                "intentic-sandbox-def"
            ])),
            vec!["def".to_string()]
        );
        // Tunnel sidecars are not sandboxes.
        assert_eq!(
            slugs_of(&names(&[
                "intentic-sandbox-tunnel-abc",
                "intentic-sandbox-abc",
                "intentic-sandbox-def"
            ])),
            vec!["abc".to_string(), "def".to_string()]
        );
    }
}
