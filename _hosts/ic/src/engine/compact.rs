//! Reclaim unused host space from the Intentic engine's dense WSL VHDX.

use serde::Serialize;

#[cfg(windows)]
use crate::docker::{self, Target};
use crate::util::{Fail, Result};

const GIB: u64 = 1024 * 1024 * 1024;
/// Avoid a disruptive compact when the guest has less than this much reclaimable space.
pub const MIN_RECLAIM_BYTES: u64 = 5 * GIB;

#[derive(Clone, Copy, Debug, Default)]
pub struct Args {
    pub yes: bool,
    pub force: bool,
    pub wsl: bool,
    pub json: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    ok: bool,
    skipped: bool,
    reason: Option<String>,
    guest_used_bytes: u64,
    estimated_reclaim_bytes: u64,
    before_vhdx_bytes: u64,
    after_vhdx_bytes: Option<u64>,
    before_drive_free_bytes: u64,
    after_drive_free_bytes: Option<u64>,
    drive: String,
}

/// Estimated free blocks that could be handed back by compaction, from the guest's used blocks and what the VHDX takes
/// on its drive (`host_disk::measure`: allocated clusters, so a sparse disk's holes do not count as reclaimable).
pub fn estimated_reclaim(vhdx_bytes: u64, guest_used_bytes: u64) -> u64 {
    vhdx_bytes.saturating_sub(guest_used_bytes)
}

/// Whether compaction is too small to justify stopping the engine. Pure.
pub fn skip_below_threshold(estimated_reclaim_bytes: u64, force: bool) -> bool {
    !force && estimated_reclaim_bytes < MIN_RECLAIM_BYTES
}

/// Diskpart's offline script. The read-only attach is required for compacting a WSL VHDX safely.
pub fn diskpart_script(vhdx_path: &str) -> String {
    format!(
        "select vdisk file=\"{vhdx_path}\"\r\nattach vdisk readonly\r\ncompact vdisk\r\ndetach vdisk\r\nexit\r\n"
    )
}

/// Whether diskpart reported that it compacted the selected VHDX. Pure; do not infer success from exit code alone.
pub fn diskpart_succeeded(output: &str) -> bool {
    output
        .to_ascii_lowercase()
        .contains("successfully compacted")
}

/// Guest bytes actually used from `df -Pk`'s Used column, rather than Available (which excludes ext4's root reserve).
pub fn parse_guest_used(df_output: &str) -> Option<u64> {
    df_output.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 {
            return None;
        }
        fields.get(2)?.parse::<u64>().ok()?.checked_mul(1024)
    })
}

pub fn run(args: Args) -> Result<()> {
    if args.json {
        crate::ui::send_human_to_stderr();
    }
    let result = run_inner(args);
    match result {
        Ok(report) => {
            if args.json {
                // allow(terminal-output): --json: one document for the machine agent.
                println!(
                    "{}",
                    serde_json::to_string(&report).unwrap_or_else(|_| "{}".into())
                );
            } else if report.skipped {
                crate::ui::quiet(
                    &report
                        .reason
                        .unwrap_or_else(|| "compaction skipped".to_string()),
                );
            } else {
                crate::ui::done(&format!(
                    "compacted the engine disk: {} → {}; {} drive free space → {}.",
                    crate::engine::disk::human(report.before_vhdx_bytes),
                    crate::engine::disk::human(
                        report.after_vhdx_bytes.unwrap_or(report.before_vhdx_bytes)
                    ),
                    crate::engine::disk::human(report.before_drive_free_bytes),
                    crate::engine::disk::human(
                        report
                            .after_drive_free_bytes
                            .unwrap_or(report.before_drive_free_bytes)
                    ),
                ));
            }
            Ok(())
        }
        Err(reason) => {
            if args.json {
                // allow(terminal-output): --json: failed operation is still one machine-readable document.
                println!("{}", serde_json::json!({ "ok": false, "error": reason.0 }));
            }
            Err(reason)
        }
    }
}

fn run_inner(args: Args) -> Result<Report> {
    #[cfg(windows)]
    {
        run_windows(args)
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        Err(Fail(
            "`ic engine compact` is available only on Windows.".to_string(),
        ))
    }
}

#[cfg(windows)]
fn run_windows(args: Args) -> Result<Report> {
    use std::time::Duration;

    use super::record::EngineRecord;
    use super::{host_disk, wsl, Kind};
    let record = EngineRecord::load()
        .filter(EngineRecord::is_ours)
        .ok_or_else(|| Fail("the intentic engine is not installed on this device.".to_string()))?;
    super::start().map_err(Fail)?;
    let target = Target::Intentic(
        super::reach().ok_or_else(|| Fail("the intentic engine is not reachable.".to_string()))?,
    );
    let before = host_disk::measure(Kind::Intentic).ok_or_else(|| {
        Fail("could not measure the intentic engine VHDX and its Windows drive.".to_string())
    })?;
    let guest_used = guest_used_reading(&record.distro)?;
    let estimated = estimated_reclaim(before.backing_bytes, guest_used);
    if skip_below_threshold(estimated, args.force) {
        return Ok(Report {
            ok: true,
            skipped: true,
            reason: Some(format!(
                "estimated reclaim is {}, below the {} minimum; pass --force to compact anyway.",
                crate::engine::disk::human(estimated),
                crate::engine::disk::human(MIN_RECLAIM_BYTES),
            )),
            guest_used_bytes: guest_used,
            estimated_reclaim_bytes: estimated,
            before_vhdx_bytes: before.backing_bytes,
            after_vhdx_bytes: None,
            before_drive_free_bytes: before.free_bytes,
            after_drive_free_bytes: None,
            drive: before.drive,
        });
    }

    let running = running_sandboxes(&target)?;
    let names = if running.is_empty() {
        "No Intentic sandboxes are running.".to_string()
    } else {
        format!("Running sandboxes: {}.", running.join(", "))
    };
    let consequence = format!(
        "The engine will stop while its VHDX is compacted; all workloads on it stop. {names} They should start again when the engine comes back."
    );
    if !crate::ui::confirm("Compact the intentic engine disk?", &consequence, args.yes)? {
        return Err(Fail(
            "compaction cancelled; the engine was not stopped.".to_string(),
        ));
    }

    crate::ui::note("trimming free blocks inside the running engine before compacting its VHDX.");
    fstrim(&record.distro)?;
    if let Err(stop) = super::stop() {
        return match super::start() {
            Ok(()) => Err(Fail(format!("could not stop the engine for compaction: {stop}"))),
            Err(start) => Err(Fail(format!(
                "could not stop the engine for compaction: {stop}. It could not be started again: {start}"
            ))),
        };
    }

    let compact_result = (|| -> std::result::Result<(), String> {
        if !vhdx_exclusively_openable(&before.backing_path) {
            if !args.wsl {
                return Err(format!(
                    "WSL still holds the engine VHDX at {}. Retry with `ic engine compact --wsl` to consent to `wsl --shutdown`; Docker Desktop and every other WSL distro restart too.",
                    before.backing_path
                ));
            }
            crate::ui::note("running `wsl --shutdown` because WSL still holds the VHDX; Docker Desktop and every other WSL distro restart too.");
            let (code, stdout, stderr) = wsl::run_wsl(&["--shutdown"], Duration::from_secs(120))?;
            if code != 0 {
                return Err(if stderr.trim().is_empty() {
                    stdout
                } else {
                    stderr
                });
            }
            if !vhdx_exclusively_openable(&before.backing_path) {
                return Err(format!(
                    "the engine VHDX at {} is still attached after `wsl --shutdown`; it was not compacted.",
                    before.backing_path
                ));
            }
        }
        crate::ui::note("Windows will show one administrator prompt to compact the VHDX. Windows Home does not include Optimize-VHD; ic uses DiskPart instead.");
        let (exit, output, log_path) = elevated_diskpart(&before.backing_path)?;
        if exit != 0 || !diskpart_succeeded(&output) {
            return Err(format!(
                "DiskPart did not report a successful compact (exit {exit}); see {}.",
                log_path.display()
            ));
        }
        Ok(())
    })();

    let start_result = super::start();
    match (compact_result, start_result) {
        (Err(compact), Err(start)) => {
            return Err(Fail(format!(
                "{compact} The engine could not be started again: {start}"
            )))
        }
        (Err(compact), Ok(())) => return Err(Fail(compact)),
        (Ok(()), Err(start)) => {
            return Err(Fail(format!(
                "the VHDX compacted, but the engine could not be started again: {start}"
            )))
        }
        (Ok(()), Ok(())) => {}
    }

    let after = host_disk::measure(Kind::Intentic).ok_or_else(|| {
        Fail(
            "the engine restarted, but its VHDX or Windows drive could not be measured afterward."
                .to_string(),
        )
    })?;
    Ok(Report {
        ok: true,
        skipped: false,
        reason: None,
        guest_used_bytes: guest_used,
        estimated_reclaim_bytes: estimated,
        before_vhdx_bytes: before.backing_bytes,
        after_vhdx_bytes: Some(after.backing_bytes),
        before_drive_free_bytes: before.free_bytes,
        after_drive_free_bytes: Some(after.free_bytes),
        drive: after.drive,
    })
}

#[cfg(windows)]
fn guest_used_reading(distro: &str) -> Result<u64> {
    use std::time::Duration;

    let (code, output, stderr) = super::wsl::run_wsl(
        &[
            "-d",
            distro,
            "-u",
            "root",
            "--exec",
            "df",
            "-Pk",
            super::disk::DATA_ROOT,
        ],
        Duration::from_secs(20),
    )
    .map_err(Fail)?;
    if code != 0 {
        return Err(Fail(if stderr.trim().is_empty() {
            output
        } else {
            stderr
        }));
    }
    parse_guest_used(&output).ok_or_else(|| {
        Fail("df in the running intentic engine returned an unreadable disk line.".to_string())
    })
}

#[cfg(windows)]
fn fstrim(distro: &str) -> Result<()> {
    use std::time::Duration;

    let (code, stdout, stderr) = super::wsl::run_wsl(
        &["-d", distro, "-u", "root", "--exec", "fstrim", "-v", "/"],
        Duration::from_secs(120),
    )
    .map_err(Fail)?;
    if code == 0 {
        crate::ui::detail(stdout.trim());
        Ok(())
    } else {
        Err(Fail(if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        }))
    }
}

#[cfg(windows)]
fn running_sandboxes(target: &Target) -> Result<Vec<String>> {
    let filter = format!("name=^{}", crate::sandbox::CONTAINER_PREFIX);
    let output = docker::capture_on(
        target,
        &["ps", "--filter", &filter, "--format", "{{.Names}}"],
        docker::READ_LIMIT,
    )
    .map_err(|Fail(reason)| Fail(format!("could not list the engine's sandboxes: {reason}")))?;
    if output.code != Some(0) {
        return Err(Fail(format!(
            "could not list the engine's sandboxes: {}",
            output.stderr.trim()
        )));
    }
    let names: Vec<String> = output.stdout.lines().map(str::to_string).collect();
    Ok(crate::sandbox::slugs_of(&names))
}

#[cfg(windows)]
fn vhdx_exclusively_openable(path: &str) -> bool {
    use std::os::windows::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
        .is_ok()
}

#[cfg(windows)]
fn elevated_diskpart(path: &str) -> std::result::Result<(u32, String, std::path::PathBuf), String> {
    use std::ffi::c_void;

    #[repr(C)]
    struct ShellExecuteInfoW {
        cb_size: u32,
        f_mask: u32,
        hwnd: *mut c_void,
        lp_verb: *const u16,
        lp_file: *const u16,
        lp_parameters: *const u16,
        lp_directory: *const u16,
        n_show: i32,
        h_inst_app: *mut c_void,
        lp_id_list: *mut c_void,
        lp_class: *const u16,
        hkey_class: *mut c_void,
        dw_hot_key: u32,
        h_icon_or_monitor: *mut c_void,
        h_process: *mut c_void,
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfoW) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    let dir = crate::logfile::log_dir();
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let log = crate::logfile::Log::create_named("engine-compact", "engine-compact")
        .map_err(|Fail(reason)| reason)?;
    let log_path = log.path.clone();
    drop(log);
    let mut script = tempfile::NamedTempFile::new_in(&dir).map_err(|error| error.to_string())?;
    use std::io::Write as _;
    script
        .write_all(diskpart_script(path).as_bytes())
        .map_err(|error| error.to_string())?;
    script.flush().map_err(|error| error.to_string())?;

    let diskpart = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string())
        + r"\System32\diskpart.exe";
    let command = format!(
        "/d /s /c \"\"{diskpart}\" /s \"{}\" > \"{}\" 2>&1\"",
        script.path().display(),
        log_path.display()
    );
    let cmd = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string())
        + r"\System32\cmd.exe";
    let wide = |value: &str| {
        value
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let verb = wide("runas");
    let file = wide(&cmd);
    let parameters = wide(&command);
    let mut info = ShellExecuteInfoW {
        cb_size: std::mem::size_of::<ShellExecuteInfoW>() as u32,
        f_mask: 0x0000_0040, // SEE_MASK_NOCLOSEPROCESS
        hwnd: std::ptr::null_mut(),
        lp_verb: verb.as_ptr(),
        lp_file: file.as_ptr(),
        lp_parameters: parameters.as_ptr(),
        lp_directory: std::ptr::null(),
        n_show: 0, // SW_HIDE; UAC still presents its one consent prompt.
        h_inst_app: std::ptr::null_mut(),
        lp_id_list: std::ptr::null_mut(),
        lp_class: std::ptr::null(),
        hkey_class: std::ptr::null_mut(),
        dw_hot_key: 0,
        h_icon_or_monitor: std::ptr::null_mut(),
        h_process: std::ptr::null_mut(),
    };
    // SAFETY: the structure and UTF-16 strings stay alive until ShellExecuteExW returns; runas returns a process
    // handle because SEE_MASK_NOCLOSEPROCESS is set.
    let launched = unsafe { ShellExecuteExW(&mut info) };
    if launched == 0 {
        let error = unsafe { GetLastError() };
        let _ = std::fs::remove_file(log_path.as_path());
        return Err(if error == 1223 {
            "administrator permission was declined; the VHDX was not compacted.".to_string()
        } else {
            format!("could not start elevated DiskPart (Windows error {error}).")
        });
    }
    let process = info.h_process;
    // SAFETY: ShellExecuteExW gave a valid process handle; wait for completion, then close it below.
    unsafe { WaitForSingleObject(process, u32::MAX) };
    let mut exit = 1u32;
    let got_exit = unsafe { GetExitCodeProcess(process, &mut exit) } != 0;
    unsafe { CloseHandle(process) };
    if !got_exit {
        return Err("could not read the elevated DiskPart process exit code.".to_string());
    }
    let output = std::fs::read_to_string(&log_path).unwrap_or_default();
    Ok((exit, output, log_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_skips_small_estimates_unless_forced() {
        assert!(skip_below_threshold(MIN_RECLAIM_BYTES - 1, false));
        assert!(!skip_below_threshold(MIN_RECLAIM_BYTES, false));
        assert!(!skip_below_threshold(0, true));
        assert_eq!(estimated_reclaim(400, 65), 335);
        assert_eq!(estimated_reclaim(65, 400), 0);
    }

    #[test]
    fn diskpart_script_selects_read_only_compaction_and_detaches() {
        assert_eq!(
            diskpart_script(r"C:\data\ext4.vhdx"),
            "select vdisk file=\"C:\\data\\ext4.vhdx\"\r\nattach vdisk readonly\r\ncompact vdisk\r\ndetach vdisk\r\nexit\r\n"
        );
    }

    #[test]
    fn success_requires_diskpart_compaction_confirmation() {
        assert!(diskpart_succeeded(
            "The virtual disk was successfully compacted."
        ));
        assert!(diskpart_succeeded("SUCCESSFULLY COMPACTED"));
        assert!(!diskpart_succeeded(
            "There is no need to compact the virtual disk."
        ));
    }

    #[test]
    fn guest_usage_uses_df_used_column_not_the_nonroot_available_count() {
        assert_eq!(
            parse_guest_used("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sdd 1000000 420000 530000 45% /var/lib/docker\n"),
            Some(420_000 * 1024)
        );
        assert_eq!(parse_guest_used("df returned no data"), None);
    }
}
