use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::docker;
use crate::record::{self, ChannelRecord};
use crate::sandbox::{desired, CONTAINER_PREFIX, TUNNEL_PREFIX};
use crate::shape::Shape;
use crate::util::{bail, Result};

/* `ic sandbox list --json` — what runs on this machine, what each sandbox should run after its next restart, and what is built and waiting for it: the one answer the machine agent, the desktop app and a person's script all read. */

/// How long a listing waits on docker. A daemon that takes longer than this to list its containers is a machine in
/// trouble, and every caller of this is a screen waiting to draw.
const READ_LIMIT: Duration = Duration::from_secs(20);

/// One `docker ps` row.
#[derive(Debug, PartialEq)]
struct Row {
    name: String,
    state: String,
    image: String,
}

/// Three fields asked for by name. NEVER `{{json .}}`: the whole-object template carries `Size`, so docker walks
/// every container's writable layer to compute it (0.5-1.5s against 60ms), and on Docker Desktop's containerd
/// snapshotter that walk FAILS whenever a temp file vanishes underneath it, which a sandbox writing to /tmp does
/// constantly. A listing broken by a size nothing asked for is every button gated on it, broken.
fn ps_args() -> Vec<String> {
    vec![
        "ps".to_string(),
        "-a".to_string(),
        "--filter".to_string(),
        format!("name=^{CONTAINER_PREFIX}"),
        "--format".to_string(),
        "{{.Names}}\t{{.State}}\t{{.Image}}".to_string(),
    ]
}

fn rows_from(listing: &str) -> Vec<Row> {
    listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim_end_matches('\r').split('\t');
            let name = fields.next()?.trim();
            let state = fields.next()?;
            (!name.is_empty()).then(|| Row {
                name: name.to_string(),
                state: state.to_string(),
                image: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// A workspace container and its tunnel sidecar share the prefix, and a user's own subdomain may legitimately BE
/// `tunnel-something`, so a name is only a sidecar when the workspace container it would belong to exists.
fn is_sidecar(name: &str, rows: &[Row]) -> bool {
    name.strip_prefix(TUNNEL_PREFIX).is_some_and(|slug| {
        rows.iter()
            .any(|row| row.name == format!("{CONTAINER_PREFIX}{slug}"))
    })
}

/// A docker limit field: a positive number is a cap, 0 (docker's "unbounded") and anything unreadable is none.
fn cap_of(value: &Value) -> Option<u64> {
    value.as_u64().filter(|limit| *limit > 0)
}

/// The whitespace-separated tokens of one `NAME=value` in a container's env list.
fn env_tokens(env: &[String], name: &str) -> Vec<String> {
    let prefix = format!("{name}=");
    env.iter()
        .find_map(|entry| entry.strip_prefix(prefix.as_str()))
        .map(|value| value.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Whether a HostConfig's DeviceRequests carry the GPU, in either spelling docker writes for `--gpus`: the nvidia
/// driver by name, or the `gpu` capability.
fn gpu_requested(host: &Value) -> bool {
    host["DeviceRequests"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|request| {
            request["Driver"] == "nvidia"
                || request["Capabilities"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|set| {
                        set.as_array()
                            .into_iter()
                            .flatten()
                            .any(|cap| *cap == "gpu")
                    })
        })
}

/// One container's share of this machine as docker enforces it (`SandboxResourcesSchema`), from its `docker
/// inspect` object, with the shape it runs with (the owner's ask it carries) and the shape saved for its next
/// restart. `HostConfig` is docker's key, not this repo's vocabulary: under any other name every cap reads absent.
fn resources_from(inspected: &Value, desired: Option<&Shape>) -> Value {
    let host = &inspected["HostConfig"];
    let env: Vec<String> = inspected["Config"]["Env"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str().map(str::to_string))
        .collect();
    let mut resources = Map::new();
    if let Some(memory) = cap_of(&host["Memory"]) {
        resources.insert("memoryBytes".into(), json!(memory));
    }
    if let Some(nanos) = cap_of(&host["NanoCpus"]) {
        resources.insert("cpus".into(), json!(nanos as f64 / 1_000_000_000.0));
    }
    resources.insert("privileged".into(), json!(host["Privileged"] == true));
    resources.insert("gpu".into(), json!(gpu_requested(host)));
    resources.insert(
        "hostRuntime".into(),
        json!(env_tokens(&env, "SANDBOX_RUNTIME")),
    );
    resources.insert(
        "overlayRuntime".into(),
        json!(env_tokens(&env, "SANDBOX_OVERLAY_RUNTIME")),
    );
    resources.insert("shape".into(), Shape::from_env(&env).to_json());
    if let Some(desired) = desired {
        resources.insert("desired".into(), desired.to_json());
    }
    Value::Object(resources)
}

/// What `prepare` built and left waiting for this sandbox, when anything is.
fn staged_of(record: &ChannelRecord) -> Option<Value> {
    let image = record.staged.as_ref()?;
    let mut staged = Map::new();
    staged.insert("image".into(), json!(image));
    if let Some(version) = &record.staged_version {
        staged.insert("version".into(), json!(version));
    }
    if let Some(channel) = &record.staged_channel {
        staged.insert("channel".into(), json!(channel));
    }
    Some(Value::Object(staged))
}

/// The listing, pure over what docker and the records said: one `DeviceSandboxSchema` object per sandbox, in the
/// order docker listed them (newest first). `inspected` is keyed by container name; a container missing from it
/// (it vanished between the two calls, or inspect failed) is listed without `resources` rather than left out.
fn listing(
    rows: &[Row],
    inspected: &HashMap<String, Value>,
    records: &HashMap<String, ChannelRecord>,
) -> Value {
    let sandboxes: Vec<Value> = rows
        .iter()
        .filter(|row| !is_sidecar(&row.name, rows))
        .filter_map(|row| {
            let slug = row.name.strip_prefix(CONTAINER_PREFIX)?;
            let record = records.get(slug);
            let mut sandbox = Map::new();
            sandbox.insert("slug".into(), json!(slug));
            sandbox.insert("container".into(), json!(row.name));
            sandbox.insert("running".into(), json!(row.state == "running"));
            sandbox.insert("image".into(), json!(row.image));
            // Absent when there is no sidecar at all, which is not the same fact as a sidecar that is down.
            if let Some(tunnel) = rows
                .iter()
                .find(|candidate| candidate.name == format!("{TUNNEL_PREFIX}{slug}"))
            {
                sandbox.insert("tunnelRunning".into(), json!(tunnel.state == "running"));
            }
            if let Some(inspected) = inspected.get(&row.name) {
                sandbox.insert(
                    "resources".into(),
                    resources_from(inspected, record.and_then(|record| record.desired.as_ref())),
                );
            }
            if let Some(staged) = record.and_then(staged_of) {
                sandbox.insert("staged".into(), staged);
            }
            Some(Value::Object(sandbox))
        })
        .collect();
    Value::Array(sandboxes)
}

/// `docker inspect --format '{{json .}}'` over several containers prints one object per line, each named with a
/// leading slash no other reader uses. A line that is not one object is a warning riding along.
fn inspected_from(listing: &str) -> HashMap<String, Value> {
    listing
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            let name = value["Name"].as_str()?.trim_start_matches('/').to_string();
            Some((name, value))
        })
        .collect()
}

/// `ic sandbox list --json`: one line of JSON on stdout, and nothing else there.
pub fn list_json() -> Result<()> {
    docker::require_daemon()?;
    let args = ps_args();
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let ps = docker::capture_bounded(&arg_refs, READ_LIMIT)?;
    if ps.timed_out || ps.code != Some(0) {
        bail!(
            "docker could not list this machine's containers{}",
            if ps.timed_out {
                format!(" within {}s", READ_LIMIT.as_secs())
            } else {
                format!(": {}", ps.stderr)
            }
        );
    }
    let rows = rows_from(&ps.stdout);
    let inspected = if rows.is_empty() {
        HashMap::new()
    } else {
        let mut inspect = vec!["inspect", "--format", "{{json .}}"];
        inspect.extend(rows.iter().map(|row| row.name.as_str()));
        // A container that vanished between the two calls fails the command with the others still on stdout.
        docker::capture_bounded(&inspect, READ_LIMIT)
            .map(|ran| inspected_from(&ran.stdout))
            .unwrap_or_default()
    };
    let mut records = HashMap::new();
    for row in rows.iter().filter(|row| !is_sidecar(&row.name, &rows)) {
        let Some(slug) = row.name.strip_prefix(CONTAINER_PREFIX) else {
            continue;
        };
        // A share an older ic saved becomes the record's desired shape here as anywhere; a record that cannot be
        // read lists the sandbox without what is waiting for it rather than failing the whole listing.
        if let Err(err) = desired::adopt_legacy(slug, &row.name) {
            eprintln!("intentic: {}", err.0);
        }
        if let Ok(record) = record::read(slug) {
            records.insert(slug.to_string(), record);
        }
    }
    println!("{}", listing(&rows, &inspected, &records));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Row> {
        rows_from(
            "intentic-sandbox-work\trunning\tghcr.io/intentic/sandbox:stable\n\
             intentic-sandbox-tunnel-work\texited\tcloudflare/cloudflared\n\
             intentic-sandbox-tunnel-lab\tcreated\tintentic-sandbox-env-lab:abc\n",
        )
    }

    #[test]
    fn a_sidecar_is_a_tunnel_whose_sandbox_exists_and_a_tunnel_named_sandbox_is_a_sandbox() {
        let rows = rows();
        assert_eq!(rows.len(), 3);
        assert!(is_sidecar("intentic-sandbox-tunnel-work", &rows));
        // A user's own subdomain may be `tunnel-lab`: no `intentic-sandbox-lab` exists, so it is a sandbox.
        assert!(!is_sidecar("intentic-sandbox-tunnel-lab", &rows));
    }

    #[test]
    fn the_listing_carries_running_desired_and_staged_state_in_the_contracts_shape() {
        let rows = rows();
        let inspected = inspected_from(
            &json!({
                "Name": "/intentic-sandbox-work",
                "HostConfig": {
                    "Memory": 12u64 * 1024 * 1024 * 1024,
                    "NanoCpus": 4_000_000_000u64,
                    "Privileged": false,
                    "DeviceRequests": [{ "Driver": "", "Capabilities": [["gpu"]] }],
                },
                "Config": { "Env": ["SANDBOX_MEMORY=12g", "SANDBOX_RUNTIME=--gpus=all", "SANDBOX_OVERLAY_RUNTIME=--device=/dev/net/tun"] },
            })
            .to_string(),
        );
        let records = HashMap::from([(
            "work".to_string(),
            ChannelRecord {
                staged: Some("img:next".to_string()),
                staged_version: Some("1.4.2".to_string()),
                desired: Some(Shape {
                    memory: Some("20g".to_string()),
                    cpus: None,
                    privileged: false,
                    gpus: true,
                }),
                ..ChannelRecord::default()
            },
        )]);
        assert_eq!(
            listing(&rows, &inspected, &records),
            json!([
                {
                    "slug": "work",
                    "container": "intentic-sandbox-work",
                    "running": true,
                    "image": "ghcr.io/intentic/sandbox:stable",
                    "tunnelRunning": false,
                    "resources": {
                        "memoryBytes": 12u64 * 1024 * 1024 * 1024,
                        "cpus": 4.0,
                        "privileged": false,
                        "gpu": true,
                        "hostRuntime": ["--gpus=all"],
                        "overlayRuntime": ["--device=/dev/net/tun"],
                        "shape": { "memoryGib": 12, "cpus": null, "privileged": false, "gpu": true },
                        "desired": { "memoryGib": 20, "cpus": null, "privileged": false, "gpu": true },
                    },
                    "staged": { "image": "img:next", "version": "1.4.2" },
                },
                // Not inspected (it vanished, or the inspect failed): listed, with nothing said about its share.
                {
                    "slug": "tunnel-lab",
                    "container": "intentic-sandbox-tunnel-lab",
                    "running": false,
                    "image": "intentic-sandbox-env-lab:abc",
                },
            ])
        );
    }

    #[test]
    fn unbounded_caps_are_absent_and_the_nvidia_driver_is_a_gpu_too() {
        let resources = resources_from(
            &json!({
                "HostConfig": { "Memory": 0, "NanoCpus": 0, "Privileged": true, "DeviceRequests": [{ "Driver": "nvidia" }] },
                "Config": { "Env": [] },
            }),
            None,
        );
        assert_eq!(
            resources,
            json!({
                "privileged": true,
                "gpu": true,
                "hostRuntime": [],
                "overlayRuntime": [],
                "shape": { "memoryGib": null, "cpus": null, "privileged": false, "gpu": false },
            })
        );
    }

    /* The key is DOCKER's (`HostConfig`), not this repo's vocabulary. A sweep once renamed it in a reader and in its fixtures together, and every cap read absent while the suite stayed green; a reader aimed at any other key sees an unbounded, unprivileged container. */
    #[test]
    fn the_share_is_read_under_dockers_own_key_so_a_renamed_one_cannot_pass() {
        let as_docker_emits_it = json!({
            "Name": "/intentic-sandbox-work",
            "HostConfig": { "Memory": 17_179_869_184u64, "NanoCpus": 0, "Privileged": true, "DeviceRequests": null },
            "Config": { "Env": ["SANDBOX_RUNTIME=--privileged"] },
        });
        let resources = resources_from(&as_docker_emits_it, None);
        assert_eq!(resources["memoryBytes"], json!(17_179_869_184u64));
        assert_eq!(resources["privileged"], json!(true));
        let renamed = json!({
            "DeviceConfig": as_docker_emits_it["HostConfig"].clone(),
            "Config": as_docker_emits_it["Config"].clone(),
        });
        assert_eq!(resources_from(&renamed, None)["privileged"], json!(false));
        assert!(resources_from(&renamed, None).get("memoryBytes").is_none());
    }

    #[test]
    fn a_line_that_is_not_one_inspect_object_is_skipped() {
        let inspected = inspected_from("WARNING: something\n{\"Name\":\"/intentic-sandbox-a\"}\n");
        assert_eq!(
            inspected.keys().collect::<Vec<_>>(),
            vec!["intentic-sandbox-a"]
        );
    }
}
