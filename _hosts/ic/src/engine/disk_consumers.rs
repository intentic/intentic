//! WHAT TAKES THE ENGINE'S DISK, AND WHOSE IT IS (2026-11-03), for `ic engine disk --consumers` and the machine agent's
//! word to the owner when the disk runs short ("sandbox a4ba63bf2aa5's history volume: 462 GB"). Read off one
//! `docker system df -v`, which sizes every volume by walking it: on rog, with one volume of 462 GB of Rust build
//! output and the engine busy, it took a minute one time and had not finished after ten the next. So a measurement is
//! kept in `~/.intentic/engine/disk-consumers.json` and reused while it is younger than the caller's `--max-age`, and
//! `--kept` answers from it however old it is and never measures: the machine agent tells the owner with that at once
//! and measures in the background. The cheap reading every minute never waits on any of it (disk.rs).
//!
//! Whose a thing is comes from what it says about itself: ic's labels (`dev.intentic.sandbox`, labels.rs) and its volume
//! and image families (tidy.rs) name a sandbox, `com.docker.compose.project` names a compose project, and anything else
//! is named by its own name. Images are counted by the space only they hold (Docker's unique size), so a base layer two
//! images share is not counted twice.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::uninstall::parse_docker_size;

/// How long Docker gets to size everything: more than ten minutes on a busy disk of a million files, never forever.
const MEASURE_LIMIT: Duration = Duration::from_secs(30 * 60);
/// How many consumers an answer names: enough to see who is big, few enough to read in one line.
pub const NAMED: usize = 12;

const COMPOSE_PROJECT: &str = "com.docker.compose.project";
const COMPOSE_VOLUME: &str = "com.docker.compose.volume";
const COMPOSE_SERVICE: &str = "com.docker.compose.service";

/// Whose a thing on the disk is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "camelCase")]
pub enum Owner {
    Sandbox(String),
    Runner(String),
    Compose(String),
}

impl Owner {
    /// How a person reads the owner: `sandbox a4ba63bf2aa5`, `compose project shop`. Pure.
    pub fn name(&self) -> String {
        match self {
            Owner::Sandbox(slug) => {
                format!("sandbox {}", slug.strip_prefix("sandbox-").unwrap_or(slug))
            }
            Owner::Runner(slug) => {
                format!("runner {}", slug.strip_prefix("runner-").unwrap_or(slug))
            }
            Owner::Compose(project) => format!("compose project {project}"),
        }
    }
}

/// One thing that takes space: a volume, a sandbox's images, the build cache, a project's containers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Consumer {
    /// `volume`, `images`, `buildCache` or `containers`.
    pub kind: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Owner>,
    /// What it is, as the owner is told it: `sandbox a4ba63bf2aa5's history volume`.
    pub what: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub volumes: u64,
    pub images: u64,
    pub build_cache: u64,
    pub containers: u64,
}

/// One measurement, as kept and as answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakdown {
    /// When Docker measured it, in epoch milliseconds.
    pub at: u64,
    pub consumers: Vec<Consumer>,
    pub totals: Totals,
}

/// Docker's `k=v,k=v` label list as a map. A value holding a comma is cut there, which no label this reads does. Pure.
fn labels_of(text: &str) -> BTreeMap<&str, &str> {
    text.split(',')
        .filter_map(|pair| pair.split_once('='))
        .collect()
}

/// A volume of ic's: the sandbox it belongs to and which of its volumes it is, from its labels or else its name.
fn intentic_volume(name: &str, labels: &BTreeMap<&str, &str>) -> Option<(Owner, &'static str)> {
    const FAMILIES: [(&str, &str, &str); 4] = [
        (
            "intentic-workspace-",
            "volume-workspace",
            "workspace volume",
        ),
        ("intentic-history-", "volume-history", "history volume"),
        (
            "intentic-dind-docker-",
            "volume-dind-docker",
            "deploy target's Docker volume",
        ),
        ("intentic-docker-", "volume-docker", "Docker volume"),
    ];
    let labelled = labels.get(crate::sandbox::labels::SANDBOX).copied();
    let kind = labels.get(crate::sandbox::labels::KIND).copied();
    FAMILIES.iter().find_map(|(prefix, wire, what)| {
        let slug = labelled
            .filter(|_| kind == Some(*wire))
            .or_else(|| name.strip_prefix(prefix))
            .filter(|slug| !slug.is_empty())?;
        let owner = if slug.starts_with("runner-") {
            Owner::Runner(slug.to_string())
        } else {
            Owner::Sandbox(slug.to_string())
        };
        Some((owner, *what))
    })
}

/// A volume as a consumer: ic's, a compose project's, or named by itself. Pure.
pub fn volume(name: &str, labels: &str, bytes: u64) -> Consumer {
    let labels = labels_of(labels);
    let (owner, what) = if let Some((owner, which)) = intentic_volume(name, &labels) {
        let what = format!("{}'s {which}", owner.name());
        (Some(owner), what)
    } else if let Some(project) = labels.get(COMPOSE_PROJECT) {
        let owner = Owner::Compose(project.to_string());
        let short = labels.get(COMPOSE_VOLUME).copied().unwrap_or(name);
        let what = format!("{}'s volume {short}", owner.name());
        (Some(owner), what)
    } else if name.len() == 64 && name.chars().all(|c| c.is_ascii_hexdigit()) {
        (None, format!("an unnamed volume ({})", &name[..12]))
    } else {
        (None, format!("volume {name}"))
    };
    Consumer {
        kind: "volume".to_string(),
        bytes,
        owner,
        what,
    }
}

/// Whose an image is: a sandbox's rollback pin or environment build (tidy.rs `owner_of`), or nobody's in particular.
fn image_owner(repository: &str, tag: &str) -> Option<Owner> {
    let (slug, _) = crate::sandbox::tidy::owner_of(&format!("{repository}:{tag}"))?;
    Some(Owner::Sandbox(slug))
}

/// A container's owner: its compose project, ic's label, or its name (`intentic-sandbox-<slug>`).
fn container_owner(names: &str, labels: &BTreeMap<&str, &str>) -> Option<Owner> {
    if let Some(project) = labels.get(COMPOSE_PROJECT) {
        return Some(Owner::Compose(project.to_string()));
    }
    let slug = labels
        .get(crate::sandbox::labels::SANDBOX)
        .map(|slug| slug.to_string())
        .or_else(|| {
            names
                .split(',')
                .find_map(|name| {
                    name.trim_start_matches('/')
                        .strip_prefix(crate::sandbox::CONTAINER_PREFIX)
                })
                .map(str::to_string)
        })?;
    Some(if slug.starts_with("runner-") {
        Owner::Runner(slug)
    } else {
        Owner::Sandbox(slug)
    })
}

/// A size as `docker system df -v` prints it (`462GB`, `1.2GB (virtual 9GB)`, `N/A`). Pure.
fn size(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    parse_docker_size(text.split('(').next().unwrap_or(text))
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// Add `bytes` to the consumer `key` names, making it with `make` the first time.
fn add(
    groups: &mut BTreeMap<String, Consumer>,
    key: String,
    bytes: u64,
    make: impl FnOnce() -> Consumer,
) {
    groups.entry(key).or_insert_with(make).bytes += bytes;
}

/// Everything `docker system df -v --format '{{json .}}'` printed, as consumers biggest first and the four totals. Pure.
pub fn from_system_df(said: &str, at: u64) -> Option<Breakdown> {
    let whole: Value = serde_json::from_str(said.trim()).ok()?;
    let rows = |key: &str| whole[key].as_array().cloned().unwrap_or_default();
    let mut totals = Totals::default();
    let mut consumers = Vec::new();
    for row in rows("Volumes") {
        let bytes = size(&row["Size"]).unwrap_or(0);
        totals.volumes += bytes;
        consumers.push(volume(text(&row, "Name"), text(&row, "Labels"), bytes));
    }
    let mut grouped: BTreeMap<String, Consumer> = BTreeMap::new();
    for row in rows("Images") {
        // Unique where Docker could say it, the whole image where it could not.
        let bytes = size(&row["UniqueSize"])
            .or_else(|| size(&row["Size"]))
            .unwrap_or(0);
        totals.images += bytes;
        let (repository, tag) = (text(&row, "Repository"), text(&row, "Tag"));
        match image_owner(repository, tag) {
            Some(owner) => add(&mut grouped, format!("images {owner:?}"), bytes, || {
                Consumer {
                    kind: "images".to_string(),
                    bytes: 0,
                    what: format!("{}'s images", owner.name()),
                    owner: Some(owner),
                }
            }),
            None if repository == "<none>" => {
                add(&mut grouped, "images dangling".to_string(), bytes, || {
                    Consumer {
                        kind: "images".to_string(),
                        bytes: 0,
                        owner: None,
                        what: "dangling images".to_string(),
                    }
                })
            }
            None => add(
                &mut grouped,
                format!("image {repository}:{tag}"),
                bytes,
                || Consumer {
                    kind: "images".to_string(),
                    bytes: 0,
                    owner: None,
                    what: format!("image {repository}:{tag}"),
                },
            ),
        }
    }
    for row in rows("Containers") {
        let bytes = size(&row["Size"]).unwrap_or(0);
        totals.containers += bytes;
        let labels = labels_of(text(&row, "Labels"));
        let names = text(&row, "Names");
        match container_owner(names, &labels) {
            Some(owner) => add(&mut grouped, format!("containers {owner:?}"), bytes, || {
                Consumer {
                    kind: "containers".to_string(),
                    bytes: 0,
                    what: format!(
                        "{}'s container{}",
                        owner.name(),
                        if matches!(owner, Owner::Compose(_)) {
                            "s"
                        } else {
                            ""
                        }
                    ),
                    owner: Some(owner),
                }
            }),
            None => add(&mut grouped, format!("container {names}"), bytes, || {
                Consumer {
                    kind: "containers".to_string(),
                    bytes: 0,
                    owner: None,
                    what: format!(
                        "container {}{}",
                        names,
                        labels
                            .get(COMPOSE_SERVICE)
                            .map(|service| format!(" ({service})"))
                            .unwrap_or_default()
                    ),
                }
            }),
        }
    }
    totals.build_cache = rows("BuildCache")
        .iter()
        .filter_map(|row| size(&row["Size"]))
        .sum();
    if totals.build_cache > 0 {
        consumers.push(Consumer {
            kind: "buildCache".to_string(),
            bytes: totals.build_cache,
            owner: None,
            what: "the build cache".to_string(),
        });
    }
    consumers.extend(grouped.into_values());
    consumers.retain(|consumer| consumer.bytes > 0);
    consumers.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.what.cmp(&b.what)));
    consumers.truncate(NAMED);
    Some(Breakdown {
        at,
        consumers,
        totals,
    })
}

/// A kept measurement young enough for `max_age_minutes`, against `now`. Pure.
pub fn fresh(kept: &Breakdown, now: u64, max_age_minutes: u64) -> bool {
    kept.at <= now && now - kept.at <= max_age_minutes.saturating_mul(60_000)
}

/// What takes the space: the kept measurement while it is young enough (or at any age, `kept_only`, which never
/// measures), else Docker's, measured now and kept.
pub fn current(max_age_minutes: u64, kept_only: bool) -> std::result::Result<Breakdown, String> {
    let now = crate::sandbox::now_ms();
    let path = super::paths::disk_consumers_path();
    let kept = path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Breakdown>(&text).ok());
    if kept_only {
        return kept.ok_or_else(|| "nothing has measured it on this PC yet".to_string());
    }
    if let Some(kept) = kept.filter(|kept| fresh(kept, now, max_age_minutes)) {
        return Ok(kept);
    }
    let ran = crate::docker::capture_bounded(
        &["system", "df", "-v", "--format", "{{json .}}"],
        MEASURE_LIMIT,
    )
    .map_err(|fail| fail.0)?;
    if ran.timed_out {
        return Err(format!(
            "Docker did not finish sizing the disk within {} minutes",
            MEASURE_LIMIT.as_secs() / 60
        ));
    }
    if ran.code != Some(0) {
        return Err(format!(
            "docker system df: {}",
            ran.stderr.lines().last().unwrap_or("no reason given")
        ));
    }
    let breakdown = from_system_df(&ran.stdout, crate::sandbox::now_ms())
        .ok_or_else(|| "docker system df answered something ic cannot read".to_string())?;
    if let Some(path) = path {
        keep(&path, &breakdown);
    }
    Ok(breakdown)
}

/// Written whole beside it and renamed over it, so a reader never sees half of one; a failure only costs the next
/// caller a measurement.
fn keep(path: &std::path::Path, breakdown: &Breakdown) {
    let Ok(text) = serde_json::to_string(breakdown) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = super::paths::ensure_dir(parent);
    }
    let staged = path.with_extension("json.new");
    if std::fs::write(&staged, text).is_ok() {
        let _ = std::fs::rename(&staged, path);
    }
}

/// The breakdown in the `--json` answer, or why there is none. Pure.
pub fn breakdown_json(breakdown: &std::result::Result<Breakdown, String>) -> Value {
    match breakdown {
        Ok(breakdown) => json!({
            "consumers": breakdown.consumers,
            "totals": breakdown.totals,
            "consumersAt": breakdown.at,
        }),
        Err(why) => json!({ "consumersUnread": why }),
    }
}

pub fn print_human(breakdown: &Breakdown) {
    use crate::ui::{self, Item, Tone};
    ui::section("What takes the space");
    let items: Vec<Item> = breakdown
        .consumers
        .iter()
        .map(|consumer| {
            Item::new(
                Tone::Ok,
                consumer.what.clone(),
                super::disk::human(consumer.bytes),
            )
        })
        .collect();
    ui::items(&items);
    let totals = &breakdown.totals;
    ui::fields(&[(
        "In all".to_string(),
        format!(
            "volumes {}, images {}, build cache {}, containers {}",
            super::disk::human(totals.volumes),
            super::disk::human(totals.images),
            super::disk::human(totals.build_cache),
            super::disk::human(totals.containers)
        ),
    )]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_volume_is_named_by_the_sandbox_or_project_it_belongs_to() {
        assert_eq!(
            volume("intentic-history-sandbox-a4ba63bf2aa5", "", 462_000_000_000),
            Consumer {
                kind: "volume".to_string(),
                bytes: 462_000_000_000,
                owner: Some(Owner::Sandbox("sandbox-a4ba63bf2aa5".to_string())),
                what: "sandbox a4ba63bf2aa5's history volume".to_string(),
            }
        );
        // The dind family is told apart from the docker one it starts like.
        assert_eq!(
            volume("intentic-dind-docker-dev", "", 1).what,
            "sandbox dev's deploy target's Docker volume"
        );
        assert_eq!(
            volume("intentic-docker-sandbox-6a4ac5492592", "", 1).what,
            "sandbox 6a4ac5492592's Docker volume"
        );
        assert_eq!(
            volume("intentic-workspace-runner-abc", "", 1).owner,
            Some(Owner::Runner("runner-abc".to_string()))
        );
        // ic's labels name the sandbox even where the name would not.
        assert_eq!(
            volume(
                "data",
                "dev.intentic.sandbox=sandbox-82789f4106b4,dev.intentic.kind=volume-history",
                1
            )
            .what,
            "sandbox 82789f4106b4's history volume"
        );
        let postgres = volume(
            "00-canonical-repo_pgdata",
            "com.docker.compose.project=00-canonical-repo,com.docker.compose.version=2.40.0,com.docker.compose.volume=pgdata",
            3_000_000_000,
        );
        assert_eq!(
            postgres.owner,
            Some(Owner::Compose("00-canonical-repo".to_string()))
        );
        assert_eq!(
            postgres.what,
            "compose project 00-canonical-repo's volume pgdata"
        );
        assert_eq!(
            volume(&"ab".repeat(32), "", 1).what,
            "an unnamed volume (abababababab)"
        );
        assert_eq!(volume("mine", "", 1).what, "volume mine");
    }

    /// What `docker system df -v --format '{{json .}}'` prints, cut down to one of each kind of thing.
    const SYSTEM_DF: &str = r#"{
        "Images": [
            {"Repository":"intentic-sandbox-rollback-sandbox-a4ba63bf2aa5","Tag":"9d7fad203971","Size":"8.09GB","SharedSize":"7GB","UniqueSize":"1.09GB"},
            {"Repository":"intentic-sandbox-env-sandbox-a4ba63bf2aa5","Tag":"5479fba670d4","Size":"10.3GB","SharedSize":"7GB","UniqueSize":"3.3GB"},
            {"Repository":"postgres","Tag":"17-alpine","Size":"424MB","SharedSize":"0B","UniqueSize":"424MB"},
            {"Repository":"<none>","Tag":"<none>","Size":"2GB","SharedSize":"N/A","UniqueSize":"N/A"}
        ],
        "Containers": [
            {"Names":"intentic-sandbox-sandbox-a4ba63bf2aa5","Labels":"dev.intentic.kind=sandbox","Size":"1.5GB (virtual 11.8GB)"},
            {"Names":"00-canonical-repo-postgres-1","Labels":"com.docker.compose.project=00-canonical-repo,com.docker.compose.service=postgres","Size":"63B (virtual 424MB)"},
            {"Names":"scratch","Labels":"","Size":"0B"}
        ],
        "Volumes": [
            {"Name":"intentic-history-sandbox-a4ba63bf2aa5","Labels":"","Size":"462GB"},
            {"Name":"00-canonical-repo_pgdata","Labels":"com.docker.compose.project=00-canonical-repo,com.docker.compose.volume=pgdata","Size":"3GB"},
            {"Name":"remote","Labels":"","Size":"N/A"}
        ],
        "BuildCache": [
            {"ID":"blw88m371bnv","Shared":"true","Size":"11.19GB"},
            {"ID":"x2","Shared":"false","Size":"77.4GB"}
        ]
    }"#;

    #[test]
    fn the_breakdown_names_the_biggest_first_with_images_counted_by_what_only_they_hold() {
        let breakdown = from_system_df(SYSTEM_DF, 42).expect("docker's answer reads");
        let named: Vec<(&str, u64)> = breakdown
            .consumers
            .iter()
            .map(|consumer| (consumer.what.as_str(), consumer.bytes))
            .collect();
        assert_eq!(
            named,
            vec![
                ("sandbox a4ba63bf2aa5's history volume", 462_000_000_000),
                ("the build cache", 88_590_000_000),
                ("sandbox a4ba63bf2aa5's images", 4_390_000_000),
                (
                    "compose project 00-canonical-repo's volume pgdata",
                    3_000_000_000
                ),
                ("dangling images", 2_000_000_000),
                ("sandbox a4ba63bf2aa5's container", 1_500_000_000),
                ("image postgres:17-alpine", 424_000_000),
                ("compose project 00-canonical-repo's containers", 63),
            ]
        );
        assert_eq!(
            breakdown.totals,
            Totals {
                volumes: 465_000_000_000,
                images: 6_814_000_000,
                build_cache: 88_590_000_000,
                containers: 1_500_000_063
            }
        );
        assert_eq!(breakdown.at, 42);
        assert_eq!(from_system_df("not json", 0), None);
    }

    #[test]
    fn a_kept_measurement_is_used_while_it_is_young_enough() {
        let kept = Breakdown {
            at: 1_000_000,
            consumers: Vec::new(),
            totals: Totals::default(),
        };
        assert!(fresh(&kept, 1_000_000 + 60 * 60_000, 60));
        assert!(!fresh(&kept, 1_000_000 + 60 * 60_000 + 1, 60));
        // A clock set back makes it no younger.
        assert!(!fresh(&kept, 999_999, 60));
    }

    #[test]
    fn the_json_answer_carries_the_consumers_or_why_there_are_none() {
        let breakdown = from_system_df(SYSTEM_DF, 42).expect("docker's answer reads");
        let answer = breakdown_json(&Ok(breakdown));
        assert_eq!(
            answer["consumers"][0],
            json!({
                "kind": "volume",
                "bytes": 462_000_000_000u64,
                "owner": { "kind": "sandbox", "id": "sandbox-a4ba63bf2aa5" },
                "what": "sandbox a4ba63bf2aa5's history volume",
            })
        );
        assert_eq!(answer["totals"]["buildCache"], 88_590_000_000u64);
        assert_eq!(answer["consumersAt"], 42);
        assert_eq!(
            breakdown_json(&Err("slow".into())),
            json!({ "consumersUnread": "slow" })
        );
    }
}
