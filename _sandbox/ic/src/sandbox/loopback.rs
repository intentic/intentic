use std::collections::HashMap;

use serde_json::{json, Value};

use crate::sandbox::inside::{self, Read};
use crate::util::slug_from_token;

/* HOW THIS MACHINE REACHES A SANDBOX WITH NO NETWORK: its loopback port, and the names it is known by.

A sandbox publishes its loopback listener on `127.0.0.1:<port>` (the run contract's `-p 127.0.0.1:<port>:LOCAL_PORT`),
where the port derives from its 12-hex id, which derives from its connect token (@intentic/sandbox-run
`localDaemonPort`, `sandboxIdOfToken`). The editor keys a sandbox by the platform's own id for it, which only an
announce tells the daemon (the daemon's system/boot/platform-row.ts). `ic sandbox list --json` carries all three, so
the desktop app's offline face and `ic sandbox attention` dial a sandbox without asking the platform anything. */

/// The container side of the loopback listener: @intentic/constants `LOCAL_PORT`, never the tunnel's `DAEMON_PORT`.
pub const LOCAL_PORT: u16 = 8788;

/// The host loopback band the port falls in (names.fixture.json `portBands.daemonLoopback`).
const LOCAL_PORT_BASE: u32 = 28000;
const LOCAL_PORT_SPAN: u32 = 4000;

/// Where the daemon keeps the platform's id for its row, relative to its HISTORY_ROOT.
pub const PLATFORM_ROW_FILE: &str = "platform-row.json";

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

/// The platform's id for the sandbox in `container`, off its history volume (works on a stopped container, as every
/// `docker cp` does). None before any announce named one, and when docker would not say.
pub fn platform_id(container: &str, inspected: Option<&Value>) -> Option<String> {
    let history = inspected
        .and_then(|inspected| env_of(inspected, "HISTORY_ROOT"))
        .unwrap_or("/history")
        .trim_end_matches('/');
    match inside::read(container, &format!("{history}/{PLATFORM_ROW_FILE}")) {
        Read::Found(file) => platform_id_from(&file),
        Read::Missing | Read::Unreadable(_) => None,
    }
}

/// Every listed container's platform id, read side by side: one `docker cp` each, so a machine of five sandboxes waits
/// for the slowest rather than the sum.
pub fn platform_ids(
    containers: &[String],
    inspected: &HashMap<String, Value>,
) -> HashMap<String, String> {
    std::thread::scope(|scope| {
        let reads: Vec<_> = containers
            .iter()
            .map(|container| {
                scope.spawn(move || {
                    platform_id(container, inspected.get(container))
                        .map(|id| (container.clone(), id))
                })
            })
            .collect();
        reads
            .into_iter()
            .filter_map(|read| read.join().ok().flatten())
            .collect()
    })
}

/// The listing's rows with `sandboxId`, `localPort` and `platformId` added, each null when unknown. A row whose
/// container was not inspected gets none of them: nothing is known, which is not the same as known to be absent. Pure.
pub fn with_addressing(
    listing: Value,
    inspected: &HashMap<String, Value>,
    platform_ids: &HashMap<String, String>,
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
                    fields.insert("sandboxId".into(), json!(sandbox_id));
                    fields.insert("localPort".into(), json!(port));
                    fields.insert("platformId".into(), json!(platform_ids.get(&container)));
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
        let ids = HashMap::from([("intentic-sandbox-work".to_string(), "cm1".to_string())]);
        assert_eq!(
            with_addressing(listing, &inspected, &ids),
            json!([
                { "slug": "work", "container": "intentic-sandbox-work", "running": true, "sandboxId": "3c469e9d6c58", "localPort": 30238, "platformId": "cm1" },
                { "slug": "gone", "container": "intentic-sandbox-gone", "running": false },
                { "slug": "new", "container": "intentic-sandbox-new", "running": true, "sandboxId": null, "localPort": null, "platformId": null },
            ])
        );
    }
}
