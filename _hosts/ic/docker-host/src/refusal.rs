//! Which kind of refusal docker's own words describe.

/// Why the engine did not answer, read off what the docker CLI printed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Something answered, with an error: the 500 a Docker Desktop answers forever once its VM went away. An engine
    /// that exists and is broken, which no start fixes.
    Erroring,
    /// The engine is up and turned this account away: Windows' "Access is denied" on its pipe, or a Unix socket this
    /// user may not open. A group membership, never a longer wait.
    Denied,
    /// Nothing is listening, or the words were not recognised: the reading whose fix (start it) is the safe one to try.
    Down,
}

/// Classify a refusal. Pure. An answer with an error in it outranks the rest: a pipe that answered 500 is an engine
/// that exists, whatever else the message says.
pub fn classify(said: &str) -> Refusal {
    let lower = said.to_ascii_lowercase();
    if lower.contains("500 internal server error")
        || lower.contains("error response from daemon")
        || lower.contains("request returned 5")
    {
        return Refusal::Erroring;
    }
    if lower.contains("access is denied") || lower.contains("permission denied") {
        return Refusal::Denied;
    }
    Refusal::Down
}

/// The words the docker CLI prints when it reached no engine at all, whatever it was asked to do.
const NOTHING_THERE: [&str; 4] = [
    // Docker 28 and later, on every platform: "failed to connect to the docker API at npipe:////./pipe/
    // dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open …".
    "failed to connect to the docker api",
    // Before 28, on a socket or TCP: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the
    // docker daemon running?"
    "cannot connect to the docker daemon",
    "is the docker daemon running",
    // Before 28, on Windows: "error during connect: … open //./pipe/docker_engine: The system cannot find the file
    // specified.", and the same prefix for a TLS endpoint nothing listens on ("… actively refused it.").
    "error during connect",
];

/// Whether docker's words say it reached no engine at all: nothing behind the pipe or socket it was pointed at (Docker
/// Desktop quit, Intentic's engine's distro stopped, a daemon that is not running). Pure.
///
/// [`classify`] reads words already known to be a refusal and calls anything it does not recognise down. This one reads
/// the output of any command (a pull, a load) and says yes only to the words a missing engine leaves, because a download
/// that broke on the network must never be answered with "start Docker". An engine that answered, with an error or by
/// turning this account away, was reached, whatever else the words say.
pub fn unreachable(said: &str) -> bool {
    if classify(said) != Refusal::Down {
        return false;
    }
    let lower = said.to_ascii_lowercase();
    if NOTHING_THERE.iter().any(|words| lower.contains(words)) {
        return true;
    }
    // A named pipe with nothing serving it: Docker Desktop's (`dockerDesktopLinuxEngine`, `docker_engine`) or the relay
    // of Intentic's engine.
    if lower.contains("/pipe/") && lower.contains("cannot find the file specified") {
        return true;
    }
    // The engine's own socket refused or gone. Only the CLI dials a Unix socket; a registry is always dialled over TCP,
    // so its "connection refused" never reads as this.
    (lower.contains("dial unix") || lower.contains("docker.sock"))
        && (lower.contains("connection refused") || lower.contains("no such file or directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Docker's words, as the CLI prints them on the machines that produced each case. */

    #[test]
    fn a_docker_desktop_answering_500_is_erroring() {
        assert_eq!(
            classify("request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/version, check if the server supports the requested API version"),
            Refusal::Erroring
        );
        assert_eq!(
            classify("Error response from daemon: Docker Desktop is unable to start"),
            Refusal::Erroring
        );
        // Any 5xx the CLI reports, not only 500.
        assert_eq!(
            classify("request returned 502 Bad Gateway for API route"),
            Refusal::Erroring
        );
    }

    #[test]
    fn a_pipe_or_socket_that_refuses_this_account_is_denied() {
        assert_eq!(
            classify("error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version\": open //./pipe/dockerDesktopLinuxEngine: Access is denied."),
            Refusal::Denied
        );
        assert_eq!(
            classify("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"),
            Refusal::Denied
        );
    }

    #[test]
    fn an_error_outranks_a_denial_in_the_same_words() {
        assert_eq!(
            classify("Error response from daemon: open /var/lib/docker/x: permission denied"),
            Refusal::Erroring
        );
    }

    #[test]
    fn nothing_listening_and_anything_unrecognised_read_as_down() {
        assert_eq!(
            classify("error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."),
            Refusal::Down
        );
        assert_eq!(
            classify("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"),
            Refusal::Down
        );
        assert_eq!(classify(""), Refusal::Down);
    }

    #[test]
    fn the_reading_ignores_case() {
        assert_eq!(classify("ACCESS IS DENIED"), Refusal::Denied);
        assert_eq!(classify("500 INTERNAL SERVER ERROR"), Refusal::Erroring);
    }

    /* WHETHER ANY ENGINE WAS REACHED, read off a command's own output: the question a stopped download asks first. */

    #[test]
    fn docker_desktop_gone_from_under_a_pull_is_unreachable() {
        // Verbatim from the setup report a Windows PC sent on 2026-10-12, after Docker Desktop stopped mid-download.
        assert!(unreachable("failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."));
        // The same, from a CLI older than 28.
        assert!(unreachable("error during connect: Head \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/_ping\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."));
        assert!(unreachable(
            "open //./pipe/docker_engine: The system cannot find the file specified."
        ));
    }

    #[test]
    fn a_linux_daemon_that_is_not_running_is_unreachable() {
        assert!(unreachable("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"));
        assert!(unreachable("failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory"));
        assert!(unreachable(
            "dial unix /var/run/docker.sock: connect: connection refused"
        ));
    }

    #[test]
    fn intentic_engine_stopped_is_unreachable_on_its_pipe_and_on_its_tls_endpoint() {
        assert!(unreachable("failed to connect to the docker API at npipe:////./pipe/intentic-engine.Ada; check if the path is correct and if the daemon is running: open //./pipe/intentic-engine.Ada: The system cannot find the file specified."));
        assert!(unreachable("error during connect: Get \"https://127.0.0.1:2378/v1.47/images/create?fromImage=ghcr.io%2Fintentic%2Fsandbox&tag=stable\": dial tcp 127.0.0.1:2378: connectex: No connection could be made because the target machine actively refused it."));
    }

    #[test]
    fn a_network_that_broke_a_download_is_not_a_missing_engine() {
        // The registry's own "connection refused" is dialled over TCP by the engine, which was reached.
        for said in [
            "failed to do request: Head \"https://ghcr.io/v2/intentic/sandbox/manifests/stable\": dial tcp 140.82.121.33:443: connect: connection refused",
            "Error response from daemon: Get \"https://ghcr.io/v2/\": dial tcp: lookup ghcr.io: no such host",
            "read tcp 10.0.0.2:52344->140.82.121.33:443: read: connection reset by peer",
            "error pulling image configuration: download failed after attempts=6: dial tcp: i/o timeout",
            "unexpected EOF",
            "",
        ] {
            assert!(!unreachable(said), "{said}");
        }
    }

    #[test]
    fn an_engine_that_answered_or_refused_this_account_was_reached() {
        assert!(!unreachable(
            "error during connect: open //./pipe/docker_engine: Access is denied."
        ));
        assert!(!unreachable("request returned 500 Internal Server Error for API route and version http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/version, check if the server supports the requested API version"));
        assert!(!unreachable("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"));
    }
}
