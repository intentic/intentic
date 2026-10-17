import type { DockerStart } from "../desktop";

// WHY A DOCKER START ENDED THE WAY IT DID, as the funnel may hear it. Docker's own last words (`detail`) quote paths and
// account names, so they never leave the machine: what leaves is which of the app's own sentences they began with
// (scripts.rs writes every one of these prefixes) and the operating system's error number, which says the rest.

/** The kind of refusal behind a start's outcome; `none` where Docker said nothing. */
export type DockerReason = `none` | `cliMissing` | `launchFailed` | `denied` | `engineSilent` | `notInstalled` | `other`;

// The OS's number for "not allowed", which Rust's io::Error appends in every language the OS words the rest in (`Odmowa
// dostępu. (os error 5)` on a Polish Windows): ERROR_ACCESS_DENIED on Windows, EACCES elsewhere, where 5 is EIO.
const deniedOsError = (windows: boolean): number => (windows ? 5 : 13);

export const dockerReasonOf = (
    report: Pick<DockerStart, `detail`>,
    windows = navigator.userAgent.includes(`Windows`),
): { reason: DockerReason; osError?: number } => {
    const detail = report.detail.trim();
    const os = /os error (\d+)/i.exec(detail);
    const number = os === null ? undefined : Number(os[1]);
    const osError = number === undefined ? {} : { osError: number };
    const lower = detail.toLowerCase();
    if (detail === ``) {
        return { reason: `none` };
    }
    // scripts.rs `CLI_MISSING`: the engine may be up, and the `docker` this app spawns could not be found or run.
    if (lower.startsWith(`the docker command would not run`)) {
        return { reason: `cliMissing`, ...osError };
    }
    // The number first; the words only for what carries none, Docker's own CLI above all (Go, and English whatever the
    // OS: "permission denied while trying to connect…").
    // allow(dependency-text): Docker CLI's and the OS's English wording; an unmatched one is reported as `other`.
    if (number === deniedOsError(windows) || lower.includes(`access is denied`) || lower.includes(`permission denied`)) {
        return { reason: `denied`, ...osError };
    }
    if (lower.startsWith(`docker's engine is up but`)) {
        return { reason: `engineSilent`, ...osError };
    }
    if (lower.includes(`is not installed`)) {
        return { reason: `notInstalled`, ...osError };
    }
    // `start_docker_desktop`: Docker Desktop's own launcher refused to start (`<exe> would not start: <error>`).
    if (lower.includes(` would not start: `)) {
        return { reason: `launchFailed`, ...osError };
    }
    return { reason: `other`, ...osError };
};
