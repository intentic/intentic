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
}
