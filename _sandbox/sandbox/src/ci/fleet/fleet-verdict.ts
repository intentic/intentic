import { isInfraStep } from "@intentic/constants/ci-infra-steps";

/* WHOSE FAILURE A FAILED JOB IS: the code's, the CI fleet's (a runner that crashed, lost its connection, was shut down,
   never came, or a full disk), or ambiguous (it ran out of time with no step of its own failing, which a hang and a
   stalled runner both look like). Pure: it reads only what the forge already said of the job and its log. A fleet
   failure starts no fix agent; an ambiguous one is re-run once first (main-fixer.ts). (2026-11-12: two of five fix
   agents on one failing main found no bug at all; every job had died with "The self-hosted runner: … lost communication
   with the server", said only in the job's annotations, while its log read like any other.) */

// What the forge said of one failed job, whichever door it came through.
export interface JobEvidence {
    // The first step it failed in, where the forge names steps (GitHub).
    readonly step?: string | undefined;
    // Every step it failed in, in order.
    readonly steps?: readonly string[] | undefined;
    // The forge's own word on why (GitLab's `failure_reason`; on GitHub, why a cancel was a failure: github-cancels.ts).
    readonly reason?: string | undefined;
    // The job's check run annotations, GitHub's one place to say a runner died; undefined where they were not read.
    readonly annotations?: readonly string[] | undefined;
}

export type JobVerdict = { readonly kind: "code" } | { readonly kind: "fleet" | "ambiguous"; readonly says: string };

const CODE: JobVerdict = { kind: "code" };

// Lines only the runner, its Docker daemon or its disk print, each with what it says happened; a test's own output (a
// refused port, an HTTP 503 it asserts) is left to read as the code's.
const INFRA_LOG: readonly { readonly sign: RegExp; readonly says: string }[] = [
    { sign: /Cannot connect to the Docker daemon at /, says: "the runner's Docker daemon stopped answering" },
    { sign: /docker: command not found/, says: "the runner has no Docker" },
    { sign: /no space left on device/i, says: "the runner's disk is full" },
    { sign: /net\/http: timeout awaiting response headers/, says: "the runner's network timed out" },
    { sign: /The runner has received a shutdown signal/, says: "the runner was shut down mid-job" },
    { sign: /lost communication with the server/i, says: "the runner lost its connection to the forge" },
];

// What a failed-job log says the fleet did, once per sign it carries; none for a log that reads as the code's.
const infraSigns = (logs: string): readonly string[] => INFRA_LOG.flatMap(({ sign, says }) => (sign.test(logs) ? [says] : []));

// Whether a failed-job log reads as the fleet's failure; any one sign is enough, since a code failure prints none of them.
export const infraLog = (logs: string): boolean => infraSigns(logs).length > 0;

// allow(dependency-text): GitHub Actions' annotation sentences are its only word on a runner that died under a job.
// Checked in order: a timeout says "The operation was canceled." too, and is the ambiguous one.
const ANNOTATION_SIGNS: readonly { readonly sign: RegExp; readonly says: string; readonly kind: "fleet" | "ambiguous" | "cancel" }[] = [
    { sign: /lost communication with the server/i, says: "its runner lost its connection to the forge", kind: "fleet" },
    { sign: /The runner has received a shutdown signal/i, says: "its runner was shut down mid-job", kind: "fleet" },
    { sign: /was not acquired by Runner/i, says: "no runner took it", kind: "fleet" },
    { sign: /exceeded the maximum execution time/i, says: "it ran past its time limit with no step of its own failing", kind: "ambiguous" },
    { sign: /The operation was canceled/i, says: "it was cancelled mid-run with no step of its own failing", kind: "cancel" },
];

// Why a job failed, where the runner or the scheduler failed and not the code: GitLab's own `failure_reason`, and a
// GitHub job no runner took (forge/github-cancels.ts), each in words.
const FLEET_REASONS = new Map([
    ["runner_system_failure", "its runner failed (runner_system_failure)"],
    ["scheduler_failure", "the scheduler failed it (scheduler_failure)"],
    ["runner_unsupported", "no runner supports it (runner_unsupported)"],
    ["api_failure", "the forge's API failed it (api_failure)"],
    ["data_integrity_failure", "the forge lost its data (data_integrity_failure)"],
    ["runner_unavailable", "no runner took it, or its runner went away"],
]);

// Why a job failed, where it ran out of time: a GitHub job past its `timeout-minutes`, a GitLab job past its timeout.
export const TIMEOUT_REASONS: ReadonlySet<string> = new Set(["timed_out", "job_execution_timeout"]);

// Whether a step of the job's own failed it, rather than the runner's setup or nothing at all.
const ownStepFailed = (job: JobEvidence): boolean => (job.steps ?? (job.step === undefined ? [] : [job.step])).some((step) => !isInfraStep(step));

/** Whose failure one failed job is. `log` is the end of its log (the runner's death is said last); missing evidence
 *  never reads as the fleet's. */
export const jobVerdict = (job: JobEvidence, log: string): JobVerdict => {
    const own = ownStepFailed(job);
    for (const { sign, says, kind } of ANNOTATION_SIGNS) {
        if (!(job.annotations ?? []).some((message) => sign.test(message))) {
            continue;
        }
        if (kind === "fleet") {
            return { kind, says };
        }
        // A cancel or a timeout with a step of its own failing is that step's failure.
        if (!own) {
            return { kind: kind === "cancel" ? "fleet" : kind, says };
        }
    }
    if (job.step !== undefined && isInfraStep(job.step)) {
        return { kind: "fleet", says: `it died in the runner's own step "${job.step}"` };
    }
    const reason = job.reason === undefined ? undefined : FLEET_REASONS.get(job.reason);
    if (reason !== undefined) {
        return { kind: "fleet", says: reason };
    }
    const [sign] = infraSigns(log);
    if (sign !== undefined) {
        return { kind: "fleet", says: sign };
    }
    if (job.reason !== undefined && TIMEOUT_REASONS.has(job.reason) && !own) {
        return { kind: "ambiguous", says: "it ran past its time limit with no step of its own failing" };
    }
    return CODE;
};

// The machine a GitHub runner ran the job on, as the job's log says in its first lines; undefined when the log does not.
export const machineOf = (log: string): string | undefined => /Machine name: '([^'\n]+)'/.exec(log)?.[1];
