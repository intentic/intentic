// Pure on purpose: the code that runs these is Windows-only, the sentences it shows are tested on every runner.
#![cfg_attr(not(windows), allow(dead_code))]

/* WHAT A LONG, QUIET FIX SAYS WHILE IT WORKS — so a row that is busy never reads like a row that is stuck. */

// A reported setup sat on "installing Docker Desktop (about 600 MB)..." for minutes with nothing else on the
// screen: the download, the Windows permission prompt and Docker's own installer were all one silent wait, and
// nothing told a person whether the setup was working or waiting on them. Each of those three now says what it
// is doing, once a second, with a clock that moves.

use std::time::Duration;

/// What a row says while Windows' permission prompt is up and unanswered. A prompt opened by a process that
/// does not own the foreground (a setup resumed by itself after a restart, say) does not come up in front: it
/// waits as a flashing shield on the taskbar, and that is the one thing a person cannot guess.
pub fn asking(waited: Duration) -> String {
    format!(
        "Windows is asking for permission: choose Yes in its prompt. Don't see it? Look for a flashing shield on the taskbar. Waiting {}.",
        clock(waited)
    )
}

/// A row that is past the prompt and working: what it is doing, and for how long. `stage` is the work's own
/// account of where it is, when it gives one.
pub fn working(what: &str, stage: Option<&str>, elapsed: Duration) -> String {
    match stage {
        Some(stage) => format!("{what}: {stage}. {} so far.", clock(elapsed)),
        None => format!("{what}. {} so far.", clock(elapsed)),
    }
}

/// `0:07`, `4:32`, `1:02:09`: a clock, because a number that visibly ticks is the whole point.
pub fn clock(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    let (hours, minutes, seconds) = (seconds / 3600, (seconds / 60) % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

const MB: u64 = 1024 * 1024;

/// One reading of the Docker Desktop download: how much, out of what, how fast, and how long is left. The
/// rate and the estimate are only given once there is enough of a run to measure; a guess in the first
/// second swings by minutes.
#[cfg(test)]
pub fn download(written: u64, total: u64, elapsed: Duration) -> String {
    download_resumed(written, total, elapsed, 0)
}

/// [`download`], for a download that picked up `from` bytes an earlier run left: they count towards how far it is, and
/// not towards how fast, or a resumed download would claim a rate the line never had.
pub fn download_resumed(written: u64, total: u64, elapsed: Duration, from: u64) -> String {
    let done = written / MB;
    let fresh = written.saturating_sub(from);
    let measured = elapsed >= Duration::from_secs(2) && fresh > 0;
    let rate = if measured {
        fresh as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };
    let mut line = if total > 0 {
        let percent = percent(written, total).unwrap_or(0);
        format!(
            "Downloading Docker Desktop: {done} of {} MB ({percent}%)",
            total / MB
        )
    } else {
        format!("Downloading Docker Desktop: {done} MB")
    };
    if measured {
        line.push_str(&format!(" at {:.1} MB/s", rate / MB as f64));
        if total > written {
            let left = (total - written) as f64 / rate;
            line.push_str(&format!(", {}", time_left(Duration::from_secs_f64(left))));
        }
    }
    line.push('.');
    line
}

/// How far through, for a bar to draw; `None` without a size, where a bar would have nothing to fill towards.
pub fn percent(written: u64, total: u64) -> Option<u64> {
    (total > 0).then(|| (written.saturating_mul(100) / total).min(100))
}

fn time_left(left: Duration) -> String {
    let seconds = left.as_secs();
    if seconds < 60 {
        "less than a minute left".to_string()
    } else {
        let minutes = (seconds + 30) / 60;
        if minutes == 1 {
            "about 1 minute left".to_string()
        } else {
            format!("about {minutes} minutes left")
        }
    }
}

/// Where Docker Desktop's own installer writes, and where it says which phase it is in (`[InstallWorkflow][I] Phase 1:
/// Staging`): the all-users install's file under ProgramData, and the per-user install's under the account's
/// LOCALAPPDATA. Read, never written; an older file is the last install's, so the caller only believes one written
/// since its own run began, and the newest of those.
pub fn docker_install_logs(
    local_app_data: Option<&str>,
    program_data: Option<&str>,
) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(local) = local_app_data.filter(|base| !base.is_empty()) {
        let local = local.trim_end_matches('\\');
        for file in [
            "Docker\\install-log.txt",
            "Docker\\install-log-user.txt",
            "DockerDesktop\\install-log.txt",
            "DockerDesktop\\install-log-user.txt",
        ] {
            paths.push(format!("{local}\\{file}"));
        }
    }
    let program_data = program_data
        .filter(|base| !base.is_empty())
        .unwrap_or("C:\\ProgramData")
        .trim_end_matches('\\');
    paths.push(format!(
        "{program_data}\\DockerDesktop\\install-log-admin.txt"
    ));
    paths
}

/// The phase Docker's installer last reported, in a reader's words. `None` when the log names none: the row
/// then says what it is doing without a stage, rather than inventing one.
pub fn docker_stage(log: &str) -> Option<String> {
    let line = log.lines().rev().find(|line| {
        line.contains("[InstallWorkflow]")
            && (line.contains("] Phase ") || line.contains("Installation succeeded"))
    })?;
    if line.contains("Installation succeeded") {
        return Some("finishing up".to_string());
    }
    let name = line.split("] Phase ").nth(1)?.split_once(": ")?.1.trim();
    let lower = name.to_ascii_lowercase();
    // Docker's phase names, as its 4.8x and 4.9x installers write them, in the order they come. A name not on
    // this list is still shown, as Docker wrote it: a newer installer is not a reason to go quiet.
    let known = [
        ("pre-check", "checking this PC"),
        ("staging", "copying Docker's files"),
        ("teardown", "stopping the old version"),
        ("backup", "setting the old version aside"),
        ("activation", "putting the new files in place"),
        ("components", "setting up Docker's components"),
        ("validation", "checking the installation"),
        ("cleanup", "cleaning up"),
    ];
    Some(
        known
            .iter()
            .find(|(phase, _)| lower.starts_with(phase))
            .map(|(_, said)| (*said).to_string())
            .unwrap_or(lower),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_ticks_in_minutes_and_seconds() {
        assert_eq!(clock(Duration::from_secs(0)), "0:00");
        assert_eq!(clock(Duration::from_secs(7)), "0:07");
        assert_eq!(clock(Duration::from_secs(272)), "4:32");
        assert_eq!(clock(Duration::from_secs(3729)), "1:02:09");
    }

    #[test]
    fn a_download_reading_says_how_much_how_fast_and_how_long() {
        let line = download(212 * MB, 598 * MB, Duration::from_secs(40));
        assert_eq!(
            line,
            "Downloading Docker Desktop: 212 of 598 MB (35%) at 5.3 MB/s, about 1 minute left."
        );
        // Slow connections get minutes, rounded rather than truncated.
        let slow = download(50 * MB, 600 * MB, Duration::from_secs(100));
        assert!(slow.ends_with("about 18 minutes left."), "{slow}");
        // The last stretch does not count down seconds at somebody.
        let nearly = download(590 * MB, 600 * MB, Duration::from_secs(60));
        assert!(nearly.ends_with("less than a minute left."), "{nearly}");
    }

    #[test]
    fn the_first_second_of_a_download_makes_no_promises() {
        let line = download(3 * MB, 600 * MB, Duration::from_millis(900));
        assert_eq!(line, "Downloading Docker Desktop: 3 of 600 MB (0%).");
    }

    /// A download resumed after a restart counts what it had towards the bar, and only what it fetched towards the rate.
    #[test]
    fn a_resumed_download_does_not_count_its_old_bytes_as_speed() {
        let line = download_resumed(400 * MB, 600 * MB, Duration::from_secs(20), 300 * MB);
        assert_eq!(
            line,
            "Downloading Docker Desktop: 400 of 600 MB (66%) at 5.0 MB/s, less than a minute left."
        );
        assert_eq!(
            download_resumed(300 * MB, 600 * MB, Duration::from_secs(20), 300 * MB),
            "Downloading Docker Desktop: 300 of 600 MB (50%)."
        );
    }

    #[test]
    fn the_install_log_is_looked_for_where_either_kind_of_install_writes_it() {
        let paths = docker_install_logs(Some("C:\\Users\\radar\\AppData\\Local\\"), None);
        assert!(
            paths
                .contains(&"C:\\Users\\radar\\AppData\\Local\\Docker\\install-log.txt".to_string()),
            "{paths:?}"
        );
        assert_eq!(
            paths.last().map(String::as_str),
            Some("C:\\ProgramData\\DockerDesktop\\install-log-admin.txt")
        );
        assert_eq!(
            docker_install_logs(None, Some("D:\\PD")),
            vec!["D:\\PD\\DockerDesktop\\install-log-admin.txt".to_string()]
        );
    }

    #[test]
    fn a_download_without_a_size_still_counts_up() {
        let line = download(40 * MB, 0, Duration::from_secs(10));
        assert_eq!(line, "Downloading Docker Desktop: 40 MB at 4.0 MB/s.");
    }

    #[test]
    fn the_bar_fills_only_towards_a_known_size() {
        assert_eq!(percent(0, 600 * MB), Some(0));
        assert_eq!(percent(300 * MB, 600 * MB), Some(50));
        assert_eq!(
            percent(700 * MB, 600 * MB),
            Some(100),
            "a server that undercounts does not overflow the bar"
        );
        assert_eq!(percent(40 * MB, 0), None);
    }

    #[test]
    fn waiting_on_the_prompt_says_where_the_prompt_may_be() {
        let line = asking(Duration::from_secs(42));
        assert!(line.contains("choose Yes"), "{line}");
        assert!(line.contains("shield on the taskbar"), "{line}");
        assert!(line.ends_with("Waiting 0:42."), "{line}");
    }

    #[test]
    fn a_working_row_carries_its_stage_when_there_is_one() {
        assert_eq!(
            working(
                "Installing Docker Desktop",
                Some("copying Docker's files"),
                Duration::from_secs(85)
            ),
            "Installing Docker Desktop: copying Docker's files. 1:25 so far."
        );
        assert_eq!(
            working("Turning on WSL2", None, Duration::from_secs(5)),
            "Turning on WSL2. 0:05 so far."
        );
    }

    /* Lines from a real install log (omen, Docker Desktop 4.93.0), trimmed of the paths around them. */
    const REAL_LOG: &str = "\
Version: 4.93.0 (240920)\n\
Started on: 2026-10-03 11:18:40.472\n\
[2026-10-03T11:18:40.593436000Z][AdminInstallHandler][I] Running admin installation\n\
[2026-10-03T11:18:41.636754900Z][InstallWorkflow][I] Phase 0: Pre-check\n\
[2026-10-03T11:18:41.965539100Z][InstallWorkflow][I] Checking prerequisites\n\
[2026-10-03T11:18:42.541360500Z][InstallWorkflow][I] Phase 1: Staging\n\
[2026-10-03T11:18:42.541360500Z][InstallWorkflow][I] Copying files from C:\\Program Files\\Docker\\Docker to C:\\Program Files\\Docker\\Docker.staging\n\
[2026-10-03T11:18:47.508542300Z][PatchStep][I] Running courgette64.exe -applybsdiff -nologfile\n";

    #[test]
    fn the_stage_is_the_last_phase_dockers_installer_named() {
        assert_eq!(
            docker_stage(REAL_LOG).as_deref(),
            Some("copying Docker's files")
        );
        let later = format!(
            "{REAL_LOG}[2026-10-03T11:19:35.378325100Z][InstallWorkflow][I] Phase 1b: Teardown\n\
             [2026-10-03T11:19:36.488205300Z][InstallWorkflow][I] Phase 2: Backup (file-by-file move)\n"
        );
        assert_eq!(
            docker_stage(&later).as_deref(),
            Some("setting the old version aside")
        );
        let done = format!(
            "{later}[2026-10-03T11:19:38.012990100Z][InstallWorkflow][I] Installation succeeded\n"
        );
        assert_eq!(docker_stage(&done).as_deref(), Some("finishing up"));
    }

    #[test]
    fn a_phase_this_build_does_not_know_is_shown_as_docker_wrote_it() {
        let log = "[2026-11-01T00:00:00Z][InstallWorkflow][I] Phase 7: Telemetry Upload\n";
        assert_eq!(docker_stage(log).as_deref(), Some("telemetry upload"));
    }

    #[test]
    fn a_log_without_phases_names_no_stage() {
        assert_eq!(docker_stage(""), None);
        assert_eq!(docker_stage("Version: 4.93.0\nStarted on: today\n"), None);
    }

    #[test]
    fn every_sentence_here_is_plain_ascii() {
        // They reach a Windows console as well as the app, and a console code page is not to be trusted.
        for text in [
            asking(Duration::from_secs(1)),
            working("x", Some("y"), Duration::from_secs(1)),
            download(MB, 2 * MB, Duration::from_secs(3)),
        ] {
            assert!(text.is_ascii(), "{text}");
        }
    }
}
