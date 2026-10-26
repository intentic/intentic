/* Chrome 142 made a request from a public origin to loopback a permission, collected with a dialog about "devices on your local network". */
pub(super) const BROWSER_ARGS: &str = concat!(
    "--disable-features=",
    "msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
    // Fetch, subresources and subframes — the /health probe and every daemon call after it.
    "LocalNetworkAccessChecks,",
    // Terminals and the browser view hold WebSockets on that same address (terminalSession.ts,
    // useBrowserView.ts); Chrome 147 brought them under the same permission.
    "LocalNetworkAccessChecksWebSockets,",
    "LocalNetworkAccessChecksWebTransport",
    // The wake word (wake.rs): the workspace's page listens through an AudioContext, which Chromium keeps suspended
    // until somebody clicks in the page. A page reloaded in a window hidden in the tray, or loaded there at launch, has
    // nobody to click, so it could not listen again until the reader opened the window. This is wry's own flag for
    // `autoplay`, which our arguments replace; it reaches every window of the app, since every webview sharing the
    // profile must be built with the same arguments, so a video in a document a local window opens may play by itself.
    " --autoplay-policy=no-user-gesture-required"
);

/// Advertises desktop/window capabilities without exposing IPC; handoffs use intercepted intentic:// links.
/// installId is a non-secret analytics id; update seeds pages loaded after the download event. frameless requests page-drawn controls.
/// Gate projectSync and sandboxWakes links on build support to avoid unsafe older behavior; notices enables native notifications/badges.
/// processes says this build keeps one list of its processes for both faces and takes answers to them from the page
/// (processes.rs): the page listens for it and answers a run where it is drawn, never sending the reader to This computer.
/// loopbackUngated describes browser behavior, not permission. wake is true only for the microphone-enabled workspace window.
/// machineFace is true only for the workspace window, on a build that ships the face (machine_face.rs `FACE_BUILT`) and a
/// computer that hosts sandboxes: the hosted page then offers this computer's sandboxes when it cannot reach the platform,
/// through `intentic://machine-face` (setup_link.rs), which only the workspace window is heard on.
pub(super) fn workspace_init_script(
    install_id: &str,
    update: Option<&str>,
    wake: bool,
    machine_face: bool,
) -> String {
    let update = match update {
        Some(version) => format!("\"{}\"", crate::update::escape_js(version)),
        None => "null".to_string(),
    };
    format!(
        "{}(function () {{ if (!window.__INTENTIC_DESKTOP__) {{ window.__INTENTIC_DESKTOP__ = Object.freeze({{ version: \"{}\", installId: \"{install_id}\", update: {update}, loopbackUngated: true, frameless: true, projectSync: true, notices: true, nativeCopy: {}, wake: {wake}, sandboxWakes: true, processes: true, machineFace: {machine_face} }}); }} }})();",
        launch_id_script(),
        crate::commands::VERSION,
        // Only where the page's message reaches drop_copy.rs: WebView2 is what says where a dropped file is.
        cfg!(windows)
    )
}

/// This process's launch (launch.rs `id`), told to every page the app builds, so a page's own analytics can name the
/// process that showed it.
pub(super) fn launch_id_script() -> String {
    format!(
        "window.__INTENTIC_LAUNCH_ID__ = \"{}\";",
        crate::launch::id()
    )
}

/// The downloaded update a window of the page is told of (`update` above): the workspace's and its floating panels',
/// whose banner offers it. A local window is told of none and draws no banner: the app's own version is the
/// workspace's to offer, and a banner over somebody's document offering a restart is one more way to lose what they
/// typed.
pub(super) fn update_told(stage: &crate::update::Stage, local: bool) -> Option<&str> {
    if local {
        return None;
    }
    stage.ready_version()
}

/// What the workspace page registers to be told a path without a reload (the web's desktop.ts
/// `installDesktopOpener`).
const PAGE_OPENER: &str = "__INTENTIC_OPEN__";

/// The script that takes a loaded workspace page to `path`: through the page's own opener, which routes in place and
/// selects a sandbox the path names, when the page is the workspace's and has one; otherwise by loading `target`, as
/// every app did before the opener existed, so a page older than this app (or one still loading) is never left where
/// it was. Each value rides as a JSON string, which is a JavaScript string literal, so a path cannot end the statement.
pub(super) fn open_in_place(origin: &str, path: &str, target: &str) -> String {
    let literal = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(() => {{ const open = window.{PAGE_OPENER}; if (location.origin === {origin} && typeof open === 'function') {{ open({path}); }} else {{ location.href = {target}; }} }})();",
        origin = literal(origin),
        path = literal(path),
        target = literal(target),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_page_gets_the_process_launch_id() {
        let script = workspace_init_script("install-1", None, true, false);
        assert!(script.contains(&format!(
            "window.__INTENTIC_LAUNCH_ID__ = \"{}\"",
            crate::launch::id()
        )));
    }

    /// Setting our own arguments replaces wry's default rather than adding to it, and Chromium reads only the
    /// last `--disable-features` — so one list, holding wry's three as well as ours.
    #[test]
    fn the_browser_arguments_keep_wrys_own_defaults() {
        assert_eq!(BROWSER_ARGS.matches("--disable-features=").count(), 1);
        for feature in ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"] {
            assert!(BROWSER_ARGS.contains(feature), "dropped {feature}");
        }
    }

    /// Every transport the SPA takes to the daemon on this machine: fetch for the probe and the calls,
    /// WebSockets for terminals and the browser view.
    #[test]
    fn the_browser_arguments_disable_every_local_network_check_we_meet() {
        for feature in [
            "LocalNetworkAccessChecks",
            "LocalNetworkAccessChecksWebSockets",
            "LocalNetworkAccessChecksWebTransport",
        ] {
            assert!(BROWSER_ARGS.contains(feature), "still gated: {feature}");
        }
    }

    /// And the page is told, because it skips its own card on the strength of this word alone
    /// (loopbackPermission.ts). A build that disables the check without saying so costs the user a dialog with
    /// nothing on screen to explain it; one that says so without disabling it costs them the same dialog.
    #[test]
    fn the_page_is_told_the_reach_is_ungated() {
        let script = workspace_init_script("install-1", None, true, false);
        assert!(script.contains("loopbackUngated: true"), "{script}");
    }

    /// Cargo's package stays at 0.0.0; build.rs stamps the version shipped in the bundle. The restarted workspace
    /// reports that version so the updater smoke can distinguish it from the old window still being on screen.
    #[test]
    fn the_workspace_reports_the_stamped_release_version() {
        let script = workspace_init_script("install-1", None, true, false);
        assert!(
            script.contains(&format!("version: \"{}\"", crate::commands::VERSION)),
            "{script}"
        );
    }

    /* THE OTHER PAIR THAT HAS TO STAY A PAIR: this window opens with no platform frame, and the page is told so. */
    #[test]
    fn the_page_is_told_the_window_has_no_frame_of_its_own() {
        let script = workspace_init_script("install-1", None, true, false);
        assert!(script.contains("frameless: true"), "{script}");
    }

    /// The web hands a folder to a hosted machine only on this word (setup's `desktopTakesProjects`): a build
    /// that parses `project=` on a sync link says so, and one that doesn't never reaches that lane.
    #[test]
    fn the_page_is_told_this_build_copies_a_folder_into_its_project() {
        let script = workspace_init_script("install-1", None, true, false);
        assert!(script.contains("projectSync: true"), "{script}");
    }

    /// The page hands a big drop to the app (drop_copy.rs) only on this word, and only Windows' WebView2 says where a
    /// dropped file is: a build anywhere else must not invite a message nothing will answer.
    #[test]
    fn the_page_is_told_whether_this_build_copies_a_drop_itself() {
        let script = workspace_init_script("install-1", None, true, false);
        assert!(
            script.contains(&format!("nativeCopy: {}", cfg!(windows))),
            "{script}"
        );
    }

    /// The hosted page offers this computer's sandboxes, and sends `intentic://machine-face`, only on this word: told to
    /// the workspace window of a computer that hosts sandboxes, on a build that ships the face, and to nothing else.
    #[test]
    fn the_page_is_told_whether_this_computers_sandboxes_can_open_here() {
        assert!(workspace_init_script("install-1", None, true, true).contains("machineFace: true"));
        assert!(
            workspace_init_script("install-1", None, true, false).contains("machineFace: false")
        );
    }

    /// The page offers the app's notifications in its settings, and sends them, only on this word (desktop.ts
    /// `desktopNotices`): a build that hears `notice` and `badge` says so.
    #[test]
    fn the_page_is_told_this_build_puts_up_notifications() {
        let script = workspace_init_script("install-1", None, true, false);
        assert!(script.contains("notices: true"), "{script}");
    }

    /// The page sends `intentic://sandbox-wakes` only to a build that says it starts a sleeping sandbox on that link
    /// (`desktopSandboxWakes` in the SPA): an older one would drop it, and the keeper's poll would be the only wake.
    #[test]
    fn the_page_is_told_this_build_wakes_a_sleeping_sandbox_at_once() {
        let script = workspace_init_script("install-1", None, false, false);
        assert!(script.contains("sandboxWakes: true"), "{script}");
    }

    /// The page follows and answers the app's processes only where the app says it keeps them (processes.rs): an older
    /// one would drop its hello and its answers, and the page keeps sending the reader to This computer's card instead.
    #[test]
    fn the_page_is_told_this_build_keeps_its_processes_for_it() {
        let script = workspace_init_script("install-1", None, false, false);
        assert!(script.contains("processes: true"), "{script}");
    }

    /// The page listens for its wake word in the app only where the app gave it a microphone and a tray to say so:
    /// the workspace face, never a floating panel or a local window.
    #[test]
    fn only_the_workspace_face_is_told_it_may_listen_for_its_wake_word() {
        assert!(workspace_init_script("install-1", None, true, false).contains("wake: true"));
        assert!(workspace_init_script("install-1", None, false, false).contains("wake: false"));
    }

    /// The page's AudioContext resumes with nobody there to click (wake.rs), and the flag rides beside the one list of
    /// disabled features rather than inside it.
    #[test]
    fn the_browser_arguments_let_a_page_in_the_tray_start_its_audio() {
        assert!(
            BROWSER_ARGS.contains(" --autoplay-policy=no-user-gesture-required"),
            "{BROWSER_ARGS}"
        );
        assert!(BROWSER_ARGS.starts_with("--disable-features="));
        assert!(!BROWSER_ARGS
            .split(' ')
            .next()
            .unwrap_or_default()
            .contains("autoplay"));
    }

    /// A local window draws no update banner: the choice `show_files_window` makes names no downloaded version,
    /// where the workspace's names the one that is ready.
    #[test]
    fn a_local_window_is_told_of_no_update() {
        let ready = crate::update::Stage::Ready {
            version: "9.9.9".into(),
        };
        assert_eq!(update_told(&ready, true), None);
        assert_eq!(update_told(&ready, false), Some("9.9.9"));
        assert!(
            workspace_init_script("install-1", update_told(&ready, true), false, false)
                .contains("update: null")
        );
        assert!(
            workspace_init_script("install-1", update_told(&ready, false), true, false)
                .contains("update: \"9.9.9\"")
        );
        assert_eq!(update_told(&crate::update::Stage::Current, false), None);
    }

    /// A loaded workspace is told the path through its own opener, and falls back to loading the address; the path
    /// arrives as one string however it is spelled.
    #[test]
    fn a_loaded_workspace_is_told_the_path_and_loads_it_only_without_an_opener() {
        let script = open_in_place(
            "https://app.intentic.dev",
            "/?sandbox=a\"b');x",
            "https://app.intentic.dev/?sandbox=a\"b');x",
        );
        assert_eq!(
            script,
            "(() => { const open = window.__INTENTIC_OPEN__; if (location.origin === \"https://app.intentic.dev\" && typeof open === 'function') { open(\"/?sandbox=a\\\"b');x\"); } else { location.href = \"https://app.intentic.dev/?sandbox=a\\\"b');x\"; } })();"
        );
    }
}
