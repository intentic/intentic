use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::tool;
use crate::util::{bail, Fail, Result};

/* `ic os drives`: THE USB STICKS AND MEMORY CARDS PLUGGED INTO THIS MACHINE, AND WHAT IS ON THEM COPIED INTO A SANDBOX.
`lsblk -J` says what is plugged in (as util-linux 2.40-2.41 prints it), and the pure functions below keep only
removable drives: USB, memory cards, and any drive the kernel calls removable or hot-pluggable, and never one that holds
part of the machine itself (anything mounted outside /run/media, /media or /mnt, or used as swap), so a verb here can
never be pointed at the OS's own disk. udisks mounts, unmounts and powers off, as the `intentic` user, which the image's
polkit rule allows for removable drives and nothing else.

An import opens the drive read-only when it is not open already (nothing on the stick changes), measures it, checks the
sandbox has the room (and stops, exit 6, when it would not fit, before copying a byte), and copies it with `docker cp`
into `/work/Imports/<label>-<YYYY-MM-DD>/` (or the folder asked for), owned by whoever owns the sandbox's /work. While
it copies it says how far it got every few seconds: a progress line for a person, a `{"progress":…}` line with
`--json`, whose last line is then the result. */

/// lsblk reads sysfs.
const LSBLK_LIMIT: Duration = Duration::from_secs(10);
/// udisks mounting or unmounting a drive, which may flush what was written to it first.
const UDISKS_LIMIT: Duration = Duration::from_secs(90);
/// A docker exec asking the sandbox something small (its free space, who owns /work).
const EXEC_LIMIT: Duration = Duration::from_secs(30);
/// The longest a copy may take: a full 2 TB disk over USB 2 is most of a day; past it the copy is stopped.
const COPY_LIMIT: Duration = Duration::from_secs(24 * 60 * 60);
/// How often a copy says how far it got.
const PROGRESS_EVERY: Duration = Duration::from_secs(3);
/// Room an import always leaves in the sandbox, so the sandbox can still work once the drive is in it.
const RESERVE_BYTES: u64 = 256 * 1024 * 1024;

/// The exit code for a drive whose files would not fit in the sandbox (the contract's IC_OS_DRIVE_NO_ROOM_EXIT).
pub const NO_ROOM: i32 = 6;

/// What `lsblk` is asked for.
const LSBLK_ARGS: [&str; 4] = [
    "-J",
    "-b",
    "-o",
    "NAME,PATH,TYPE,SIZE,RM,HOTPLUG,RO,TRAN,LABEL,FSTYPE,MOUNTPOINTS,MODEL",
];

/// Filesystems that hold no files a person could copy: swap, a locked encrypted volume, pieces of a RAID or LVM set.
const NOT_FILES: [&str; 6] = [
    "swap",
    "crypto_LUKS",
    "LVM2_member",
    "linux_raid_member",
    "zfs_member",
    "BitLocker",
];

/// Where udisks and people open removable drives; anything mounted elsewhere is part of the machine.
const REMOVABLE_MOUNTS: [&str; 3] = ["/run/media/", "/media/", "/mnt/"];

/// One removable drive's filesystem: a partition, or the whole stick when it has none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Drive {
    pub device: String,
    /// The whole drive it is on (what is powered off).
    pub disk: String,
    pub label: Option<String>,
    pub size: u64,
    pub filesystem: Option<String>,
    pub mounted_at: Option<String>,
    pub read_only: bool,
    pub model: Option<String>,
    pub kind: &'static str,
}

impl Drive {
    fn value(&self) -> Value {
        json!({
            "device": self.device,
            "label": self.label,
            "size": self.size,
            "filesystem": self.filesystem,
            "mountedAt": self.mounted_at,
            "readOnly": self.read_only,
            "model": self.model,
            "kind": self.kind,
        })
    }

    /// The drive as a person calls it: its label, else what the drive says it is, else what kind it is.
    pub fn called(&self) -> String {
        self.label
            .clone()
            .or_else(|| self.model.clone())
            .unwrap_or_else(|| {
                match self.kind {
                    "card" => "memory card",
                    "usb" => "USB drive",
                    _ => "drive",
                }
                .to_string()
            })
    }
}

/// A string field, trimmed (lsblk pads a model with spaces), null when empty.
fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// The mount points of a block device: util-linux 2.37+ says `mountpoints` (`[]`, or `[null]`, when it has none).
fn mounts(device: &Value) -> Vec<String> {
    device["mountpoints"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(text)
        .chain(text(&device["mountpoint"]))
        .collect()
}

/// lsblk says a boolean as `true`, or as `"1"` in older versions.
fn flag(value: &Value) -> bool {
    value.as_bool().unwrap_or(false) || value.as_str() == Some("1")
}

/// The removable drives in what `lsblk -J -b -o …` printed. Pure.
pub fn drives(lsblk: &Value) -> Vec<Drive> {
    let disks: Vec<&Value> = lsblk["blockdevices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|device| device["type"] == "disk")
        .collect();
    let names: Vec<&str> = disks
        .iter()
        .filter_map(|disk| disk["name"].as_str())
        .collect();
    let mut found = Vec::new();
    for disk in &disks {
        let name = disk["name"].as_str().unwrap_or_default();
        let transport = disk["tran"].as_str().unwrap_or_default();
        // An mmcblk with boot partitions beside it is soldered-in eMMC, not a card.
        let card = name.starts_with("mmcblk")
            && !name.contains("boot")
            && !names.contains(&format!("{name}boot0").as_str());
        let removable = card
            || flag(&disk["rm"])
            || flag(&disk["hotplug"])
            || matches!(transport, "usb" | "mmc");
        if !removable {
            continue;
        }
        let children: Vec<&Value> = disk["children"].as_array().into_iter().flatten().collect();
        let parts: Vec<&Value> = if children.is_empty() {
            vec![*disk]
        } else {
            children
        };
        // A drive any part of which the machine itself uses is no removable drive, whatever the kernel says of it.
        let holds_the_machine = std::iter::once(*disk)
            .chain(parts.iter().copied())
            .flat_map(mounts)
            .any(|mount| {
                !REMOVABLE_MOUNTS
                    .iter()
                    .any(|place| mount.starts_with(place))
            });
        if holds_the_machine {
            continue;
        }
        let kind = if transport == "usb" {
            "usb"
        } else if card || transport == "mmc" {
            "card"
        } else {
            "other"
        };
        for part in parts {
            let Some(filesystem) = text(&part["fstype"]) else {
                continue;
            };
            if NOT_FILES.contains(&filesystem.as_str()) {
                continue;
            }
            found.push(Drive {
                device: text(&part["path"]).unwrap_or_else(|| {
                    format!("/dev/{}", part["name"].as_str().unwrap_or_default())
                }),
                disk: text(&disk["path"]).unwrap_or_else(|| format!("/dev/{name}")),
                label: text(&part["label"]),
                size: part["size"].as_u64().unwrap_or(0),
                filesystem: Some(filesystem),
                mounted_at: mounts(part).into_iter().next(),
                read_only: flag(&part["ro"]) || flag(&disk["ro"]),
                model: text(&disk["model"]),
                kind,
            });
        }
    }
    found
}

/// `ic os drives list --json`. Pure.
pub fn list_value(drives: &[Drive]) -> Value {
    json!({ "drives": drives.iter().map(Drive::value).collect::<Vec<_>>() })
}

/// A device path as ic takes it: `/dev/` and a name, nothing that walks out of /dev. Pure.
pub fn valid_device(device: &str) -> bool {
    device.strip_prefix("/dev/").is_some_and(|name| {
        let mut chars = name.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && name.len() <= 64
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && !name.contains("..")
    })
}

/// A folder inside the sandbox's /work as ic takes it: relative, no `.` or `..` part, no empty part. Pure.
pub fn valid_subfolder(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 255
        && !path.starts_with('/')
        && !path.starts_with('-')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains('\0'))
}

/// The import's folder: the drive's name and the date, `KINGSTON-2026-10-16`, in characters every system takes. Pure.
pub fn folder_name(drive: &Drive, date: &str) -> String {
    let mut name = String::new();
    for c in drive.called().chars() {
        if c.is_alphanumeric() || matches!(c, '_' | '.') {
            name.push(c);
        } else if !name.ends_with('-') {
            name.push('-');
        }
    }
    let name: String = name.trim_matches(['-', '.']).chars().take(64).collect();
    let name = if name.is_empty() {
        "drive".to_string()
    } else {
        name
    };
    format!("{name}-{date}")
}

/// Today as `YYYY-MM-DD` from days since 1970 (the civil calendar, as `date +%F` in UTC). Pure.
pub fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The free bytes in what `df -Pk <dir>` printed: its second line's fourth column, in KiB. Pure.
pub fn free_bytes(df: &str) -> Option<u64> {
    let line = df.lines().nth(1)?;
    let available: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(available * 1024)
}

/// Where udisksctl says it mounted a drive: `Mounted /dev/sda1 at /run/media/intentic/KINGSTON` (older versions end
/// the sentence with a full stop). Pure.
pub fn mounted_at(said: &str) -> Option<String> {
    let line = said.lines().find(|line| line.starts_with("Mounted "))?;
    let (_, place) = line.split_once(" at ")?;
    let place = place.trim();
    let place = place.strip_suffix('.').unwrap_or(place);
    (!place.is_empty()).then(|| place.to_string())
}

/// A count of bytes as a person reads it: `117.7 MB`, `1.2 GB`. Pure.
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} bytes")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// The bytes and files under a folder: regular files, counted once, without following links out of it.
pub fn tally(root: &Path) -> std::io::Result<(u64, u64)> {
    let mut bytes = 0;
    let mut files = 0;
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                folders.push(entry.path());
            } else if kind.is_file() {
                bytes += entry.metadata()?.len();
                files += 1;
            }
        }
    }
    Ok((bytes, files))
}

/// The import's result. Pure.
pub fn import_value(device: &str, sandbox: &str, path: &str, bytes: u64, files: u64) -> Value {
    json!({ "device": device, "sandbox": sandbox, "path": path, "bytes": bytes, "files": files })
}

/// A progress line of `--json`. Pure.
pub fn progress_value(bytes: u64, total: u64) -> Value {
    json!({ "progress": { "bytes": bytes.min(total), "total": total } })
}

/* RUNNING lsblk, udisksctl AND docker. */

fn read_drives() -> Result<Vec<Drive>> {
    let said = tool::capture("lsblk", &LSBLK_ARGS, LSBLK_LIMIT)?;
    let listing: Value = serde_json::from_str(&said)
        .map_err(|err| Fail(format!("lsblk answered what is not JSON: {err}")))?;
    Ok(drives(&listing))
}

/// The listed drive a device names, or the stop that says it is not a removable drive here.
fn listed(device: &str) -> Result<Drive> {
    if !valid_device(device) {
        bail!("{device:?} is not a drive's device (like /dev/sdb1; ic os drives list).");
    }
    let found = read_drives()?;
    match found
        .iter()
        .find(|drive| drive.device == device)
        .or_else(|| found.iter().find(|drive| drive.disk == device))
    {
        Some(drive) => Ok(drive.clone()),
        None => bail!(
            "{}",
            crate::ui::explain(
                &format!("{device} is not a USB drive or memory card plugged into this machine."),
                None,
                Some("ic os drives list"),
            )
        ),
    }
}

fn udisksctl(args: &[&str]) -> Result<String> {
    tool::capture("udisksctl", args, UDISKS_LIMIT)
}

/// `ic os drives list [--json]`.
pub fn list(json: bool) -> Result<()> {
    if json {
        crate::ui::send_human_to_stderr();
    }
    let found = read_drives()?;
    if json {
        super::emit_json(&list_value(&found));
        return Ok(());
    }
    if found.is_empty() {
        crate::ui::quiet("No USB drive or memory card is plugged in.");
        return Ok(());
    }
    crate::ui::report("Drives plugged in", None);
    let fields: Vec<(String, String)> = found
        .iter()
        .map(|drive| {
            let mut words = vec![drive.called(), human_bytes(drive.size)];
            if let Some(place) = &drive.mounted_at {
                words.push(format!("open at {place}"));
            }
            if drive.read_only {
                words.push("read-only".to_string());
            }
            (drive.device.clone(), words.join(", "))
        })
        .collect();
    crate::ui::fields(&fields);
    Ok(())
}

/// What `ic os drives import` was asked.
pub struct Import {
    pub device: String,
    pub to: String,
    pub path: Option<String>,
    pub json: bool,
}

/// Today, as this machine's clock and time zone say it.
fn today() -> String {
    tool::capture("date", &["+%F"], Duration::from_secs(5))
        .ok()
        .map(|said| said.trim().to_string())
        .filter(|date| date.len() == 10)
        .unwrap_or_else(|| {
            let secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|since| since.as_secs())
                .unwrap_or(0);
            civil_date((secs / 86_400) as i64)
        })
}

/// A command in the sandbox, as `user` when given; what it printed, or None when it failed.
fn exec(container: &str, user: Option<&str>, cmd: &[&str]) -> Option<String> {
    let mut args = vec!["exec"];
    if let Some(user) = user {
        args.extend(["-u", user]);
    }
    args.push(container);
    args.extend_from_slice(cmd);
    crate::docker::ask(&args, EXEC_LIMIT).said()
}

/// `ic os drives import <device> --to <slug> [--path <folder>] [--json]`.
pub fn import(asked: Import) -> Result<()> {
    if asked.json {
        crate::ui::send_human_to_stderr();
    }
    if let Some(path) = asked.path.as_deref().filter(|path| !valid_subfolder(path)) {
        bail!("{path:?} is not a folder inside the sandbox's /work: give one like Photos/2026.");
    }
    let drive = listed(&asked.device)?;
    crate::docker::require_daemon()?;
    let slug = crate::sandbox::resolve_slug(Some(asked.to.clone()), "ic os drives import")?;
    let container = crate::sandbox::container_of(&slug);
    if !crate::sandbox::inside::running(&container) {
        bail!(
            "{}",
            crate::ui::explain(
                &format!("The sandbox {slug} is not running, so nothing can be copied into it."),
                None,
                Some(&format!("ic sandbox start {slug}")),
            )
        );
    }
    let (root, mounted_here) = match &drive.mounted_at {
        Some(place) => (place.clone(), false),
        None => {
            crate::ui::note(&format!("opening {} (read-only)…", drive.called()));
            let said = udisksctl(&[
                "mount",
                "-b",
                &drive.device,
                "-o",
                "ro",
                "--no-user-interaction",
            ])?;
            let place = mounted_at(&said)
                .or_else(|| {
                    read_drives()
                        .ok()?
                        .into_iter()
                        .find(|found| found.device == drive.device)?
                        .mounted_at
                })
                .ok_or_else(|| {
                    Fail(format!(
                        "udisks opened {} but did not say where: {said}",
                        drive.device
                    ))
                })?;
            (place, true)
        }
    };
    let copied = copy_in(&asked, &drive, &slug, &container, &root);
    if mounted_here {
        // Closed again as it was found, so it can be pulled out (or ejected) at once.
        if let Err(err) = udisksctl(&["unmount", "-b", &drive.device, "--no-user-interaction"]) {
            crate::ui::warn(&format!(
                "{} could not be closed again: {}",
                drive.called(),
                err.0
            ));
        }
    }
    copied
}

/// The copy itself, from `root` (where the drive is open) into the sandbox.
fn copy_in(asked: &Import, drive: &Drive, slug: &str, container: &str, root: &str) -> Result<()> {
    let (bytes, files) = tally(Path::new(root))
        .map_err(|err| Fail(format!("could not read {}: {err}", drive.called())))?;
    let free = exec(container, None, &["df", "-Pk", "/work"])
        .as_deref()
        .and_then(free_bytes)
        .ok_or_else(|| {
            Fail(format!(
                "could not ask the sandbox {slug} how much room it has."
            ))
        })?;
    if bytes.saturating_add(RESERVE_BYTES) > free {
        tool::exit_with(
            NO_ROOM,
            &format!(
                "{} holds {} and the sandbox {slug} has {} free, so it would not fit: an import always leaves {} free, \
                 for the sandbox to keep working. Nothing was copied.",
                drive.called(),
                human_bytes(bytes),
                human_bytes(free),
                human_bytes(RESERVE_BYTES)
            ),
        );
    }
    let owner = exec(container, None, &["stat", "-c", "%u:%g", "/work"])
        .map(|said| said.trim().to_string())
        .filter(|owner| !owner.is_empty())
        .unwrap_or_else(|| "0:0".to_string());
    let base = match &asked.path {
        Some(path) => format!("/work/{path}"),
        None => format!("/work/Imports/{}", folder_name(drive, &today())),
    };
    // Never into a folder an earlier import (or anything else) made: the same stick twice in one day gets `-2`.
    let mut dest = base.clone();
    if asked.path.is_none() {
        let mut next = 2;
        while exec(container, None, &["test", "-e", &dest]).is_some() && next < 100 {
            dest = format!("{base}-{next}");
            next += 1;
        }
    }
    if exec(container, Some(&owner), &["mkdir", "-p", &dest]).is_none() {
        bail!("could not make {dest} in the sandbox {slug}.");
    }
    crate::ui::note(&format!(
        "copying {} ({}, {}) into {slug} at {dest}…",
        drive.called(),
        human_bytes(bytes),
        crate::util::plural(files as usize, "file")
    ));
    let source = format!("{}/.", root.trim_end_matches('/'));
    let target = format!("{container}:{dest}");
    let mut child = crate::docker::command(&["cp", &source, &target])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| Fail(format!("could not run docker cp: {err}")))?;
    let began = Instant::now();
    let mut said = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if began.elapsed() >= COPY_LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            bail!("The copy into {slug} did not finish within {} hours and was stopped; what arrived is in {dest}.", COPY_LIMIT.as_secs() / 3600);
        }
        if said.elapsed() >= PROGRESS_EVERY {
            said = Instant::now();
            let arrived = exec(container, None, &["du", "-sb", &dest])
                .and_then(|du| du.split_whitespace().next()?.parse::<u64>().ok());
            if let Some(arrived) = arrived {
                report_progress(asked.json, arrived, bytes);
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            use std::io::Read as _;
            let _ = pipe.read_to_string(&mut stderr);
        }
        bail!(
            "The copy into {slug} stopped part way ({}); what arrived is in {dest}.",
            tool::last_words("", &stderr, "docker cp")
        );
    }
    // docker cp writes as root: the files go to whoever owns /work, so the sandbox's own user can change them.
    if exec(container, Some("0"), &["chown", "-R", &owner, &dest]).is_none() {
        crate::ui::warn(&format!("The files in {dest} could not be given to the sandbox's user; they may be read-only there."));
    }
    report_progress(asked.json, bytes, bytes);
    let result = import_value(&drive.device, slug, &dest, bytes, files);
    if asked.json {
        super::emit_json(&result);
    } else {
        crate::ui::done(&format!(
            "Copied {} ({}) from {} into {slug}, in {dest}.",
            crate::util::plural(files as usize, "file"),
            human_bytes(bytes),
            drive.called()
        ));
    }
    Ok(())
}

fn report_progress(json: bool, bytes: u64, total: u64) {
    if json {
        super::emit_json(&progress_value(bytes, total));
        return;
    }
    let percent = (bytes.min(total) * 100).checked_div(total).unwrap_or(100);
    crate::ui::progress(&format!(
        "copied {} of {} ({percent}%)",
        human_bytes(bytes.min(total)),
        human_bytes(total)
    ));
}

/// `ic os drives eject <device>`: every part of the drive closed, then the drive powered off, so it can be pulled out.
pub fn eject(device: &str) -> Result<()> {
    let drive = listed(device)?;
    let parts: Vec<Drive> = read_drives()?
        .into_iter()
        .filter(|found| found.disk == drive.disk)
        .collect();
    for part in parts.iter().filter(|part| part.mounted_at.is_some()) {
        udisksctl(&["unmount", "-b", &part.device, "--no-user-interaction"]).map_err(|err| {
            Fail(format!(
                "{} is still in use, so it was not ejected: close what uses it and try again. ({})",
                part.called(),
                err.0
            ))
        })?;
    }
    udisksctl(&["power-off", "-b", &drive.disk, "--no-user-interaction"])?;
    crate::ui::done(&format!("{} can be pulled out now.", drive.called()));
    Ok(())
}

#[cfg(test)]
pub(crate) mod fixture {
    use serde_json::{json, Value};

    /// `lsblk -J -b -o NAME,PATH,TYPE,SIZE,RM,HOTPLUG,RO,TRAN,LABEL,FSTYPE,MOUNTPOINTS,MODEL` from util-linux 2.41 (the
    /// shape recorded on a 2.41.5 machine), on an Intentic OS laptop: its NVMe system disk, zram swap, a USB stick, a
    /// USB disk already open with a Windows reserved partition, a read-only stick with no partitions, an SD card, the
    /// eMMC beside it, and a USB disk the owner mounted for backups (part of the machine, so never listed).
    pub fn lsblk() -> Value {
        let size = 7385_u64 * 1_048_576;
        json!({ "blockdevices": [
            { "name": "nvme0n1", "path": "/dev/nvme0n1", "type": "disk", "size": 512110190592u64, "rm": false, "hotplug": false,
              "ro": false, "tran": "nvme", "label": null, "fstype": null, "mountpoints": [null], "model": "Samsung SSD 980 PRO 500GB",
              "children": [
                { "name": "nvme0n1p1", "path": "/dev/nvme0n1p1", "type": "part", "size": 629145600, "rm": false, "hotplug": false,
                  "ro": false, "tran": "nvme", "label": "EFI-SYSTEM", "fstype": "vfat", "mountpoints": ["/boot/efi"], "model": null },
                { "name": "nvme0n1p2", "path": "/dev/nvme0n1p2", "type": "part", "size": 1073741824, "rm": false, "hotplug": false,
                  "ro": false, "tran": "nvme", "label": "boot", "fstype": "ext4", "mountpoints": ["/boot"], "model": null },
                { "name": "nvme0n1p3", "path": "/dev/nvme0n1p3", "type": "part", "size": 510407303168u64, "rm": false, "hotplug": false,
                  "ro": false, "tran": "nvme", "label": "root", "fstype": "xfs", "mountpoints": ["/var", "/etc", "/sysroot"], "model": null }
              ] },
            { "name": "zram0", "path": "/dev/zram0", "type": "disk", "size": 8589934592u64, "rm": false, "hotplug": false,
              "ro": false, "tran": null, "label": null, "fstype": "swap", "mountpoints": ["[SWAP]"], "model": null },
            { "name": "sda", "path": "/dev/sda", "type": "disk", "size": 7747928064u64, "rm": true, "hotplug": true,
              "ro": false, "tran": "usb", "label": null, "fstype": null, "mountpoints": [], "model": "DataTraveler 3.0 ",
              "children": [
                { "name": "sda1", "path": "/dev/sda1", "type": "part", "size": size, "rm": true, "hotplug": true,
                  "ro": false, "tran": "usb", "label": "KINGSTON", "fstype": "vfat", "mountpoints": [null], "model": null }
              ] },
            { "name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 1000204886016u64, "rm": false, "hotplug": true,
              "ro": false, "tran": "usb", "label": null, "fstype": null, "mountpoints": [], "model": "Expansion HDD   ",
              "children": [
                { "name": "sdb1", "path": "/dev/sdb1", "type": "part", "size": 1000203091968u64, "rm": false, "hotplug": true,
                  "ro": false, "tran": "usb", "label": "Photos", "fstype": "exfat", "mountpoints": ["/run/media/intentic/Photos"], "model": null },
                { "name": "sdb2", "path": "/dev/sdb2", "type": "part", "size": 16777216, "rm": false, "hotplug": true,
                  "ro": false, "tran": "usb", "label": null, "fstype": null, "mountpoints": [], "model": null }
              ] },
            { "name": "sdc", "path": "/dev/sdc", "type": "disk", "size": 4026531840u64, "rm": true, "hotplug": true,
              "ro": true, "tran": "usb", "label": null, "fstype": "vfat", "mountpoints": [], "model": "Flash Disk" },
            { "name": "mmcblk0", "path": "/dev/mmcblk0", "type": "disk", "size": 63864569856u64, "rm": false, "hotplug": false,
              "ro": false, "tran": null, "label": null, "fstype": null, "mountpoints": [], "model": null,
              "children": [
                { "name": "mmcblk0p1", "path": "/dev/mmcblk0p1", "type": "part", "size": 63848939520u64, "rm": false, "hotplug": false,
                  "ro": false, "tran": null, "label": "CANON_DC", "fstype": "exfat", "mountpoints": [], "model": null }
              ] },
            { "name": "mmcblk1", "path": "/dev/mmcblk1", "type": "disk", "size": 31268536320u64, "rm": false, "hotplug": false,
              "ro": false, "tran": null, "label": null, "fstype": null, "mountpoints": [], "model": null,
              "children": [
                { "name": "mmcblk1p1", "path": "/dev/mmcblk1p1", "type": "part", "size": 31267487744u64, "rm": false, "hotplug": false,
                  "ro": false, "tran": null, "label": null, "fstype": "ext4", "mountpoints": [], "model": null }
              ] },
            { "name": "mmcblk1boot0", "path": "/dev/mmcblk1boot0", "type": "disk", "size": 4194304, "rm": false, "hotplug": false,
              "ro": true, "tran": null, "label": null, "fstype": null, "mountpoints": [], "model": null },
            { "name": "sdd", "path": "/dev/sdd", "type": "disk", "size": 2000398934016u64, "rm": false, "hotplug": true,
              "ro": false, "tran": "usb", "label": null, "fstype": null, "mountpoints": [], "model": "Backup Plus",
              "children": [
                { "name": "sdd1", "path": "/dev/sdd1", "type": "part", "size": 2000397795328u64, "rm": false, "hotplug": true,
                  "ro": false, "tran": "usb", "label": "backups", "fstype": "ext4", "mountpoints": ["/var/srv/backups"], "model": null }
              ] }
        ] })
    }
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
    fn only_removable_drives_are_listed_and_never_one_the_machine_uses() {
        let found = drives(&fixture::lsblk());
        let devices: Vec<&str> = found.iter().map(|drive| drive.device.as_str()).collect();
        // Not the NVMe system disk, not zram, not the eMMC, not the backup disk mounted under /var, not a partition with
        // no filesystem.
        assert_eq!(
            devices,
            vec!["/dev/sda1", "/dev/sdb1", "/dev/sdc", "/dev/mmcblk0p1"]
        );
        assert_eq!(found[0].disk, "/dev/sda");
        assert_eq!(found[2].disk, "/dev/sdc");
        assert_eq!(list_value(&found), golden()["drives"][0]);
        assert_eq!(
            list_value(&drives(&json!({ "blockdevices": [] }))),
            golden()["drives"][1]
        );
        assert_eq!(drives(&json!({})), vec![]);
    }

    #[test]
    fn a_drive_is_called_by_its_label_else_its_model_else_its_kind() {
        let found = drives(&fixture::lsblk());
        assert_eq!(found[0].called(), "KINGSTON");
        assert_eq!(found[2].called(), "Flash Disk");
        let mut card = found[3].clone();
        card.label = None;
        assert_eq!(card.called(), "memory card");
        assert_eq!(folder_name(&found[0], "2026-10-16"), "KINGSTON-2026-10-16");
        assert_eq!(
            folder_name(&found[2], "2026-10-16"),
            "Flash-Disk-2026-10-16"
        );
        let mut odd = found[0].clone();
        odd.label = Some("../My Photos: 2026!".to_string());
        assert_eq!(folder_name(&odd, "2026-10-16"), "My-Photos-2026-2026-10-16");
        odd.label = Some("***".to_string());
        assert_eq!(folder_name(&odd, "2026-10-16"), "drive-2026-10-16");
    }

    #[test]
    fn every_import_answer_the_contract_shows_is_the_shape_made_here() {
        let golden = golden();
        assert_eq!(
            progress_value(61_728_394, 123_456_789),
            golden["driveImportProgress"][0]
        );
        // A count past the total (directories counted by du) never reads as more than all of it.
        assert_eq!(progress_value(200, 100)["progress"]["bytes"], json!(100));
        assert_eq!(
            import_value(
                "/dev/sda1",
                "work",
                "/work/Imports/KINGSTON-2026-10-16",
                123_456_789,
                42
            ),
            golden["driveImport"][0]
        );
    }

    #[test]
    fn only_a_device_and_a_folder_inside_work_are_taken() {
        for good in ["/dev/sda1", "/dev/mmcblk0p1", "/dev/sdc", "/dev/nvme1n1p2"] {
            assert!(valid_device(good), "{good}");
        }
        for bad in [
            "sda1",
            "/dev/",
            "/dev/../etc/passwd",
            "/dev/sda/../x",
            "/etc/passwd",
            "/dev/-x",
            "/dev/a b",
        ] {
            assert!(!valid_device(bad), "{bad}");
        }
        for good in ["Photos", "Photos/2026", "a b/c"] {
            assert!(valid_subfolder(good), "{good}");
        }
        for bad in [
            "",
            "/etc",
            "../history",
            "a/../b",
            "a//b",
            "./a",
            "-rf",
            "a/",
        ] {
            assert!(!valid_subfolder(bad), "{bad}");
        }
    }

    #[test]
    fn what_the_tools_say_is_read() {
        assert_eq!(
            mounted_at("Mounted /dev/sda1 at /run/media/intentic/KINGSTON\n"),
            Some("/run/media/intentic/KINGSTON".to_string())
        );
        assert_eq!(
            mounted_at("Mounted /dev/sda1 at /run/media/intentic/KINGSTON.\n"),
            Some("/run/media/intentic/KINGSTON".to_string())
        );
        assert_eq!(mounted_at("Error mounting /dev/sda1"), None);
        let df = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sdb1        102626232  45678912  51684000      47% /work\n";
        assert_eq!(free_bytes(df), Some(51_684_000 * 1024));
        assert_eq!(free_bytes("Filesystem 1024-blocks\n"), None);
        assert_eq!(human_bytes(999), "999 bytes");
        assert_eq!(human_bytes(117_700_000), "117.7 MB");
        assert_eq!(human_bytes(1_234_000_000), "1.2 GB");
    }

    #[test]
    fn the_date_is_the_civil_calendars() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_742), "2026-10-16");
        assert_eq!(civil_date(11_016), "2000-02-29");
        assert_eq!(civil_date(-1), "1969-12-31");
    }

    #[cfg(unix)]
    #[test]
    fn a_folders_files_are_counted_once_and_links_are_not_followed() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("DCIM/100CANON")).unwrap();
        std::fs::write(
            dir.path().join("DCIM/100CANON/IMG_0001.JPG"),
            vec![0u8; 1000],
        )
        .unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hello").unwrap();
        std::os::unix::fs::symlink("/etc", dir.path().join("out")).unwrap();
        assert_eq!(tally(dir.path()).unwrap(), (1005, 2));
    }
}
