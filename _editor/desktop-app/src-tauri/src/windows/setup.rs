use super::{show_home_at, Keyboard, DEVICE_ROUTE, WORKSPACE};
use crate::commands::SetupReport;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/* An install runs for minutes, and the main window is deliberately minimisable and deliberately never topmost. */
pub fn alert_setup(app: &AppHandle) {
    // The keyboard only when the workspace is the window being read; a run that takes minutes must not pull the user
    // out of whatever they moved on to. Wrong here costs a focus, never a second window.
    let reading_workspace = crate::frame::shown() == Some(WORKSPACE)
        && crate::frame::frame(app).is_some_and(|frame| frame.is_visible().unwrap_or(false));
    let keyboard = if reading_workspace {
        Keyboard::Take
    } else {
        Keyboard::Leave
    };
    // The swap the setup arrived through, run again rather than a bare `show`: a run settling while the workspace
    // holds the frame has to end with one face up, and only the swap takes the other off screen.
    show_home_at(app, Some(DEVICE_ROUTE), keyboard);
    if let Some(frame) = crate::frame::frame(app) {
        let _ = frame.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

/* "Back to your workspace" hands the frame back to the SPA's setup page, and that page used to know nothing from then on: it sat on "Handed to the app. */
pub fn announce_setup(app: &AppHandle, report: &SetupReport) {
    if let Ok(mut told) = LAST_TOLD.lock() {
        *told = Some((report.clone(), Instant::now()));
    }
    keep_heartbeat(app);
    tell_workspace(app, report);
}

fn tell_workspace(app: &AppHandle, report: &SetupReport) {
    let Some(window) = crate::frame::face(app, WORKSPACE) else {
        return;
    };
    let _ = window.eval(setup_announcement(report));
}

/* THE HEARTBEAT, KEPT BY THE APP ITSELF (2026-10-12). This device's page sends its report again every few seconds while
 * a setup runs or waits (src/device/setup.ts `HEARTBEAT_MS`), and the workspace page reads a minute without one as the
 * app being gone. But that page is the main window's, which is hidden whenever the workspace holds the frame, and a
 * hidden page's timers are cut to one a minute after a few minutes: the very wait the heartbeat is for. So the app
 * repeats the last report itself, freshly stamped, whenever the page has been quiet for a beat. Only while it can vouch
 * for it: a running setup while its run is alive, a waiting one while the page has spoken in the last few minutes (a
 * throttled page still speaks once a minute, and a page that has said nothing for longer is not one to speak for). */

/// The last report the page sent, and when.
static LAST_TOLD: LazyLock<Mutex<Option<(SetupReport, Instant)>>> = LazyLock::new(Mutex::default);

static BEATING: AtomicBool = AtomicBool::new(false);

const HEARTBEAT_EVERY: Duration = Duration::from_secs(4);

/// How long the page's last word is repeated for while the page itself says nothing more.
const HEARTBEAT_TRUST: Duration = Duration::from_secs(180);

/// Whether the app repeats `told`, sent `ago`, now. Pure.
pub fn heartbeat_due(told: &SetupReport, ago: Duration, setup_running: bool) -> bool {
    if ago < HEARTBEAT_EVERY || ago >= HEARTBEAT_TRUST {
        return false;
    }
    match told.state.as_str() {
        "running" => setup_running,
        "waiting" => true,
        _ => false,
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as f64)
        .unwrap_or(0.0)
}

/// The thread that repeats the page's last report, started by the first one and kept for the life of the app.
fn keep_heartbeat(app: &AppHandle) {
    if BEATING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(HEARTBEAT_EVERY);
        let again = LAST_TOLD.lock().ok().and_then(|told| {
            let (report, at) = told.as_ref()?;
            heartbeat_due(
                report,
                at.elapsed(),
                crate::scripts::is_running(crate::commands::SETUP_RUN),
            )
            .then(|| SetupReport {
                at: Some(now_ms()),
                ..report.clone()
            })
        });
        if let Some(report) = again {
            tell_workspace(&app, &report);
        }
    });
}

/// The event as the page receives it. JSON is a JavaScript object literal since ES2019 (the two line
/// separators included), and serde escapes the quotes, so a sandbox named `"</script>` arrives as a name.
fn setup_announcement(report: &SetupReport) -> String {
    let detail = serde_json::to_string(report).unwrap_or_else(|_| "null".to_string());
    format!(
        "window.dispatchEvent(new CustomEvent('intentic-desktop-setup', {{ detail: {detail} }}));"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the workspace page receives: the event it listens for, carrying the report as one object. The
    /// name is the one value a user typed, and it arrives as a string however it was spelled.
    #[test]
    fn the_setup_announcement_is_one_event_carrying_the_report() {
        let script = setup_announcement(&SetupReport {
            name: Some("my \"site\" </script>".into()),
            state: "running".into(),
            percent: 42.5,
            position: Some("Step 4 of 10".into()),
            remaining: Some("about 3 min left".into()),
            step: Some("pulling-image".into()),
            ..SetupReport::default()
        });
        assert!(script.starts_with("window.dispatchEvent(new CustomEvent('intentic-desktop-setup'"));
        assert!(script.contains("\"percent\":42.5"), "{script}");
        assert!(script.contains("\"state\":\"running\""), "{script}");
        // The quotes inside the name are escaped, so the script is still one statement.
        assert!(script.contains("my \\\"site\\\" </script>"), "{script}");
    }

    /// A setup stopped on a question says which one, so the page can word a restart as a restart; a running one
    /// carries neither field rather than two nulls.
    #[test]
    fn a_waiting_setup_says_what_it_waits_for() {
        let waiting = setup_announcement(&SetupReport {
            name: None,
            state: "waiting".into(),
            percent: 10.0,
            position: None,
            remaining: None,
            step: None,
            waiting_for: Some("restart".into()),
            requirements: Some(vec!["pending-restart".into()]),
            ..SetupReport::default()
        });
        assert!(waiting.contains("\"waitingFor\":\"restart\""), "{waiting}");
        assert!(
            waiting.contains("\"requirements\":[\"pending-restart\"]"),
            "{waiting}"
        );
        let running = setup_announcement(&SetupReport {
            name: None,
            state: "running".into(),
            percent: 10.0,
            ..SetupReport::default()
        });
        assert!(!running.contains("waitingFor"), "{running}");
        // An older page reads none of the heartbeat's fields, and a report without them says nothing about them.
        for field in ["\"at\"", "downloaded", "downloadTotal", "remainingSeconds"] {
            assert!(!running.contains(field), "{running}");
        }
    }

    /// The heartbeat's report, as the app's window sends it (src/device/setup.ts) and the page reads it: when it was
    /// sent, the pull's bytes and the estimate in seconds, camelCase; and a setup parked for this PC's own setup.
    #[test]
    fn a_heartbeat_report_carries_when_it_was_sent_and_the_pulls_bytes() {
        let told: SetupReport = serde_json::from_str(
            r#"{"state":"running","percent":41,"step":"pulling-image","at":1760270400000,"downloaded":838860800,"downloadTotal":2306867200,"remainingSeconds":312}"#,
        )
        .unwrap();
        assert_eq!(told.at, Some(1_760_270_400_000.0));
        assert_eq!(told.downloaded, Some(838_860_800.0));
        assert_eq!(told.download_total, Some(2_306_867_200.0));
        assert_eq!(told.remaining_seconds, Some(312.0));
        let script = setup_announcement(&told);
        for field in [
            "\"at\":",
            "\"downloaded\":",
            "\"downloadTotal\":",
            "\"remainingSeconds\":",
        ] {
            assert!(script.contains(field), "{script}");
        }
        // A number with a fraction is still a report the page hears, not a refused command.
        let fractional: SetupReport =
            serde_json::from_str(r#"{"state":"running","percent":41.5,"remainingSeconds":12.5}"#)
                .unwrap();
        assert_eq!(fractional.remaining_seconds, Some(12.5));
        let parked: SetupReport = serde_json::from_str(
            r#"{"state":"waiting","percent":0,"waitingFor":"pcSetup","at":1}"#,
        )
        .unwrap();
        assert!(setup_announcement(&parked).contains("\"waitingFor\":\"pcSetup\""));
    }

    /// The app repeats the page's last report only in the page's silence, only for a setup it can vouch for, and not
    /// for ever.
    #[test]
    fn the_app_repeats_a_quiet_pages_report_only_while_it_can_vouch_for_it() {
        let report = |state: &str| SetupReport {
            state: state.into(),
            ..SetupReport::default()
        };
        let quiet = Duration::from_secs(30);
        assert!(heartbeat_due(&report("running"), quiet, true));
        // A run that is gone is not one to say is running.
        assert!(!heartbeat_due(&report("running"), quiet, false));
        assert!(heartbeat_due(&report("waiting"), quiet, false));
        for ended in ["done", "failed", "stopped", "closed"] {
            assert!(!heartbeat_due(&report(ended), quiet, true));
        }
        // The page spoke a moment ago: nothing to fill in.
        assert!(!heartbeat_due(
            &report("running"),
            Duration::from_secs(1),
            true
        ));
        // The page has said nothing for minutes: not a page to speak for.
        assert!(!heartbeat_due(&report("waiting"), HEARTBEAT_TRUST, false));
    }
}
