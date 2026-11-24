//! Windows host storage behind dynamically growing engine disks. The sandbox reads these hints to avoid trusting
//! ext4's free-space view when the Windows drive holding its VHDX is the tighter limit.

#[cfg(windows)]
use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDisk {
    pub drive: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
    pub backing_path: String,
    /// What the VHDX takes on the drive: its allocated clusters, not its length ([`allocated_bytes`]).
    pub backing_bytes: u64,
}

#[cfg(windows)]
pub fn measure(engine: super::Kind) -> Option<HostDisk> {
    let backing = backing_path(engine)?;
    let length = std::fs::metadata(&backing).ok()?.len();
    let backing_bytes = allocated_bytes(&backing).unwrap_or(length);
    let text = backing.to_string_lossy();
    let drive = drive_of(&text)?;
    let (free_bytes, total_bytes) = drive_space(&drive)?;
    Some(HostDisk {
        drive,
        free_bytes,
        total_bytes,
        backing_path: text.into_owned(),
        backing_bytes,
    })
}

#[cfg(not(windows))]
pub fn measure(_engine: super::Kind) -> Option<HostDisk> {
    None
}

#[cfg(windows)]
fn backing_path(engine: super::Kind) -> Option<PathBuf> {
    match engine {
        super::Kind::Intentic => {
            let record = super::EngineRecord::load()?;
            super::paths::wsl_store_for(&record.distro).map(|store| store.join("ext4.vhdx"))
        }
        super::Kind::DockerDesktop => {
            let local = std::env::var_os("LOCALAPPDATA").filter(|s| !s.is_empty())?;
            [
                PathBuf::from(local.clone()).join("Docker/wsl/disk/docker_data.vhdx"),
                PathBuf::from(local).join("Docker/wsl/data/ext4.vhdx"),
            ]
            .into_iter()
            .find(|path| path.is_file())
        }
        super::Kind::Native => None,
    }
}

/// WHAT THE BACKING FILE TAKES ON ITS DRIVE (2026-11-24), which is the room the guest can refill without the drive
/// giving more. A sparse VHDX's length counts its holes: on omen Docker Desktop's `docker_data.vhdx` was 379 GiB long
/// with 240 GiB allocated and 202 GiB used inside, so the length put 262 GiB within reach where C: had 136 GiB free.
/// For a dense file this is its length. None when Windows would not say, which leaves the caller with the length.
#[cfg(windows)]
fn allocated_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt as _;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCompressedFileSizeW(name: *const u16, high: *mut u32) -> u32;
        fn SetLastError(code: u32);
        fn GetLastError() -> u32;
    }
    const INVALID_FILE_SIZE: u32 = u32::MAX;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut high = 0u32;
    // SAFETY: the path is NUL-terminated UTF-16 and `high` is a writable local. A low word of INVALID_FILE_SIZE is
    // also a real size, so the error is cleared first and only a set one means failure.
    let low = unsafe {
        SetLastError(0);
        GetCompressedFileSizeW(wide.as_ptr(), &mut high)
    };
    if low == INVALID_FILE_SIZE && unsafe { GetLastError() } != 0 {
        return None;
    }
    Some((u64::from(high) << 32) | u64::from(low))
}

#[cfg(windows)]
fn drive_space(drive: &str) -> Option<(u64, u64)> {
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = drive.encode_utf16().chain(std::iter::once(0)).collect();
    let (mut available, mut total, mut free) = (0, 0, 0);
    // SAFETY: the drive is a NUL-terminated Windows root and all pointers refer to writable locals.
    (unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) } != 0)
        .then_some((available, total))
}

/// Refreshes every known Windows engine hint. A failed write only leaves the sandbox with its guest-side reading.
#[cfg(windows)]
pub fn refresh_hints() {
    if let Some(home) = super::paths::home() {
        if let Err(error) = std::fs::create_dir_all(home.join(".intentic").join("host")) {
            crate::ui::note(&format!(
                "could not create the Windows host disk hint directory: {error}"
            ));
        }
    }
    for engine in [super::Kind::Intentic, super::Kind::DockerDesktop] {
        if let Some(disk) = measure(engine) {
            if let Err(error) = write_hint(engine, &disk) {
                crate::ui::note(&format!(
                    "could not update the {} host disk hint: {error}",
                    engine.id()
                ));
            }
        }
    }
}

#[cfg(not(windows))]
pub fn refresh_hints() {}

#[cfg(windows)]
fn write_hint(engine: super::Kind, disk: &HostDisk) -> std::result::Result<(), String> {
    use std::io::Write as _;
    let home = super::paths::home().ok_or("USERPROFILE is not set")?;
    let dir = home.join(".intentic").join("host");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("disk-{}.json", engine.id()));
    let at = crate::sandbox::now_ms();
    let body = serde_json::to_vec(&serde_json::json!({
        "v": 1,
        "at": at,
        "engine": engine.id(),
        "drive": disk.drive,
        "driveFreeBytes": disk.free_bytes,
        "driveTotalBytes": disk.total_bytes,
        "backingPath": disk.backing_path,
        "backingBytes": disk.backing_bytes,
    }))
    .map_err(|error| error.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|error| error.to_string())?;
    temp.write_all(&body).map_err(|error| error.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temp.persist(&path)
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

/// The bind mount needed by sandbox containers. Docker Desktop accepts Windows paths; the intentic engine reads them
/// through WSL's `/mnt/<drive>` mount, as `docker::bind_source` formats them.
pub fn mount_args() -> Vec<String> {
    #[cfg(windows)]
    {
        let Some(home) = super::paths::home() else {
            return Vec::new();
        };
        let dir = home.join(".intentic").join("host");
        if let Some(source) = crate::docker::bind_source(&dir) {
            return vec!["-v".into(), format!("{source}:/run/intentic/host:ro")];
        }
    }
    Vec::new()
}

pub fn mount_spec() -> Option<String> {
    let args = mount_args();
    args.get(1).cloned()
}

/// The drive root (`C:\`) a local path lives on. WSL records some distros' folders in the extended form
/// (`\\?\C:\Users\…`, Docker Desktop's on marta), which the first three characters would read as `\\?`. Pure.
pub fn drive_of(path: &str) -> Option<String> {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let bytes = path.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        .then(|| format!("{}:\\", char::from(bytes[0]).to_ascii_uppercase()))
}

/// Apply the drive cap to df's non-root Available count. 2026-11-22: Marta's 1 TB ext4 disk was 376 GB used with
/// 18.5 GB left on C: and a 376 GB dense VHDX; guest statfs claimed hundreds of GB, but the effective limit was 18.5 GB.
pub fn effective(raw_total: u64, raw_available: u64, host: Option<&HostDisk>) -> (u64, u64, bool) {
    let Some(host) = host else {
        return (raw_total, raw_available, false);
    };
    let used = raw_total.saturating_sub(raw_available);
    let host_room = host
        .free_bytes
        .saturating_add(host.backing_bytes.saturating_sub(used));
    let available = raw_available.min(host_room);
    let limited_by_drive = host_room < raw_available;
    let total = if limited_by_drive {
        used.saturating_add(available)
    } else {
        raw_total
    };
    (total, available, limited_by_drive)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn a_dense_backing_disk_is_capped_by_the_remaining_windows_drive_space() {
        let host = HostDisk {
            drive: "C:\\".into(),
            free_bytes: 18_500_000_000,
            total_bytes: 1_000_000_000_000,
            backing_path: r"C:\Users\me\AppData\Local\Intentic\engine\ext4.vhdx".into(),
            backing_bytes: 376_000_000_000,
        };
        let (total, available, drive_limited) =
            effective(1_000_000_000_000, 624_000_000_000, Some(&host));
        assert_eq!(available, 18_500_000_000);
        assert_eq!(total, 394_500_000_000);
        assert!(drive_limited);
        let reading = super::super::disk::Reading {
            total_bytes: total,
            available_bytes: available,
            free_bytes: available,
            ballast_bytes: 0,
            disk_total_bytes: 1_000_000_000_000,
            disk_available_bytes: 624_000_000_000,
            limited_by_drive: true,
        };
        assert_eq!(
            super::super::disk::level(&reading),
            super::super::disk::Level::Critical
        );
    }

    #[test]
    fn the_drive_is_read_off_plain_and_extended_paths() {
        assert_eq!(
            drive_of(r"C:\Users\me\engine\ext4.vhdx").as_deref(),
            Some(r"C:\")
        );
        assert_eq!(drive_of(r"\\?\d:\wsl\ext4.vhdx").as_deref(), Some(r"D:\"));
        assert_eq!(drive_of(r"\\server\share\ext4.vhdx"), None);
    }

    #[test]
    fn reusing_allocated_vhdx_space_is_accounted_before_drive_growth() {
        let host = HostDisk {
            drive: "C:\\".into(),
            free_bytes: 18 * GIB,
            total_bytes: 1_000 * GIB,
            backing_path: "C:\\disk.vhdx".into(),
            backing_bytes: 376 * GIB,
        };
        let (total, available, limited) = effective(1_000 * GIB, 700 * GIB, Some(&host));
        assert_eq!(available, 94 * GIB);
        assert_eq!(total, 394 * GIB);
        assert!(limited);
    }

    #[test]
    fn a_sparse_disk_allocated_below_its_use_leaves_only_the_drive_free_space() {
        // omen, 2026-11-24: 240 GiB allocated of a 379 GiB long docker_data.vhdx, 253 GiB used by df's non-root count.
        let host = HostDisk {
            drive: "C:\\".into(),
            free_bytes: 136 * GIB,
            total_bytes: 951 * GIB,
            backing_path: "C:\\docker_data.vhdx".into(),
            backing_bytes: 240 * GIB,
        };
        let (total, available, limited) = effective(1_007 * GIB, 754 * GIB, Some(&host));
        assert_eq!(available, 136 * GIB);
        assert_eq!(total, 389 * GIB);
        assert!(limited);
    }

    #[cfg(windows)]
    #[test]
    fn a_written_file_is_allocated_its_length_and_a_missing_one_says_nothing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("dense.bin");
        std::fs::write(&path, vec![7u8; 1 << 20]).expect("write");
        assert_eq!(allocated_bytes(&path), Some(1 << 20));
        assert_eq!(allocated_bytes(&dir.path().join("absent.bin")), None);
    }
}
