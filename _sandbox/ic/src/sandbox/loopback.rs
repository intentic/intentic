use std::collections::HashMap;

use serde_json::{json, Value};

use crate::sandbox::inside::{self, Read};
use crate::util::slug_from_token;

/* HOW THIS MACHINE REACHES A SANDBOX WITH NO NETWORK: its loopback port, and the names it is known by.

A sandbox publishes its loopback listener on `127.0.0.1:<port>` (the run contract's `-p 127.0.0.1:<port>:LOCAL_PORT`),
where the port derives from its 12-hex id, which derives from its connect token (@intentic/sandbox-run
`localDaemonPort`, `sandboxIdOfToken`). The editor keys a sandbox by the platform's own id for it, which only an
announce tells the daemon (the daemon's system/boot/platform-row.ts). `ic sandbox list --json` carries all three, so
the desktop app's offline face and `ic sandbox attention` dial a sandbox without asking the platform anything.

The owner's name for the sandbox and its logo are the platform's too, and the daemon keeps its last word on them beside
the row's id (`PRESENTATION_FILE`), so a listing still shows them while the platform is down (2026-11-09: an outage of
the api took every sandbox's name and logo off the desktop app). */

/// The container side of the loopback listener: @intentic/constants `LOCAL_PORT`, never the tunnel's `DAEMON_PORT`.
pub const LOCAL_PORT: u16 = 8788;

/// The host loopback band the port falls in (names.fixture.json `portBands.daemonLoopback`).
const LOCAL_PORT_BASE: u32 = 28000;
const LOCAL_PORT_SPAN: u32 = 4000;

/// Where the daemon keeps the platform's id for its row, relative to its HISTORY_ROOT.
pub const PLATFORM_ROW_FILE: &str = "platform-row.json";

/// Where the daemon keeps the owner's name and logo for its sandbox, beside `PLATFORM_ROW_FILE`:
/// `{ "name", "image"?, "digest"?, "at" }`, the image a `data:image/…` URL.
pub const PRESENTATION_FILE: &str = "presentation.json";

/// What a logo must start with to be listed: the daemon keeps a data URL, and anything else (a link, a path) would have
/// the desktop app fetch something no one vetted.
const LOGO_PREFIX: &str = "data:image/";

/// The loopback port a sandbox with this 12-hex id publishes on, by the run contract's formula. None for an id that
/// is not hex. Pure.
pub fn local_port_of(sandbox_id: &str) -> Option<u16> {
    let head = u32::from_str_radix(sandbox_id.get(..6)?, 16).ok()?;
    u16::try_from(LOCAL_PORT_BASE + head % LOCAL_PORT_SPAN).ok()
}

/// One `NAME=value` out of a docker inspect object's env list. Pure.
pub fn env_of<'a>(inspected: &'a Value, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    inspected["Config"]["Env"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find_map(|pair| pair.strip_prefix(prefix.as_str()))
        .filter(|value| !value.is_empty())
}

/// The host port docker binds the loopback listener to, as the container was created with it: present while it is
/// stopped too, unlike `NetworkSettings.Ports`. Some(None) when the container publishes no loopback listener (a hosted
/// shape, a dev container run by hand); None when the inspect object says nothing about its ports at all. Pure.
fn published_port(inspected: &Value) -> Option<Option<u16>> {
    let bindings = inspected["HostConfig"]["PortBindings"].as_object()?;
    Some(
        bindings
            .get(&format!("{LOCAL_PORT}/tcp"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|binding| binding["HostPort"].as_str()?.parse::<u16>().ok())
            .next(),
    )
}

/// What a listing row says about reaching the sandbox: its 12-hex id (null without a connect token) and its loopback
/// port, from the binding docker holds, else the formula when the inspect object carries no bindings to read; null
/// when it publishes none. Pure.
pub fn addressing(inspected: &Value) -> (Option<String>, Option<u16>) {
    let sandbox_id = env_of(inspected, "CONNECT_TOKEN").map(slug_from_token);
    let port = match published_port(inspected) {
        Some(port) => port,
        None => sandbox_id.as_deref().and_then(local_port_of),
    };
    (sandbox_id, port)
}

/// The platform's id out of the daemon's file; None for a file that is not one. Pure.
pub fn platform_id_from(file: &Value) -> Option<String> {
    file["platformId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// The owner's name and logo out of the daemon's presentation file: the name when it is a non-empty string, the image
/// when it is a `data:image/` URL, each None otherwise. Pure.
pub fn presentation_from(file: &Value) -> (Option<String>, Option<String>) {
    let name = file["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string);
    let logo = file["image"]
        .as_str()
        .filter(|image| image.starts_with(LOGO_PREFIX))
        .map(str::to_string);
    (name, logo)
}

// The sandbox's HISTORY_ROOT as its container was created with it, the daemon's default when it names none.
fn history_of(inspected: Option<&Value>) -> &str {
    inspected
        .and_then(|inspected| env_of(inspected, "HISTORY_ROOT"))
        .unwrap_or("/history")
        .trim_end_matches('/')
}

// One of the daemon's files off the history volume; None when it is missing, unreadable or docker would not say.
fn history_file(container: &str, inspected: Option<&Value>, file: &str) -> Option<Value> {
    match inside::read(container, &format!("{}/{file}", history_of(inspected))) {
        Read::Found(found) => Some(found),
        Read::Missing | Read::Unreadable(_) => None,
    }
}

/// The platform's id for the sandbox in `container`, off its history volume (works on a stopped container, as every
/// `docker cp` does). None before any announce named one, and when docker would not say.
pub fn platform_id(container: &str, inspected: Option<&Value>) -> Option<String> {
    history_file(container, inspected, PLATFORM_ROW_FILE)
        .as_ref()
        .and_then(platform_id_from)
}

/// What a listing row says of a sandbox off its history volume, each None when its file is missing, unreadable or
/// says nothing: never an error, since the rest of the row stands without it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VolumeFacts {
    pub platform_id: Option<String>,
    pub display_name: Option<String>,
    pub logo: Option<String>,
}

/// Every listed container's facts off its volume, read side by side: one `docker cp` per file, a container's two files
/// at once and every container at once, so a machine of five sandboxes waits for the slowest copy rather than the sum.
/// `docker cp` takes one path, so the presentation file is a second copy, never a second wait.
pub fn volume_facts(
    containers: &[String],
    inspected: &HashMap<String, Value>,
) -> HashMap<String, VolumeFacts> {
    std::thread::scope(|scope| {
        let reads: Vec<_> = containers
            .iter()
            .map(|container| {
                let inspected = inspected.get(container);
                let row = scope.spawn(move || platform_id(container, inspected));
                let presentation = scope.spawn(move || {
                    history_file(container, inspected, PRESENTATION_FILE)
                        .map(|file| presentation_from(&file))
                        .unwrap_or_default()
                });
                (container, row, presentation)
            })
            .collect();
        reads
            .into_iter()
            .map(|(container, row, presentation)| {
                let (display_name, logo) = presentation.join().unwrap_or_default();
                let facts = VolumeFacts {
                    platform_id: row.join().ok().flatten(),
                    display_name,
                    logo,
                };
                (container.clone(), facts)
            })
            .collect()
    })
}

/// The owner's name for each sandbox, in the order given, None where the daemon kept none (or docker would not say):
/// what `ic sandbox list` shows beside a slug, and what a verb given a name instead of a slug looks it up in. Read side
/// by side, off the live container or else the one a swap parked; HISTORY_ROOT comes from its inspect.
pub fn display_names(slugs: &[String]) -> Vec<(String, Option<String>)> {
    std::thread::scope(|scope| {
        let reads: Vec<_> = slugs
            .iter()
            .map(|slug| {
                scope.spawn(move || {
                    [
                        crate::sandbox::container_of(slug),
                        crate::sandbox::parked_of(slug),
                    ]
                    .into_iter()
                    .find_map(|container| {
                        let inspected: Value = serde_json::from_str(&crate::docker::inspect(
                            &container,
                            "{{json .}}",
                        )?)
                        .ok()?;
                        history_file(&container, Some(&inspected), PRESENTATION_FILE)
                    })
                    .and_then(|file| presentation_from(&file).0)
                })
            })
            .collect();
        slugs
            .iter()
            .cloned()
            .zip(reads.into_iter().map(|read| read.join().ok().flatten()))
            .collect()
    })
}

/// The listing's rows with `sandboxId`, `localPort`, `platformId`, `displayName` and `logo` added, each null when
/// unknown. A row whose container was not inspected gets none of them: nothing is known, which is not the same as known
/// to be absent. Pure.
pub fn with_addressing(
    listing: Value,
    inspected: &HashMap<String, Value>,
    facts: &HashMap<String, VolumeFacts>,
) -> Value {
    let Value::Array(rows) = listing else {
        return listing;
    };
    Value::Array(
        rows.into_iter()
            .map(|mut row| {
                let container = row["container"].as_str().unwrap_or_default().to_string();
                if let (Some(found), Some(fields)) =
                    (inspected.get(&container), row.as_object_mut())
                {
                    let (sandbox_id, port) = addressing(found);
                    let read = facts.get(&container).cloned().unwrap_or_default();
                    fields.insert("sandboxId".into(), json!(sandbox_id));
                    fields.insert("localPort".into(), json!(port));
                    fields.insert("platformId".into(), json!(read.platform_id));
                    fields.insert("displayName".into(), json!(read.display_name));
                    fields.insert("logo".into(), json!(read.logo));
                }
                row
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared() -> Value {
        serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-run/src/names.fixture.json"
        ))
        .unwrap()
    }

    /// The band is the run contract's: a port derived here that the container did not publish is a dial to nothing.
    #[test]
    fn the_port_formula_is_the_run_contracts() {
        let band = &shared()["portBands"]["daemonLoopback"];
        assert_eq!(band["base"], LOCAL_PORT_BASE);
        assert_eq!(band["span"], LOCAL_PORT_SPAN);
        // 0x3c469e is 3,950,238, which leaves 2,238 over the band's 4,000.
        assert_eq!(local_port_of("3c469e9d6c58"), Some(30238));
        assert_eq!(local_port_of("ffffff000000"), Some(29215));
        assert_eq!(local_port_of("xyz"), None);
        assert_eq!(local_port_of("zzzzzz123456"), None);
    }

    #[test]
    fn a_sandbox_is_addressed_by_its_tokens_id_and_the_port_docker_holds() {
        let token_vector = &shared()["sandboxIds"]["vectors"][0];
        let token = token_vector["token"].as_str().unwrap();
        let id = token_vector["id"].as_str().unwrap();
        let bound = json!({
            "Config": { "Env": [format!("CONNECT_TOKEN={token}"), "HISTORY_ROOT=/history"] },
            "HostConfig": { "PortBindings": { "8788/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "28111" }], "8787/tcp": [{ "HostPort": "9" }] } },
        });
        assert_eq!(addressing(&bound), (Some(id.to_string()), Some(28111)));
        // Published nothing on the loopback listener: no port, whatever the formula would say.
        let unpublished = json!({
            "Config": { "Env": [format!("CONNECT_TOKEN={token}")] },
            "HostConfig": { "PortBindings": {} },
        });
        assert_eq!(addressing(&unpublished), (Some(id.to_string()), None));
        // Nothing said about bindings at all: the formula.
        let silent = json!({ "Config": { "Env": [format!("CONNECT_TOKEN={token}")] } });
        assert_eq!(
            addressing(&silent),
            (Some(id.to_string()), local_port_of(id))
        );
        // No connect token (a dev container run by hand): no id, and so no formula either.
        let tokenless = json!({ "Config": { "Env": ["CONNECT_TOKEN="] } });
        assert_eq!(addressing(&tokenless), (None, None));
    }

    #[test]
    fn the_platforms_id_is_read_only_off_a_file_that_names_one() {
        assert_eq!(
            platform_id_from(&json!({ "platformId": "cm1abc" })),
            Some("cm1abc".to_string())
        );
        assert_eq!(platform_id_from(&json!({ "platformId": "" })), None);
        assert_eq!(platform_id_from(&json!({ "id": "cm1abc" })), None);
    }

    #[test]
    fn listed_rows_gain_their_addressing_and_an_uninspected_one_stays_as_it_was() {
        let listing = json!([
            { "slug": "work", "container": "intentic-sandbox-work", "running": true },
            { "slug": "gone", "container": "intentic-sandbox-gone", "running": false },
            { "slug": "new", "container": "intentic-sandbox-new", "running": true },
        ]);
        let inspected = HashMap::from([
            (
                "intentic-sandbox-work".to_string(),
                json!({ "Config": { "Env": ["CONNECT_TOKEN=token"] }, "HostConfig": { "PortBindings": { "8788/tcp": [{ "HostPort": "30238" }] } } }),
            ),
            (
                "intentic-sandbox-new".to_string(),
                json!({ "Config": { "Env": [] }, "HostConfig": { "PortBindings": {} } }),
            ),
        ]);
        let facts = HashMap::from([(
            "intentic-sandbox-work".to_string(),
            VolumeFacts {
                platform_id: Some("cm1".to_string()),
                display_name: Some("Work".to_string()),
                logo: Some("data:image/png;base64,iVBORw0KGgo=".to_string()),
            },
        )]);
        assert_eq!(
            with_addressing(listing, &inspected, &facts),
            json!([
                { "slug": "work", "container": "intentic-sandbox-work", "running": true, "sandboxId": "3c469e9d6c58", "localPort": 30238, "platformId": "cm1", "displayName": "Work", "logo": "data:image/png;base64,iVBORw0KGgo=" },
                { "slug": "gone", "container": "intentic-sandbox-gone", "running": false },
                { "slug": "new", "container": "intentic-sandbox-new", "running": true, "sandboxId": null, "localPort": null, "platformId": null, "displayName": null, "logo": null },
            ])
        );
    }

    #[test]
    fn the_owners_name_and_logo_are_read_only_when_the_file_says_them() {
        let logo = "data:image/svg+xml;base64,PHN2Zy8+";
        assert_eq!(
            presentation_from(
                &json!({ "name": "Work", "image": logo, "digest": "abc", "at": "2026-11-09T10:00:00.000Z" })
            ),
            (Some("Work".to_string()), Some(logo.to_string()))
        );
        // A name alone, with no logo chosen.
        assert_eq!(
            presentation_from(&json!({ "name": "Work", "at": "2026-11-09T10:00:00.000Z" })),
            (Some("Work".to_string()), None)
        );
        // An empty name is none, and so is a logo that is not a data URL of an image.
        assert_eq!(
            presentation_from(&json!({ "name": "  ", "image": "https://example.com/logo.png" })),
            (None, None)
        );
        assert_eq!(
            presentation_from(&json!({ "name": "", "image": "data:text/html;base64,PGgxPg==" })),
            (None, None)
        );
        // A file of another shape says nothing.
        assert_eq!(
            presentation_from(&json!({ "name": 7, "image": true })),
            (None, None)
        );
        assert_eq!(presentation_from(&json!(["Work"])), (None, None));
        assert_eq!(presentation_from(&json!(null)), (None, None));
    }
}
