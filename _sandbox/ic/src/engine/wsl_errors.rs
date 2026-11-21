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

#[cfg(test)]
mod tests {
    use super::known;

    #[test]
    fn winsock_out_of_buffers_is_named_with_its_way_out_in_any_language() {
        let (problem, fix) = known("Kod błędu: Wsl/Service/0x80072747").unwrap();
        assert!(problem.contains("WSAENOBUFS"));
        assert!(fix.contains("netsh winsock reset"));
        assert!(fix.contains("restart"));
        assert!(known("Error code: Wsl/Service/0x80072747").is_some());
        assert_eq!(known("failed to start daemon: x"), None);
    }
}
