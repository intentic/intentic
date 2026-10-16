use std::path::{Path, PathBuf};

use crate::docker;
use crate::logfile::intentic_home;
use crate::sandbox::{container_of, is_slug, slugs_of};
use crate::ui;
use crate::util::{bail, sha256_hex, Fail, Result};

/* ENCRYPTION AT REST, ON BY DEFAULT.

The daemon encrypts its credential stores (pasted secrets, the capability and extension vaults, the privacy vault and
the AI-provider accounts: _sandbox/sandbox/src/store/encryption/at-rest.ts) only when KEY_ENV names a readable 32-byte
key, which ic mounts read-only at KEY_MOUNT. That key used to come only from an operator who set HOST_FILE_ENV, so a
sandbox set up the ordinary way kept its secrets in plain JSON on its volume. Now every sandbox ic makes or recreates
gets one: the operator's own file when they name it, else a key ic makes for it once, from the operating system's
random source, in this home's `keys/` beside the backup keys (backup.rs). That folder is in no volume and no bind the
container has, so the container reads the key only through the read-only mount and can never write it, and a copy of
the volume (a backup, a lost disk image) does not carry it.

A key is made once and never again: the stores cannot be read without the key they were encrypted with. So a key that
exists is used whatever a run asks, the container's own mount first (it is what the stores were encrypted with, an
operator's file included), then ic's file. INTENTIC_AT_REST=off (SWITCH_ENV) only keeps a sandbox that has no key
without one, for an operator who encrypts the disk instead, and the container carries that choice (`stamp`) so a later
recreate by someone who did not say it again keeps it.

Whose key it is follows where the stores are: the daemon's auth root, which is /work's own `.intentic/secrets/auth`
unless the container mounts a logins volume at AUTH_MOUNT (a dev sandbox's, shared by every dev sandbox on the
machine). The sandboxes sharing one share its key, named for the volume: a key per sandbox over one set of files would
leave every sandbox but the first unable to read them, and the daemon refuses to boot over stores it cannot
authenticate.

The key lives as long as what it encrypted: a removed sandbox's stays with its volumes in the trash and goes when they
are deleted for good (trash.rs), unless this side still holds backups of it, which hold the same encrypted stores and
take it with them (tidy.rs). A logins volume's goes with the volume (remove.rs). An operator's own file is never
deleted: it is theirs. */

/// Where the daemon reads the key (KEY_ENV names it), and the one a rotation reads the stores' old key from.
pub const KEY_MOUNT: &str = "/run/secrets/intentic-at-rest-key";
pub const PREVIOUS_KEY_MOUNT: &str = "/run/secrets/intentic-at-rest-previous-key";
pub const KEY_ENV: &str = "INTENTIC_AT_REST_KEY_FILE";
pub const PREVIOUS_KEY_ENV: &str = "INTENTIC_AT_REST_PREVIOUS_KEY_FILE";
/// The operator's own key files on this machine, which win over ic's.
pub const HOST_FILE_ENV: &str = "INTENTIC_AT_REST_KEY_HOST_FILE";
pub const PREVIOUS_HOST_FILE_ENV: &str = "INTENTIC_AT_REST_PREVIOUS_KEY_HOST_FILE";
/// `off` leaves a sandbox that has no key without one. This run's value wins over the one the container carries.
pub const SWITCH_ENV: &str = "INTENTIC_AT_REST";
/// Where a dev sandbox's shared logins volume is mounted: the daemon's auth root, and so the stores, when it is there.
pub const AUTH_MOUNT: &str = "/agent-auth";
/// What the daemon takes as raw key bytes (keyFromFile in at-rest.ts).
const KEY_LEN: usize = 32;

/// The folder ic keeps keys in, the backup keys' too: this home, never a volume or a bind of a container's.
fn keys_dir(home: &Path) -> PathBuf {
    home.join("keys")
}

/// ic's own key for the stores on one sandbox's own volume. Pure.
fn sandbox_key_in(home: &Path, slug: &str) -> PathBuf {
    keys_dir(home).join(format!("at-rest-{slug}.key"))
}

/// The one key of a logins volume the sandboxes mounting it share, in a folder of its own so no slug can name it. A
/// volume's name is a file name already; a host folder bound there instead is named by a digest of its path. Pure.
fn shared_key_in(home: &Path, source: &str) -> PathBuf {
    let name = if is_slug(source) {
        source.to_string()
    } else {
        sha256_hex(source.as_bytes())[..16].to_string()
    };
    keys_dir(home)
        .join("at-rest-shared")
        .join(format!("{name}.key"))
}

/// ic's own key for a sandbox's stores: the logins volume's when the container mounts one at AUTH_MOUNT (`auth`, its
/// source as docker names it), else the sandbox's. Pure.
fn own_key_in(home: &Path, slug: &str, auth: Option<&str>) -> PathBuf {
    match auth {
        Some(source) => shared_key_in(home, source),
        None => sandbox_key_in(home, slug),
    }
}

pub fn sandbox_key(slug: &str) -> PathBuf {
    sandbox_key_in(&intentic_home(), slug)
}

pub fn shared_key(source: &str) -> PathBuf {
    shared_key_in(&intentic_home(), source)
}

/// Whether a value of SWITCH_ENV turns encryption off: `off`, as the README says, or the other ways a person writes
/// no. Anything else, unset included, leaves it on. Pure.
pub fn says_off(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "off" | "0" | "false" | "no"
        )
    })
}

/// One value out of a NUL-framed env: the first non-empty one, which is the run contract's reading. Pure.
pub fn env_value(env: &[u8], name: &str) -> Option<String> {
    String::from_utf8_lossy(env)
        .split('\0')
        .filter_map(|pair| pair.split_once('='))
        .filter(|(key, value)| *key == name && !value.is_empty())
        .map(|(_, value)| value.to_string())
        .next()
}

/// An operator's key file, named in the variable `name`: an absolute path to a file that exists, refused before anything
/// starts otherwise. None when the variable is unset.
pub fn host_file(name: &str) -> Result<Option<PathBuf>> {
    let Some(value) = std::env::var(name).ok().filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.is_file() {
        bail!("{name} must name an existing absolute host file");
    }
    Ok(Some(path))
}

/// Where a run's key comes from.
#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    /// The operator's own file (HOST_FILE_ENV), mounted from where it is.
    Given(PathBuf),
    /// What the container being replaced mounts, replayed as docker names it: an operator's file or ic's, it is the key
    /// the stores are encrypted with.
    Kept(String),
    /// ic's own key, made the first time a sandbox needs it (`prepare`).
    Own(PathBuf),
    /// No key: the operator opted out, and none exists that anything could be encrypted with.
    Off,
}

impl Source {
    pub fn is_on(&self) -> bool {
        !matches!(self, Source::Off)
    }

    /// The `-v` spec that mounts the key read-only where the daemon reads it; None when there is no key. A host file goes
    /// through `bind_spec`, which spells it the way the engine in use reaches it.
    pub fn mount(&self) -> Result<Option<String>> {
        let rest = format!("{KEY_MOUNT}:ro");
        Ok(match self {
            Source::Given(path) | Source::Own(path) => Some(docker::bind_spec(path, &rest)?),
            // Docker's own name for the source, handed back as it is, as the logins volume and the dev binds are.
            Source::Kept(source) => Some(format!("{source}:{rest}")),
            Source::Off => None,
        })
    }
}

/// What a run knows when it decides.
pub struct Facts<'a> {
    /// The operator's own file, named on this run.
    pub given: Option<&'a Path>,
    /// What the container being replaced mounts at KEY_MOUNT.
    pub mounted: Option<&'a str>,
    /// Whether what it mounts is ic's own key file, and that file is gone from this machine.
    pub mounted_gone: bool,
    /// Whether that container's env names a key (KEY_ENV): it was given one, still mounted or not.
    pub named: bool,
    /// The opt-out, this run's or the one the container carries.
    pub off: bool,
    /// ic's own key for these stores, and whether it exists.
    pub own: &'a Path,
    pub own_made: bool,
}

/// The rule, in order: the operator's file; the key the container has; ic's own key if it exists already, whatever this
/// run asks, since something may be encrypted with it (a sandbox removed and set up again under its name gets its kept
/// volumes back, and a shared logins volume holds its siblings' stores); for a container that was given a key it no
/// longer mounts and that is not ic's, a stop, since a new key cannot read what the lost one encrypted and the daemon
/// would refuse to boot; the opt-out; a new key of ic's. Pure.
pub fn choose(slug: &str, facts: &Facts) -> Result<Source> {
    if let Some(given) = facts.given {
        return Ok(Source::Given(given.to_path_buf()));
    }
    if let Some(mounted) = facts.mounted {
        // Handed a bind source that is not there, docker makes an empty folder in its place and the daemon cannot start.
        if facts.mounted_gone {
            bail!(
                "{}",
                ui::explain(
                    &format!("{slug} was left as it is: its at-rest key {mounted} is gone from this machine."),
                    Some("its stored credentials are encrypted with that key, and cannot be read without it."),
                    Some("put the key file back from wherever you keep a copy of it, and run this again."),
                )
            );
        }
        return Ok(Source::Kept(mounted.to_string()));
    }
    if facts.own_made {
        return Ok(Source::Own(facts.own.to_path_buf()));
    }
    if facts.named {
        bail!(
            "{}",
            ui::explain(
                &format!("{slug} was left as it is: its container was given an at-rest key that it no longer mounts."),
                Some("its stored credentials are encrypted with that key, and ic holds no copy of it: with a new one the sandbox could not read them, and would not start."),
                Some(&format!("run this again with {HOST_FILE_ENV}=<that key file>.")),
            )
        );
    }
    if facts.off {
        return Ok(Source::Off);
    }
    Ok(Source::Own(facts.own.to_path_buf()))
}

/// What a run knows of the container it replaces.
pub struct Old<'a> {
    /// Its KEY_MOUNT source, as docker names it.
    pub mounted: Option<&'a str>,
    /// Its whole env, NUL-framed.
    pub env: &'a [u8],
}

/// This run's key for a sandbox (`choose`), from what the container it replaces carries (`old`, None for a new one),
/// the logins volume it mounts (`auth`), the operator's file (`given`) and SWITCH_ENV.
pub fn decide(
    slug: &str,
    old: Option<&Old>,
    auth: Option<&str>,
    given: Option<&Path>,
) -> Result<Source> {
    let asked = std::env::var(SWITCH_ENV)
        .ok()
        .filter(|value| !value.is_empty());
    let carried = old.and_then(|old| env_value(old.env, SWITCH_ENV));
    let off = says_off(asked.as_deref().or(carried.as_deref()));
    let own = own_key_in(&intentic_home(), slug, auth);
    let own_made = own.exists();
    let mounted = old.and_then(|old| old.mounted);
    let source = choose(
        slug,
        &Facts {
            given,
            mounted,
            mounted_gone: !own_made
                && mounted.is_some_and(|source| {
                    Path::new(source) == own || docker::bind_source(&own).as_deref() == Some(source)
                }),
            named: old.is_some_and(|old| env_value(old.env, KEY_ENV).is_some()),
            off,
            own: &own,
            own_made,
        },
    )?;
    // Overruled only by a key that exists already: one this sandbox was given, or the one its logins volume's siblings made.
    if off && source.is_on() {
        ui::note(&format!(
            "{SWITCH_ENV}=off does not apply to {slug}: it has an at-rest key already, and its stored credentials may be encrypted with it."
        ));
    }
    Ok(source)
}

/// Make ic's own key when this run's answer is a new one and `make` says it starts a container (a check starts none),
/// and say so: losing it loses the stores, so a person is told where it is the moment it exists.
pub fn prepare(source: &Source, slug: &str, auth: Option<&str>, make: bool) -> Result<()> {
    let Source::Own(path) = source else {
        return Ok(());
    };
    if !make || !ensure(path)? {
        return Ok(());
    }
    let whose = match auth {
        Some(volume) => format!("the logins volume {volume}"),
        None => slug.to_string(),
    };
    ui::note(&format!(
        "The credentials {whose} stores are encrypted at rest from now on, with a key made for it: {}. Keep that file: without it they cannot be read.",
        path.display()
    ));
    if let Some(volume) = auth {
        match siblings_without_key(volume, slug).as_slice() {
            [] => {}
            [other] => ui::warn(&format!(
                "{other} also mounts {volume} and has no key yet: it reads those credentials only once a recreate gives it this key (ic sandbox update {other}, rollback or rebuild)."
            )),
            others => ui::warn(&format!(
                "{} also mount {volume} and have no key yet: each reads those credentials only once a recreate gives it this key (ic sandbox update <slug>, rollback or rebuild).",
                others.join(", ")
            )),
        }
    }
    Ok(())
}

/// Make the key at `path` unless it exists: 32 bytes from the operating system's random source, written to a temporary
/// file beside it and moved into place only when whole and only if nothing is there by then, so neither a crash nor a
/// second ic run making the same key (two sandboxes sharing a logins volume) leaves a short one or replaces one. Readable
/// by this user alone on Unix; on Windows it takes the ACL of the profile folder it is in, as the backup key does. True
/// when this call made it.
pub fn ensure(path: &Path) -> Result<bool> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => return Ok(false),
        Ok(_) => bail!(
            "{} is not a file, so it cannot be an at-rest key. Nothing was changed.",
            path.display()
        ),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => bail!("could not read {}: {err}", path.display()),
    }
    let dir = path.parent().expect("a key path has a parent");
    let mut folder = std::fs::DirBuilder::new();
    folder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        folder.mode(0o700);
    }
    folder.create(dir)?;
    let mut key = [0u8; KEY_LEN];
    getrandom::fill(&mut key).map_err(|err| {
        Fail(format!(
            "the operating system gave no random bytes for an at-rest key ({err}). Nothing was changed."
        ))
    })?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".at-rest-").suffix(".part");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut file = builder.tempfile_in(dir)?;
    std::io::Write::write_all(&mut file, &key)?;
    file.as_file().sync_all()?;
    match file.persist_noclobber(path) {
        Ok(_) => Ok(true),
        // Another ic run made it since the look above: that one is the key.
        Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(Fail(format!(
            "could not write {}: {}",
            path.display(),
            err.error
        ))),
    }
}

/// The env a recreate replays, naming the key it mounts: a container that had none, or that was made through an image
/// whose contract did not replay the name, carries none. Pure.
pub fn with_key_env(env: &[u8]) -> Vec<u8> {
    let mut env = env.to_vec();
    if env_value(&env, KEY_ENV).is_none() {
        if !env.is_empty() && !env.ends_with(&[0]) {
            env.push(0);
        }
        env.extend_from_slice(format!("{KEY_ENV}={KEY_MOUNT}").as_bytes());
        env.push(0);
    }
    env
}

/// What ic adds to a run line beside the contract's for this answer: the opt-out, so the container carries it to every
/// later recreate. It rides there for HOST_ENV's reason (connect.rs): the contract replays only the names it lists, and
/// the images already published do not list it. Pure.
pub fn stamp(source: &Source) -> Vec<String> {
    match source {
        Source::Off => vec!["-e".to_string(), format!("{SWITCH_ENV}=off")],
        _ => Vec::new(),
    }
}

/// Whether a run line passes the daemon its key: an image from before encryption at rest replays no KEY_ENV, so the
/// daemon it starts reads nothing a newer one encrypted. Pure.
pub fn passes_key(argv: &[String]) -> bool {
    let named = format!("{KEY_ENV}=");
    argv.iter().any(|arg| arg.starts_with(&named))
}

/// The other sandboxes mounting the logins volume `volume` with no key yet. They cannot read the stores once this one has
/// encrypted them, until a recreate gives them the same key, which it does once that key exists (`choose`).
fn siblings_without_key(volume: &str, this: &str) -> Vec<String> {
    let Some(names) = docker::try_capture(&[
        "ps",
        "-a",
        "--filter",
        &format!("volume={volume}"),
        "--format",
        "{{.Names}}",
    ]) else {
        return Vec::new();
    };
    let names: Vec<String> = names.lines().map(str::trim).map(str::to_string).collect();
    slugs_of(&names)
        .into_iter()
        .filter(|slug| slug != this)
        .filter(|slug| docker::mount_source(&container_of(slug), KEY_MOUNT).is_none())
        .collect()
}

/// Delete ic's own key file. A failure is said, not raised: what it encrypted is gone either way.
pub fn forget(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => ui::warn(&format!("{} could not be deleted: {err}", path.display())),
    }
}

/// After a sandbox's volumes are deleted for good (trash.rs): its key goes too, unless this side's backups of it still
/// hold its encrypted stores, in which case it goes with them (tidy.rs).
pub fn forget_with_data(slug: &str) {
    let backed_up = crate::sandbox::backup::backups_dir(slug).exists()
        || crate::sandbox::backup::key_path(slug).exists();
    if !backed_up {
        forget(&sandbox_key(slug));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(own: &'a Path) -> Facts<'a> {
        Facts {
            given: None,
            mounted: None,
            mounted_gone: false,
            named: false,
            off: false,
            own,
            own_made: false,
        }
    }

    #[test]
    fn the_key_is_kept_in_this_homes_keys_folder_and_nowhere_the_container_sees() {
        let home = Path::new("/home/ada/.intentic");
        assert_eq!(
            own_key_in(home, "sandbox-abc", None),
            Path::new("/home/ada/.intentic/keys/at-rest-sandbox-abc.key")
        );
        // Every sandbox sharing a logins volume reads one key, in a folder no slug can name.
        let shared = own_key_in(home, "sandbox-abc", Some("intentic-dev-agent-auth"));
        assert_eq!(
            shared,
            Path::new("/home/ada/.intentic/keys/at-rest-shared/intentic-dev-agent-auth.key")
        );
        assert_eq!(
            own_key_in(home, "sandbox-other", Some("intentic-dev-agent-auth")),
            shared
        );
        assert_ne!(
            own_key_in(home, "at-rest-shared", None).parent(),
            shared.parent()
        );
        // A host folder bound there is named by a digest, never by its path.
        let bound = own_key_in(home, "x", Some("/srv/auth"));
        let name = bound.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name.len(), "0123456789abcdef.key".len());
        assert!(!name.contains('/'));
        assert_eq!(bound, own_key_in(home, "y", Some("/srv/auth")));
    }

    #[test]
    fn a_new_sandbox_gets_a_key_of_ics_own() {
        let own = Path::new("/h/keys/at-rest-a.key");
        assert_eq!(
            choose("a", &facts(own)).unwrap(),
            Source::Own(own.to_path_buf())
        );
        // One made already is the same answer: it is reused, never made again.
        let made = Facts {
            own_made: true,
            ..facts(own)
        };
        assert_eq!(choose("a", &made).unwrap(), Source::Own(own.to_path_buf()));
    }

    #[test]
    fn an_operators_own_file_wins() {
        let own = Path::new("/h/keys/at-rest-a.key");
        let given = Path::new("/srv/keys/a.key");
        for (mounted, own_made, off) in [
            (None, false, false),
            (None, true, false),
            (Some("/old/key"), true, false),
            (None, false, true),
        ] {
            let asked = Facts {
                given: Some(given),
                mounted,
                own_made,
                off,
                ..facts(own)
            };
            assert_eq!(
                choose("a", &asked).unwrap(),
                Source::Given(given.to_path_buf())
            );
        }
    }

    #[test]
    fn the_key_a_container_mounts_follows_it() {
        let own = Path::new("/h/keys/at-rest-a.key");
        let kept = Facts {
            mounted: Some("/srv/keys/a.key"),
            named: true,
            own_made: true,
            ..facts(own)
        };
        assert_eq!(
            choose("a", &kept).unwrap(),
            Source::Kept("/srv/keys/a.key".to_string())
        );
        // The opt-out does not take a key away: the stores are encrypted with it.
        let off = Facts { off: true, ..kept };
        assert_eq!(
            choose("a", &off).unwrap(),
            Source::Kept("/srv/keys/a.key".to_string())
        );
    }

    #[test]
    fn a_kept_key_that_is_gone_is_never_mounted() {
        let own = Path::new("/h/keys/at-rest-a.key");
        let gone = Facts {
            mounted: Some("/h/keys/at-rest-a.key"),
            mounted_gone: true,
            named: true,
            ..facts(own)
        };
        let refusal = choose("a", &gone).unwrap_err().0;
        assert!(refusal.contains("is gone"), "{refusal}");
        // An operator's file named on this run is theirs to answer for, and wins as ever.
        let given = Path::new("/srv/keys/a.key");
        assert_eq!(
            choose(
                "a",
                &Facts {
                    given: Some(given),
                    ..gone
                }
            )
            .unwrap(),
            Source::Given(given.to_path_buf())
        );
    }

    #[test]
    fn the_opt_out_leaves_a_sandbox_with_no_key_without_one() {
        let own = Path::new("/h/keys/at-rest-a.key");
        let off = Facts {
            off: true,
            ..facts(own)
        };
        assert_eq!(choose("a", &off).unwrap(), Source::Off);
        // But not one whose key ic already made: its kept volumes, or a shared volume's siblings, may be encrypted with it.
        let made = Facts {
            own_made: true,
            ..off
        };
        assert_eq!(choose("a", &made).unwrap(), Source::Own(own.to_path_buf()));
    }

    #[test]
    fn a_key_the_container_lost_is_never_replaced_by_a_new_one() {
        let own = Path::new("/h/keys/at-rest-a.key");
        let lost = Facts {
            named: true,
            ..facts(own)
        };
        let refusal = choose("a", &lost).unwrap_err().0;
        assert!(refusal.contains(HOST_FILE_ENV), "{refusal}");
        assert!(choose("a", &Facts { off: true, ..lost }).is_err());
        // ic's own key, its mount lost (a move between engines makes the container again without binds): mounted again.
        let ours = Facts {
            named: true,
            own_made: true,
            ..facts(own)
        };
        assert_eq!(choose("a", &ours).unwrap(), Source::Own(own.to_path_buf()));
    }

    #[test]
    fn off_is_said_the_ways_people_say_no() {
        for value in ["off", "OFF", " Off ", "0", "false", "no"] {
            assert!(says_off(Some(value)), "{value}");
        }
        for value in [None, Some("on"), Some("1"), Some("yes"), Some("")] {
            assert!(!says_off(value), "{value:?}");
        }
    }

    #[test]
    fn the_opt_out_rides_on_the_container_and_reads_back() {
        assert_eq!(stamp(&Source::Off), vec!["-e", "INTENTIC_AT_REST=off"]);
        assert!(stamp(&Source::Own(PathBuf::from("/k"))).is_empty());
        assert!(stamp(&Source::Kept("/k".to_string())).is_empty());
        let env = crate::util::nul_frame(&[("A", "b"), ("INTENTIC_AT_REST", "off")]);
        assert!(says_off(env_value(&env, SWITCH_ENV).as_deref()));
        // The contract's reading: the first non-empty value.
        let env = crate::util::nul_frame(&[("X", ""), ("X", "1"), ("X", "2")]);
        assert_eq!(env_value(&env, "X").as_deref(), Some("1"));
        assert_eq!(env_value(&env, "Y"), None);
    }

    #[test]
    fn a_recreate_names_the_key_once() {
        let env = crate::util::nul_frame(&[("A", "b")]);
        let named = with_key_env(&env);
        assert_eq!(
            env_value(&named, KEY_ENV).as_deref(),
            Some("/run/secrets/intentic-at-rest-key")
        );
        assert_eq!(with_key_env(&named), named);
        // An env that does not end its last pair still frames the new one.
        let unframed = with_key_env(b"A=b");
        assert_eq!(env_value(&unframed, "A").as_deref(), Some("b"));
        assert!(env_value(&unframed, KEY_ENV).is_some());
        assert!(env_value(&with_key_env(b""), KEY_ENV).is_some());
    }

    #[test]
    fn an_image_from_before_encryption_passes_no_key() {
        let argv =
            |pairs: &[&str]| -> Vec<String> { pairs.iter().map(|arg| arg.to_string()).collect() };
        assert!(passes_key(&argv(&[
            "run",
            "-e",
            "INTENTIC_AT_REST_KEY_FILE=/run/secrets/intentic-at-rest-key",
            "img"
        ])));
        assert!(!passes_key(&argv(&[
            "run",
            "-v",
            "/k:/run/secrets/intentic-at-rest-key:ro",
            "img"
        ])));
        assert!(!passes_key(&argv(&[
            "run",
            "-e",
            "INTENTIC_AT_REST_PREVIOUS_KEY_FILE=/p",
            "img"
        ])));
    }

    #[test]
    fn a_key_is_made_once_and_never_again() {
        let home = tempfile::tempdir().unwrap();
        let path = own_key_in(home.path(), "sandbox-abc", None);
        assert!(ensure(&path).unwrap());
        let key = std::fs::read(&path).unwrap();
        assert_eq!(key.len(), KEY_LEN);
        assert!(!ensure(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), key);
        // Each key its own random bytes.
        let other = own_key_in(home.path(), "sandbox-def", None);
        assert!(ensure(&other).unwrap());
        assert_ne!(std::fs::read(&other).unwrap(), key);
        // Nothing half-written is left beside them.
        let left: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.iter().all(|name| name.ends_with(".key")), "{left:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
        }
    }

    #[test]
    fn a_shared_key_is_made_in_its_own_folder() {
        let home = tempfile::tempdir().unwrap();
        let path = own_key_in(home.path(), "sandbox-abc", Some("intentic-dev-agent-auth"));
        assert!(ensure(&path).unwrap());
        assert_eq!(std::fs::read(&path).unwrap().len(), KEY_LEN);
    }

    #[test]
    fn what_is_not_a_key_file_is_refused_rather_than_mounted() {
        let home = tempfile::tempdir().unwrap();
        let path = own_key_in(home.path(), "sandbox-abc", None);
        std::fs::create_dir_all(&path).unwrap();
        assert!(ensure(&path).is_err());
        assert!(path.is_dir());
    }
}
