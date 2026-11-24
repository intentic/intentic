//! WSL ERRORS WITH A KNOWN WAY OUT (2026-11-21): the few codes WSL answers a start with whose cause lies outside WSL and
//! ic alike, each with the sentence that says what it is and what the person can do. Pure, so it is tested on every
//! platform although only Windows meets it.

/// What went wrong and what to do about it, for a WSL error `said` names; None for any other.
pub(super) fn known(said: &str) -> Option<(&'static str, &'static str)> {
    // WSAENOBUFS: Winsock out of buffers. WSL reports it as `Wsl/Service/0x80072747` (in the reader's own language
    // around it: "Kod błędu: Wsl/Service/0x80072747"), and it is a network driver's (a VPN's, a network filter's) doing.
    if said.to_ascii_lowercase().contains("0x80072747") {
        return Some((
            "Windows ran out of network buffers as WSL started (0x80072747, WSAENOBUFS), which a VPN's or a network filter's driver usually causes.",
            "open a terminal as administrator, run netsh winsock reset, restart the PC, then try again; if it comes back, update or turn off that VPN or network filter.",
        ));
    }
    None
}

/// WSL/guest errors left behind when the Windows drive ran out of space under the engine VHDX.
/// WSL's surrounding sentence is localized, so match stable syscall text and WSL error codes only.
pub(crate) fn broken_disk_attachment(said: &str) -> bool {
    let lower = said.to_ascii_lowercase();
    if lower.contains("createprocessparsecommon") && lower.contains("failed 5") {
        return true;
    }
    // The device letter is whatever WSL attached the disk as that boot (marta's engine was sdd, Docker Desktop's
    // went sdf → sdg across one reattach), so the kernel's lines are matched without it.
    let kernel = lower.contains("i/o error, dev sd")
        || (lower.contains("/dev/sd") && lower.contains("can't open blockdev"))
        || (lower.contains("mount(/dev/sd") && lower.contains("failed 6"));
    kernel
        || [
            "getpwnam(root) failed 5",
            "getpwuid(0) failed 5",
            "wsl/service/createinstance/e_fail",
        ]
        .iter()
        .any(|signature| lower.contains(signature))
}

/// Minimum Windows drive space needed to retry a damaged VHDX attachment safely: 5 GiB.
pub(crate) const MIN_RECOVERY_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

pub(crate) fn enough_recovery_space(free_bytes: Option<u64>) -> bool {
    free_bytes.is_some_and(|free| free >= MIN_RECOVERY_FREE_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winsock_out_of_buffers_is_named_with_its_way_out_in_any_language() {
        let (problem, fix) = known("Kod błędu: Wsl/Service/0x80072747").unwrap();
        assert!(problem.contains("WSAENOBUFS"));
        assert!(fix.contains("netsh winsock reset"));
        assert!(fix.contains("restart"));
        assert!(known("Error code: Wsl/Service/0x80072747").is_some());
        assert_eq!(known("failed to start daemon: x"), None);
    }

    #[test]
    fn recognizes_stuck_vhdx_attachment_signatures_independent_of_wsl_locale() {
        for said in [
            "getpwnam(root) failed 5",
            "CreateProcessParseCommon: ... failed 5",
            "I/O error, dev sdd, sector 12 op 0x0:(READ)",
            "/dev/sdd: Can't open blockdev",
            "I/O error, dev sdg, sector 259080 op 0x0:(READ)",
            "UtilMount:1863: mount(/dev/sde, /distro, ext4, 0x0, discard) failed 6",
            "Wsl/Service/CreateInstance/E_FAIL",
            "Kod błędu: Wsl/Service/CreateInstance/E_FAIL",
        ] {
            assert!(broken_disk_attachment(said), "{said}");
        }
        assert!(!broken_disk_attachment("Wsl/Service/WSAETIMEDOUT"));
        assert!(!broken_disk_attachment("getpwnam(root) failed 2"));
    }

    #[test]
    fn recovery_requires_at_least_five_gib_of_drive_space() {
        assert!(!enough_recovery_space(None));
        assert!(!enough_recovery_space(Some(MIN_RECOVERY_FREE_BYTES - 1)));
        assert!(enough_recovery_space(Some(MIN_RECOVERY_FREE_BYTES)));
    }
}
