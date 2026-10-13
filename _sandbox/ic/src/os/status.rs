use serde_json::{json, Value};

use super::policy::{self, Policy};
use super::{bootc, Paths};
use crate::util::Result;

/* `ic os status`: where this machine stands, in the one shape every caller reads (_os/README.md). bootc's own document
(`apiVersion: org.containers.bootc/v1`, `kind: BootcHost`) is mapped here and nowhere else, so a change in what bootc
says is one edit and one test, not one per caller. The mapping is a pure function of what was read: release.json, bootc's
status, this boot's health verdict, the policy and whether dockerd has the kata runtime. */

/// `ic os status [--json]`.
pub fn run(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    let paths = Paths::here();
    let release = super::release(&paths)?;
    // A bootc that will not answer (no sudo rule, a wedged daemon) still leaves the rest worth saying: the deployments
    // come out null, as the contract's schema allows for exactly this, and the reason goes to stderr.
    let bootc = bootc::status().unwrap_or_else(|err| {
        crate::ui::warn(&format!(
            "bootc did not answer, so the deployments are left out: {}",
            err.0
        ));
        Value::Null
    });
    let health = super::read_json(&paths.health());
    let status = status_value(
        &release,
        &bootc,
        health.as_ref(),
        &policy::current(),
        policy::kata_available(),
    );
    if json {
        super::emit_json(&status);
    } else {
        show(&status);
    }
    Ok(())
}

/// The status document. `image` is the image this machine follows (bootc's spec, which a channel switch changes before
/// the reboot), else the booted one, else release.json's repository at its channel; `channel` is the booted image's
/// tag, else release.json's. These four are always strings (empty for what nothing says), as the contract's
/// `IntenticOsStatusSchema` reads them. Pure.
pub fn status_value(
    release: &Value,
    bootc: &Value,
    health: Option<&Value>,
    policy: &Policy,
    kata_available: bool,
) -> Value {
    let status = &bootc["status"];
    let booted_ref = status["booted"]["image"]["image"]["image"].as_str();
    let channel = booted_ref
        .and_then(image_tag)
        .or_else(|| release["channel"].as_str())
        .unwrap_or_default();
    let image = bootc["spec"]["image"]["image"]
        .as_str()
        .or(booted_ref)
        .map(str::to_string)
        .or_else(|| {
            release["repository"]
                .as_str()
                .map(|repository| format!("{repository}:{channel}"))
        })
        .unwrap_or_default();
    let staged = deployment(&status["staged"]);
    let rollback_queued = status["rollbackQueued"].as_bool().unwrap_or(false);
    json!({
        "os": "intentic-os",
        "edition": release["edition"].as_str().unwrap_or_default(),
        "version": release["version"].as_str().unwrap_or_default(),
        "channel": channel,
        "image": image,
        "booted": deployment(&status["booted"]),
        "rebootRequired": !staged.is_null() || rollback_queued,
        "staged": staged,
        "rollback": deployment(&status["rollback"]),
        "rollbackQueued": rollback_queued,
        "health": health_of(health),
        "isolation": policy.isolation.word(),
        "vmRuntime": kata_available,
    })
}

/// One of bootc's deployments as `{image, version, digest, timestamp}`, null for each thing bootc does not say; null
/// for no deployment. Pure.
pub fn deployment(entry: &Value) -> Value {
    if !entry.is_object() {
        return Value::Null;
    }
    let image = &entry["image"];
    json!({
        "image": text(&image["image"]["image"]),
        "version": text(&image["version"]),
        "digest": text(&image["imageDigest"]),
        "timestamp": text(&image["timestamp"]),
    })
}

/// The tag of an image reference (`ghcr.io/intentic/os:stable` → `stable`), never a registry's port or a digest. Pure.
pub fn image_tag(reference: &str) -> Option<&str> {
    let named = reference.split('@').next().unwrap_or_default();
    let last = named.rsplit('/').next().unwrap_or_default();
    last.split_once(':')
        .map(|(_, tag)| tag)
        .filter(|tag| !tag.is_empty())
}

/// This boot's verdict as status carries it: `unknown` before `ic os health` wrote one. Pure.
fn health_of(health: Option<&Value>) -> Value {
    let verdict = health
        .and_then(|health| health["verdict"].as_str())
        .filter(|verdict| matches!(*verdict, "green" | "red"));
    match (verdict, health) {
        (Some(verdict), Some(health)) => json!({
            "verdict": verdict,
            "failed": health["failed"]
                .as_array()
                .map(|failed| failed.iter().filter(|check| check.is_string()).cloned().collect::<Vec<_>>())
                .unwrap_or_default(),
        }),
        _ => json!({ "verdict": "unknown", "failed": [] }),
    }
}

/// A string, or null for anything else.
fn text(value: &Value) -> Value {
    value
        .as_str()
        .map(|text| json!(text))
        .unwrap_or(Value::Null)
}

/// The status for a person.
fn show(status: &Value) {
    let word = |value: &Value| value.as_str().unwrap_or("unknown").to_string();
    let deployment = |value: &Value| {
        if value.is_null() {
            return "none".to_string();
        }
        let version = value["version"].as_str().unwrap_or("unversioned");
        match value["image"].as_str() {
            Some(image) => format!("{version} ({image})"),
            None => version.to_string(),
        }
    };
    crate::ui::report(
        &format!("Intentic OS {}", word(&status["edition"])),
        Some(&word(&status["image"])),
    );
    let mut fields = vec![
        ("Version".to_string(), word(&status["version"])),
        ("Channel".to_string(), word(&status["channel"])),
        ("Booted".to_string(), deployment(&status["booted"])),
        ("Staged".to_string(), deployment(&status["staged"])),
        ("Rollback".to_string(), deployment(&status["rollback"])),
    ];
    if status["rollbackQueued"] == true {
        fields.push((
            "Next boot".to_string(),
            "the rollback deployment".to_string(),
        ));
    }
    fields.push((
        "Reboot needed".to_string(),
        if status["rebootRequired"] == true {
            "yes"
        } else {
            "no"
        }
        .to_string(),
    ));
    let failed: Vec<String> = status["health"]["failed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|check| check.as_str().map(str::to_string))
        .collect();
    fields.push((
        "Health".to_string(),
        if failed.is_empty() {
            word(&status["health"]["verdict"])
        } else {
            format!(
                "{} ({})",
                word(&status["health"]["verdict"]),
                failed.join(", ")
            )
        },
    ));
    fields.push((
        "Isolation".to_string(),
        format!(
            "{}{}",
            word(&status["isolation"]),
            if status["vmRuntime"] == true {
                ", kata available"
            } else {
                ", no kata runtime"
            }
        ),
    ));
    crate::ui::fields(&fields);
}

#[cfg(test)]
pub(crate) mod fixture {
    use serde_json::{json, Value};

    /// `bootc status --json` as bootc 1.x prints it on a machine with an update staged and an older deployment to go
    /// back to; the booted deployment has already seen the update (`cachedUpdate`).
    pub fn bootc_status() -> Value {
        json!({
            "apiVersion": "org.containers.bootc/v1",
            "kind": "BootcHost",
            "metadata": { "name": "host" },
            "spec": {
                "bootOrder": "default",
                "image": { "image": "ghcr.io/intentic/os:stable", "transport": "registry", "signature": null }
            },
            "status": {
                "staged": {
                    "image": {
                        "image": { "image": "ghcr.io/intentic/os:stable", "transport": "registry", "signature": null },
                        "version": "2026.10.14.0",
                        "timestamp": "2026-10-14T04:00:12Z",
                        "imageDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                        "architecture": "amd64"
                    },
                    "cachedUpdate": null,
                    "incompatible": false,
                    "pinned": false,
                    "softRebootCapable": false,
                    "downloadOnly": false,
                    "store": "ostreeContainer",
                    "ostree": { "stateroot": "default", "checksum": "9f1c0d4e", "deploySerial": 0 }
                },
                "booted": {
                    "image": {
                        "image": { "image": "ghcr.io/intentic/os:stable", "transport": "registry", "signature": null },
                        "version": "2026.10.13.0",
                        "timestamp": "2026-10-13T09:12:00Z",
                        "imageDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                        "architecture": "amd64"
                    },
                    "cachedUpdate": {
                        "image": { "image": "ghcr.io/intentic/os:stable", "transport": "registry", "signature": null },
                        "version": "2026.10.14.0",
                        "timestamp": "2026-10-14T04:00:12Z",
                        "imageDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                        "architecture": "amd64"
                    },
                    "incompatible": false,
                    "pinned": false,
                    "softRebootCapable": false,
                    "downloadOnly": false,
                    "store": "ostreeContainer",
                    "ostree": { "stateroot": "default", "checksum": "4b7a91c2", "deploySerial": 0 }
                },
                "rollback": {
                    "image": {
                        "image": { "image": "ghcr.io/intentic/os:stable", "transport": "registry", "signature": null },
                        "version": "2026.10.06.0",
                        "timestamp": null,
                        "imageDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                        "architecture": "amd64"
                    },
                    "cachedUpdate": null,
                    "incompatible": false,
                    "pinned": false,
                    "store": "ostreeContainer",
                    "ostree": { "stateroot": "default", "checksum": "77aa01bc", "deploySerial": 0 }
                },
                "rollbackQueued": false,
                "type": "bootcHost"
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::os::policy::Isolation;

    fn release() -> Value {
        json!({ "name": "Intentic OS", "edition": "server", "version": "2026.10.13.0", "channel": "stable", "repository": "ghcr.io/intentic/os" })
    }

    #[test]
    fn bootcs_document_becomes_the_one_shape_every_caller_reads() {
        let health = json!({ "verdict": "green", "failed": [], "at": 1_791_240_330_000u64 });
        let status = status_value(
            &release(),
            &fixture::bootc_status(),
            Some(&health),
            &Policy::default(),
            true,
        );
        assert_eq!(
            status,
            json!({
                "os": "intentic-os",
                "edition": "server",
                "version": "2026.10.13.0",
                "channel": "stable",
                "image": "ghcr.io/intentic/os:stable",
                "booted": {
                    "image": "ghcr.io/intentic/os:stable",
                    "version": "2026.10.13.0",
                    "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                    "timestamp": "2026-10-13T09:12:00Z"
                },
                "staged": {
                    "image": "ghcr.io/intentic/os:stable",
                    "version": "2026.10.14.0",
                    "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                    "timestamp": "2026-10-14T04:00:12Z"
                },
                "rollback": {
                    "image": "ghcr.io/intentic/os:stable",
                    "version": "2026.10.06.0",
                    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                    "timestamp": null
                },
                "rollbackQueued": false,
                "rebootRequired": true,
                "health": { "verdict": "green", "failed": [] },
                "isolation": "auto",
                "vmRuntime": true
            })
        );
    }

    #[test]
    fn nothing_staged_needs_no_reboot_unless_a_rollback_is_queued() {
        let mut bootc = fixture::bootc_status();
        bootc["status"]["staged"] = Value::Null;
        let quiet = status_value(&release(), &bootc, None, &Policy::default(), false);
        assert_eq!(quiet["staged"], Value::Null);
        assert_eq!(quiet["rebootRequired"], json!(false));
        assert_eq!(
            quiet["health"],
            json!({ "verdict": "unknown", "failed": [] })
        );
        assert_eq!(quiet["vmRuntime"], json!(false));
        bootc["status"]["rollbackQueued"] = json!(true);
        let queued = status_value(&release(), &bootc, None, &Policy::default(), false);
        assert_eq!(queued["rollbackQueued"], json!(true));
        assert_eq!(queued["rebootRequired"], json!(true));
    }

    #[test]
    fn the_channel_is_the_booted_tag_and_the_image_is_what_the_machine_follows() {
        // Switched to beta, not yet rebooted: the machine follows beta and still runs stable.
        let mut bootc = fixture::bootc_status();
        bootc["spec"]["image"]["image"] = json!("ghcr.io/intentic/os:beta");
        let switched = status_value(&release(), &bootc, None, &Policy::default(), true);
        assert_eq!(switched["image"], json!("ghcr.io/intentic/os:beta"));
        assert_eq!(switched["channel"], json!("stable"));
        // A booted image named by digest alone has no tag: release.json's channel stands.
        bootc["status"]["booted"]["image"]["image"]["image"] =
            json!("ghcr.io/intentic/os@sha256:1111111111111111111111111111111111111111111111111111111111111111");
        let mut beta = release();
        beta["channel"] = json!("beta");
        assert_eq!(
            status_value(&beta, &bootc, None, &Policy::default(), true)["channel"],
            json!("beta")
        );
    }

    #[test]
    fn what_bootc_does_not_say_is_null_and_a_red_verdict_names_its_checks() {
        let bootc = json!({
            "apiVersion": "org.containers.bootc/v1",
            "kind": "BootcHost",
            "spec": { "image": null },
            "status": { "booted": { "image": null, "cachedUpdate": null }, "staged": null, "rollback": null, "type": null }
        });
        let red =
            json!({ "verdict": "red", "failed": ["sandbox work is not running", 7], "at": 1 });
        let status = status_value(
            &release(),
            &bootc,
            Some(&red),
            &Policy {
                isolation: Isolation::Vm,
                ..Policy::default()
            },
            false,
        );
        assert_eq!(
            status["booted"],
            json!({ "image": null, "version": null, "digest": null, "timestamp": null })
        );
        // Nothing names an image but release.json: its repository at its channel.
        assert_eq!(status["image"], json!("ghcr.io/intentic/os:stable"));
        assert_eq!(status["channel"], json!("stable"));
        let bare = status_value(&json!({}), &bootc, None, &Policy::default(), false);
        for key in ["edition", "version", "channel", "image"] {
            assert_eq!(bare[key], json!(""), "{key}");
        }
        assert_eq!(status["rollbackQueued"], json!(false));
        assert_eq!(
            status["health"],
            json!({ "verdict": "red", "failed": ["sandbox work is not running"] })
        );
        assert_eq!(status["isolation"], json!("vm"));
        // A verdict the file does not spell right is no verdict.
        let odd = json!({ "verdict": "amber", "failed": [] });
        assert_eq!(
            status_value(&release(), &bootc, Some(&odd), &Policy::default(), false)["health"]
                ["verdict"],
            json!("unknown")
        );
    }

    #[test]
    fn a_tag_is_never_a_registry_port_or_a_digest() {
        assert_eq!(image_tag("ghcr.io/intentic/os:stable"), Some("stable"));
        assert_eq!(image_tag("ghcr.io/intentic/os-desktop:beta"), Some("beta"));
        assert_eq!(image_tag("localhost:5000/intentic/os"), None);
        assert_eq!(image_tag("localhost:5000/intentic/os:dev"), Some("dev"));
        assert_eq!(image_tag("ghcr.io/intentic/os@sha256:abc"), None);
        assert_eq!(
            image_tag("ghcr.io/intentic/os:stable@sha256:abc"),
            Some("stable")
        );
        assert_eq!(image_tag("os:"), None);
    }

    /* THE CONTRACT'S OWN EXAMPLES (_shared/sandbox-contract/golden/intentic-os.json, which the TypeScript callers parse
    with IntenticOsStatusSchema): each one, put back into what bootc, release.json, the health file and the policy would
    have said, comes out of the mapping field for field. */
    #[test]
    fn every_status_the_contract_shows_is_what_the_mapping_makes() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../_shared/sandbox-contract/golden/intentic-os.json"
        ))
        .expect("the golden file is JSON");
        let examples = golden["status"].as_array().expect("status examples");
        assert!(!examples.is_empty());
        for example in examples {
            let mut release = golden["release"].clone();
            for key in ["edition", "version", "channel"] {
                release[key] = example[key].clone();
            }
            let as_bootc = |deployment: &Value| -> Value {
                if deployment.is_null() {
                    return Value::Null;
                }
                if deployment.as_object().unwrap().values().all(Value::is_null) {
                    return json!({ "image": null, "cachedUpdate": null, "store": "ostreeContainer" });
                }
                json!({
                    "image": {
                        "image": { "image": deployment["image"], "transport": "registry", "signature": null },
                        "version": deployment["version"],
                        "timestamp": deployment["timestamp"],
                        "imageDigest": deployment["digest"],
                        "architecture": "amd64"
                    },
                    "cachedUpdate": null,
                    "store": "ostreeContainer"
                })
            };
            let bootc = json!({
                "apiVersion": "org.containers.bootc/v1",
                "kind": "BootcHost",
                "spec": { "image": { "image": example["image"], "transport": "registry" } },
                "status": {
                    "booted": as_bootc(&example["booted"]),
                    "staged": as_bootc(&example["staged"]),
                    "rollback": as_bootc(&example["rollback"]),
                    "rollbackQueued": example["rollbackQueued"],
                    "type": "bootcHost"
                }
            });
            let health = (example["health"]["verdict"] != "unknown").then(|| {
                let mut written = example["health"].clone();
                written["at"] = json!(1_791_240_330_000u64);
                written
            });
            let isolation = match example["isolation"].as_str() {
                Some("vm") => Isolation::Vm,
                Some("container") => Isolation::Container,
                _ => Isolation::Auto,
            };
            let made = status_value(
                &release,
                &bootc,
                health.as_ref(),
                &Policy {
                    isolation,
                    ..Policy::default()
                },
                example["vmRuntime"] == true,
            );
            assert_eq!(&made, example);
        }
    }

    #[test]
    fn a_bootc_that_would_not_answer_leaves_the_deployments_null_and_the_rest_said() {
        let status = status_value(&release(), &Value::Null, None, &Policy::default(), true);
        for key in ["booted", "staged", "rollback"] {
            assert_eq!(status[key], Value::Null, "{key}");
        }
        assert_eq!(status["rebootRequired"], json!(false));
        assert_eq!(status["image"], json!("ghcr.io/intentic/os:stable"));
        assert_eq!(status["channel"], json!("stable"));
        assert_eq!(status["edition"], json!("server"));
    }
}
