use serde_json::{json, Value};

use crate::docker;
use crate::sandbox::inside::{self, Read};
use crate::sandbox::{container_of, parked_of};

/* WHICH SIDE OF THIS COMPUTER KEEPS A SANDBOX. On Windows, ic on Windows and ic inside each WSL distro all drive Docker
Desktop's one engine, so each sees every sandbox container on it, and each side's machine agent runs the same
background rounds over all of them: two keepers restarting one sandbox, two probation watches judging one swap, two
tidies each deleting the rollback images the other side's record names and its own does not. A sandbox's container
carries the side whose ic created it, and that side alone keeps it: the unattended verbs below leave the other side's
sandboxes alone, and `ic sandbox list` says which they are, so a machine agent need not even ask. A person's own
command still reaches every sandbox.

A side is a platform and an environment. HOST_PLATFORM says `windows` or `linux` (connect.rs), which is all the
sandbox's own OS card needs, and on a PC with two WSL distros both say `linux`; HOST_ENV beside it names the
environment: `windows`, the distro's own name inside WSL, `linux` or `macos` elsewhere. (2026-10-05) A container from
before HOST_ENV is compared on its platform alone, so nothing that kept a sandbox before stops keeping it now; one from
before HOST_PLATFORM names no side at all and stays everyone's until its next recreate stamps it (recreate.rs). */

/// One side of this computer: the platform its ic says (`windows`, `linux`) and, where it is known, the environment.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Side {
    pub platform: String,
    pub env: Option<String>,
}

impl Side {
    pub fn new(platform: &str, env: Option<&str>) -> Side {
        Side {
            platform: platform.to_string(),
            env: env.filter(|env| !env.is_empty()).map(str::to_string),
        }
    }

    /// How a side is written where a program reads it (labels, keptElsewhere): `windows`, `linux/archlinux`, or the
    /// platform alone when the environment is unknown. Pure.
    pub fn wire(&self) -> String {
        match &self.env {
            Some(env) if !env.eq_ignore_ascii_case(&self.platform) => {
                format!("{}/{env}", self.platform)
            }
            _ => self.platform.clone(),
        }
    }

    /// The wire form read back. Pure.
    pub fn parse(wire: &str) -> Option<Side> {
        let wire = wire.trim();
        if wire.is_empty() {
            return None;
        }
        Some(match wire.split_once('/') {
            Some((platform, env)) => Side::new(platform, Some(env)),
            None => Side::new(wire, None),
        })
    }

    /// Whether two readings name the same side: the platforms agree, and so do the environments where both name one.
    /// Pure.
    pub fn same(&self, other: &Side) -> bool {
        self.platform.eq_ignore_ascii_case(&other.platform)
            && match (&self.env, &other.env) {
                (Some(mine), Some(theirs)) => mine.eq_ignore_ascii_case(theirs),
                _ => true,
            }
    }

    /// How a side is called where a person reads it: "Windows", "WSL (archlinux)". Pure.
    pub fn name(&self) -> String {
        let env = self.env.as_deref();
        match (self.platform.as_str(), env) {
            ("windows", _) => "Windows".to_string(),
            (_, Some("macos")) => "macOS".to_string(),
            ("linux", Some("linux")) => "Linux".to_string(),
            ("linux", Some(distro)) => format!("WSL ({distro})"),
            ("linux", None) => "WSL or Linux".to_string(),
            (other, Some(env)) if !env.eq_ignore_ascii_case(other) => format!("{other} ({env})"),
            (other, _) => other.to_string(),
        }
    }
}

/// This ic's side, as connect.rs stamps it on the containers it creates.
pub fn here() -> Side {
    Side {
        platform: crate::sandbox::connect::host_platform().to_string(),
        env: crate::sandbox::connect::host_env(),
    }
}

/// The side to leave a sandbox to: the one that created it, when that is not `here`. Pure.
pub fn elsewhere(created: Option<&Side>, here: &Side) -> Option<Side> {
    created.filter(|created| !created.same(here)).cloned()
}

/// The side named by a container's `NAME=value` env pairs: HOST_PLATFORM, with HOST_ENV beside it when it is there.
/// Pure.
pub fn side_in<'a>(pairs: impl Iterator<Item = &'a str> + Clone) -> Option<Side> {
    let value = |name: &str| {
        pairs
            .clone()
            .find_map(|pair| {
                pair.strip_prefix(name)
                    .and_then(|rest| rest.strip_prefix('='))
            })
            .filter(|value| !value.is_empty())
    };
    let platform = value("HOST_PLATFORM")?;
    Some(Side::new(platform, value("HOST_ENV")))
}

/// The side whose ic created the sandbox, off its container's env (or the parked one's, mid-swap); None when neither
/// says or docker does not answer.
pub fn created_on(slug: &str) -> Option<Side> {
    [container_of(slug), parked_of(slug)]
        .iter()
        .find_map(|container| match stamp_of(container) {
            Stamp::Side(side) => Some(side),
            _ => None,
        })
}

/// The other side that keeps this sandbox, when one does. A docker that does not answer reads as "not elsewhere"
/// here, which is right for the verbs that only start, back up or watch; a verb that DELETES asks `keeper` instead.
pub fn kept_elsewhere(slug: &str) -> Option<Side> {
    elsewhere(created_on(slug).as_ref(), &here())
}

/// Who keeps a sandbox, for a verb that deletes on the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Keeper {
    /// This side, or nobody in particular (a container from before HOST_PLATFORM, or none at all): ours to act on.
    Here,
    /// Another side of this computer.
    Elsewhere(Side),
    /// Docker would not say: never a licence to delete.
    Unknown,
}

/// What one container says about its side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stamp {
    Side(Side),
    Unstamped,
    Absent,
    Unreadable,
}

/// The side stamp off a container's env, told apart from a container that is not there and a docker that did not
/// answer: the last of these is the one a deleting verb must not read as "ours".
fn stamp_of(container: &str) -> Stamp {
    match docker::container_env_nul(container) {
        Ok(env) => stamp_in(&env),
        Err(err) if no_such_container(&err.0) => Stamp::Absent,
        Err(_) => Stamp::Unreadable,
    }
}

/// The stamp in a NUL-separated env. Pure.
pub fn stamp_in(env: &[u8]) -> Stamp {
    let text = String::from_utf8_lossy(env);
    side_in(text.split('\0')).map_or(Stamp::Unstamped, Stamp::Side)
}

/// Docker's own words for a name it holds no container under. Pure.
pub fn no_such_container(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no such container") || lower.contains("no such object")
}

/// Who keeps a sandbox, from what its live and parked containers say. A side named by either wins; otherwise one that
/// could not be read makes the answer Unknown; otherwise (unstamped or absent) the sandbox is everyone's. Pure.
pub fn keeper_from(stamps: &[Stamp], here: &Side) -> Keeper {
    if let Some(side) = stamps.iter().find_map(|stamp| match stamp {
        Stamp::Side(side) => Some(side),
        _ => None,
    }) {
        return elsewhere(Some(side), here).map_or(Keeper::Here, Keeper::Elsewhere);
    }
    if stamps.contains(&Stamp::Unreadable) {
        return Keeper::Unknown;
    }
    Keeper::Here
}

/// Who keeps this sandbox, asked of docker; for verbs that delete (tidy).
pub fn keeper(slug: &str) -> Keeper {
    let stamps = [stamp_of(&container_of(slug)), stamp_of(&parked_of(slug))];
    keeper_from(&stamps, &here())
}

/// The side named off a container's `docker inspect` object, for a listing that already holds one. Pure.
pub fn created_on_inspected(inspected: &Value) -> Option<Side> {
    let env = inspected["Config"]["Env"].as_array()?;
    side_in(env.iter().filter_map(Value::as_str))
}

/// What an unattended run says about a sandbox it left to the other side. Pure.
pub fn sentence(side: &Side) -> String {
    format!(
        "left alone: ic on {} created it, and the machine agent there keeps it.",
        side.name()
    )
}

/* OWNERSHIP IS A LEASE, NOT A FACT (the audit's rule 2, 2026-10). The stamp says which side keeps a sandbox, and that
side's keeper says, every time it looks after it, that it still does: `/history/.ic/keeper.json` on the sandbox's own
volume, which every side reads the way it reads the work signal. When the keeping side falls silent (its distro is
gone, its agent stopped, it never ran an ic that writes the file) another side ADOPTS the sandbox for the run it is
in: it acts, and says so. The stamp is not changed by an adoption, so the keeper takes its sandbox back the moment it
speaks again; only a recreate restamps (recreate.rs). (2026-10-05) A missing file counts as silence: a keeper that
never wrote one is either gone or on an ic from before the lease, and both are what adoption is for. */

/// Where the keeper's heartbeat lives on the volume.
pub const KEEPER_FILE: &str = "/history/.ic/keeper.json";

/// How long a keeper may go without saying so before another side adopts its sandbox: the keeper looks every five
/// minutes, so this is several of its sweeps missed in a row.
pub const SILENT_AFTER_MS: u64 = 30 * 60_000;

/// The heartbeat a keeper writes, the moment of writing left as the placeholder `inside` fills in. Pure.
pub fn beat_body(side: &Side, machine_id: Option<&str>) -> Value {
    json!({
        "side": side.platform,
        "env": side.env,
        "machineId": machine_id,
        "at": inside::NOW,
    })
}

/// A heartbeat read back: whose it is, and when it was written (the container's clock). Pure.
pub fn beat_of(value: &Value) -> Option<(Side, u64)> {
    let platform = value["side"].as_str().filter(|side| !side.is_empty())?;
    let at = value["at"].as_u64()?;
    Some((Side::new(platform, value["env"].as_str()), at))
}

/// This machine's id, when its machine agent has one (`~/.intentic/machine/machine-id`).
pub fn machine_id() -> Option<String> {
    std::fs::read_to_string(
        crate::logfile::intentic_home()
            .join("machine")
            .join("machine-id"),
    )
    .ok()
    .map(|id| id.trim().to_string())
    .filter(|id| !id.is_empty())
}

/// Say, on the sandbox's volume, that this side keeps it. Returns the moment written, or None when it could not be.
pub fn beat(slug: &str) -> Option<u64> {
    let holder = inside::holder(slug)?;
    inside::write_stamped(
        &holder,
        KEEPER_FILE,
        &beat_body(&here(), machine_id().as_deref()),
    )
}

/// What the keeper's heartbeat says about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Heard {
    /// It spoke within the limit.
    Fresh,
    /// It has not: since its last heartbeat, or never (None).
    Silent { since: Option<u64> },
    /// The heartbeat could not be read, or says something this ic does not understand: never a reason to adopt.
    Unknown,
}

/// The keeper's state, from its heartbeat file as read and the clock it was written on. A heartbeat another side wrote
/// is not the keeper's, and a keeper that never wrote one has been silent all along. Pure.
pub fn heard(read: &Read, keeper: &Side, now: u64) -> Heard {
    match read {
        Read::Missing => Heard::Silent { since: None },
        Read::Unreadable(_) => Heard::Unknown,
        Read::Found(value) => match beat_of(value) {
            None => Heard::Unknown,
            Some((side, _)) if !side.same(keeper) => Heard::Silent { since: None },
            Some((_, at)) if now.saturating_sub(at) > SILENT_AFTER_MS => {
                Heard::Silent { since: Some(at) }
            }
            Some(_) => Heard::Fresh,
        },
    }
}

/// This side acting, for one run, on a sandbox another side keeps and has stopped looking after.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adoption {
    pub from: Side,
    /// The keeper's last heartbeat; None when it never wrote one.
    pub since: Option<u64>,
}

impl Adoption {
    /// The line every unattended verb prints, and the `adopted` value its JSON carries. Pure.
    pub fn sentence(&self) -> String {
        match self.since {
            Some(at) => format!(
                "adopted: the side that keeps it ({}) has been silent since {}.",
                self.from.name(),
                crate::util::utc_minute(at)
            ),
            None => format!(
                "adopted: the side that keeps it ({}) has never said it does.",
                self.from.name()
            ),
        }
    }

    /// The same, for a `--json` reader. Pure.
    pub fn json(&self) -> Value {
        json!({ "from": self.from.wire(), "silentSince": self.since, "said": self.sentence() })
    }
}

/// Whether an unattended verb acts on a sandbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unattended {
    /// This side keeps it, or nobody in particular does.
    Ours,
    /// Another side keeps it and is looking after it.
    Theirs(Side),
    /// Another side keeps it and has fallen silent: this run acts on it.
    Adopted(Adoption),
}

/// Ask the keeper's heartbeat whether the side that keeps this sandbox still looks after it. None (leave it) while it
/// does, when it cannot be told, or when there is no container to read or act on.
pub fn lease(slug: &str, keeper: &Side) -> Option<Adoption> {
    let holder = inside::holder(slug)?;
    let read = inside::read(&holder, KEEPER_FILE);
    let now = match &read {
        Read::Found(_) => inside::now_for(&holder),
        _ => crate::sandbox::now_ms(),
    };
    match heard(&read, keeper, now) {
        Heard::Silent { since } => Some(Adoption {
            from: keeper.clone(),
            since,
        }),
        Heard::Fresh | Heard::Unknown => None,
    }
}

/// Whether an unattended verb acts on this sandbox: what every one of them (fix --auto, prepare --auto, backup --auto,
/// the watch sweep, tidy) asks first.
pub fn unattended(slug: &str) -> Unattended {
    let Some(keeper) = kept_elsewhere(slug) else {
        return Unattended::Ours;
    };
    match lease(slug, &keeper) {
        Some(adoption) => Unattended::Adopted(adoption),
        None => Unattended::Theirs(keeper),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(wire: &str) -> Side {
        Side::parse(wire).expect("a side")
    }

    #[test]
    fn a_deleting_verb_reads_a_docker_that_did_not_answer_as_unknown_never_as_ours() {
        let windows = side("windows");
        let stamp = |s: &str| Stamp::Side(side(s));
        assert_eq!(
            keeper_from(&[stamp("windows"), Stamp::Absent], &windows),
            Keeper::Here
        );
        assert_eq!(
            keeper_from(&[stamp("linux"), Stamp::Unreadable], &windows),
            Keeper::Elsewhere(side("linux")),
            "a side either container names is the answer"
        );
        assert_eq!(
            keeper_from(&[Stamp::Unreadable, Stamp::Absent], &windows),
            Keeper::Unknown
        );
        assert_eq!(
            keeper_from(&[Stamp::Absent, Stamp::Unreadable], &side("linux")),
            Keeper::Unknown
        );
        assert_eq!(
            keeper_from(&[Stamp::Unstamped, Stamp::Absent], &windows),
            Keeper::Here,
            "a container from before HOST_PLATFORM is everyone's"
        );
        assert_eq!(
            keeper_from(&[Stamp::Absent, Stamp::Absent], &windows),
            Keeper::Here
        );
        assert_eq!(
            keeper_from(&[stamp("linux/ubuntu")], &side("linux/archlinux")),
            Keeper::Elsewhere(side("linux/ubuntu")),
            "two distros are two sides"
        );
    }

    #[test]
    fn the_stamp_is_read_off_a_nul_separated_env() {
        assert_eq!(
            stamp_in(b"PATH=/bin\0HOST_PLATFORM=linux\0"),
            Stamp::Side(side("linux"))
        );
        assert_eq!(
            stamp_in(b"HOST_ENV=archlinux\0PATH=/bin\0HOST_PLATFORM=linux\0"),
            Stamp::Side(side("linux/archlinux"))
        );
        assert_eq!(stamp_in(b"PATH=/bin\0HOST_PLATFORM=\0"), Stamp::Unstamped);
        assert_eq!(
            stamp_in(b"HOST_ENV=archlinux\0"),
            Stamp::Unstamped,
            "an environment with no platform is no stamp"
        );
        assert_eq!(stamp_in(b""), Stamp::Unstamped);
        assert!(no_such_container(
            "Error: No such container: intentic-sandbox-x"
        ));
        assert!(no_such_container(
            "Error response from daemon: No such object: x"
        ));
        assert!(!no_such_container(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
        ));
    }

    #[test]
    fn a_sandbox_is_left_to_the_side_that_created_it() {
        let (windows, linux) = (side("windows"), side("linux"));
        assert_eq!(elsewhere(Some(&linux), &windows), Some(linux.clone()));
        assert_eq!(elsewhere(Some(&windows), &linux), Some(windows.clone()));
        assert_eq!(elsewhere(Some(&linux), &linux), None);
        assert_eq!(elsewhere(Some(&side("Windows")), &windows), None);
        assert_eq!(
            elsewhere(None, &windows),
            None,
            "a container from before HOST_PLATFORM is everyone's"
        );
        // Two distros on one PC: their environments tell them apart.
        let (arch, ubuntu) = (side("linux/archlinux"), side("linux/Ubuntu"));
        assert_eq!(elsewhere(Some(&ubuntu), &arch), Some(ubuntu.clone()));
        assert_eq!(elsewhere(Some(&side("linux/ubuntu")), &ubuntu), None);
        // A container from before HOST_ENV is compared on its platform alone, so its keeper keeps it.
        assert_eq!(elsewhere(Some(&linux), &arch), None);
        assert_eq!(elsewhere(Some(&arch), &linux), None);
        assert_eq!(elsewhere(Some(&arch), &windows), Some(arch));
    }

    #[test]
    fn the_side_is_read_off_an_inspected_container() {
        let inspected = serde_json::json!({ "Config": { "Env": ["PATH=/bin", "HOST_PLATFORM=linux", "HOST_LABEL=rog", "HOST_ENV=archlinux"] } });
        assert_eq!(
            created_on_inspected(&inspected),
            Some(side("linux/archlinux"))
        );
        let platform_only = serde_json::json!({ "Config": { "Env": ["HOST_PLATFORM=windows"] } });
        assert_eq!(created_on_inspected(&platform_only), Some(side("windows")));
        let older = serde_json::json!({ "Config": { "Env": ["PATH=/bin"] } });
        assert_eq!(created_on_inspected(&older), None);
        assert_eq!(created_on_inspected(&serde_json::json!({})), None);
    }

    #[test]
    fn a_side_is_written_for_programs_and_named_for_people() {
        assert_eq!(side("linux/archlinux").wire(), "linux/archlinux");
        assert_eq!(Side::new("windows", Some("windows")).wire(), "windows");
        assert_eq!(Side::new("linux", None).wire(), "linux");
        assert_eq!(Side::parse(""), None);
        assert_eq!(side("linux/archlinux").name(), "WSL (archlinux)");
        assert_eq!(side("windows").name(), "Windows");
        assert_eq!(Side::new("linux", Some("linux")).name(), "Linux");
        assert_eq!(Side::new("linux", Some("macos")).name(), "macOS");
        assert_eq!(side("linux").name(), "WSL or Linux");
    }

    #[test]
    fn what_is_said_names_the_side_as_a_person_knows_it() {
        assert_eq!(
            sentence(&side("linux")),
            "left alone: ic on WSL or Linux created it, and the machine agent there keeps it."
        );
        assert!(sentence(&side("windows")).contains("ic on Windows"));
        assert!(sentence(&side("linux/archlinux")).contains("ic on WSL (archlinux)"));
    }

    #[test]
    fn a_keeper_that_falls_silent_is_adopted_and_one_that_cannot_be_heard_is_not() {
        const MIN: u64 = 60_000;
        let now = 1_791_240_330_000;
        let keeper = side("linux/archlinux");
        let beat = |side: &str, env: Option<&str>, at: u64| {
            Read::Found(serde_json::json!({ "side": side, "env": env, "machineId": "m", "at": at }))
        };
        assert_eq!(
            heard(
                &beat("linux", Some("archlinux"), now - 5 * MIN),
                &keeper,
                now
            ),
            Heard::Fresh
        );
        assert_eq!(
            heard(
                &beat("linux", Some("archlinux"), now - 31 * MIN),
                &keeper,
                now
            ),
            Heard::Silent {
                since: Some(now - 31 * MIN)
            }
        );
        assert_eq!(
            heard(
                &beat("linux", Some("archlinux"), now - 30 * MIN),
                &keeper,
                now
            ),
            Heard::Fresh,
            "the limit itself is still in time"
        );
        assert_eq!(
            heard(&Read::Missing, &keeper, now),
            Heard::Silent { since: None },
            "a keeper that never wrote one"
        );
        assert_eq!(
            heard(&beat("linux", Some("ubuntu"), now), &keeper, now),
            Heard::Silent { since: None },
            "another side's heartbeat is not the keeper's"
        );
        assert_eq!(
            heard(&beat("linux", None, now - MIN), &keeper, now),
            Heard::Fresh,
            "a heartbeat with no environment answers for its platform"
        );
        assert_eq!(
            heard(
                &Read::Unreadable("docker did not answer".to_string()),
                &keeper,
                now
            ),
            Heard::Unknown
        );
        assert_eq!(
            heard(
                &Read::Found(serde_json::json!({ "at": "soon" })),
                &keeper,
                now
            ),
            Heard::Unknown
        );
        // A clock that runs behind the writer's is not silence.
        assert_eq!(
            heard(
                &beat("linux", Some("archlinux"), now + 10 * MIN),
                &keeper,
                now
            ),
            Heard::Fresh
        );
    }

    #[test]
    fn the_heartbeat_round_trips_and_an_adoption_says_whose_and_since_when() {
        let body = beat_body(&side("linux/archlinux"), Some("abc"));
        assert_eq!(body["side"], "linux");
        assert_eq!(body["env"], "archlinux");
        assert_eq!(body["machineId"], "abc");
        let written: Value =
            serde_json::from_str(&inside::stamp(&body.to_string(), 7)).expect("JSON");
        assert_eq!(beat_of(&written), Some((side("linux/archlinux"), 7)));
        let adopted = Adoption {
            from: side("linux/archlinux"),
            since: Some(1_791_240_330_000),
        };
        assert_eq!(
            adopted.sentence(),
            "adopted: the side that keeps it (WSL (archlinux)) has been silent since 2026-10-05 22:45 UTC."
        );
        assert_eq!(adopted.json()["from"], "linux/archlinux");
        let never = Adoption {
            from: side("windows"),
            since: None,
        };
        assert!(never
            .sentence()
            .contains("(Windows) has never said it does"));
        assert_eq!(never.json()["silentSince"], Value::Null);
    }
}
