import { BoundedMap } from "@intentic/base/held";
import { z } from "zod";
import { opt } from "../opt.js";
import { readJson } from "./http.js";
import type { FailedStep } from "./client.js";

/* WHY GITHUB CANCELLED A JOB. Actions reports a job that ran past its `timeout-minutes`, and one no runner ever took, as
   `cancelled`: the same word as a person's cancel or a newer push's. The first is the code's failure (a hang, a test
   grown slow) and the second the fleet's; any other cancel is nobody's. Only the job's check run says which, in its
   annotations. (2026-11-03: main's CI sat red for hours on a migrations job past its 15 minutes, and Nightly on a clock
   check past its 30 and an iOS job no macOS runner took, while main's fix agent heard of none of them, since a
   cancelled job was never a failed one.) A failed job's annotations are read too: they are where a self-hosted runner
   that lost its connection or was shut down under the job is said (the pipelines extension's fleet-verdict.ts). */

export type CancelCause = "timed_out" | "runner_unavailable";

// A completed job's conclusions that mean it did not pass (runs.ts githubStatus reads every one but these as failed).
const NOT_FAILED: ReadonlySet<string> = new Set(["success", "cancelled", "skipped", "neutral", "stale"]);

// GitHub Actions' own sentences, the one place it says why: no field of the job or its check run tells a timeout or a
// runner that never came from a person's cancel. A wording matching none reads as a plain cancel, nobody's failure,
// which is what every cancel read as before.
const CANCEL_CAUSES: readonly { readonly sign: RegExp; readonly cause: CancelCause }[] = [
    { sign: /exceeded the maximum execution time/i, cause: "timed_out" },
    { sign: /was not acquired by Runner/i, cause: "runner_unavailable" },
    { sign: /The runner has received a shutdown signal/i, cause: "runner_unavailable" },
];

// allow(dependency-text): GitHub Actions' annotation sentences are the only signal for why a job was cancelled; an unmatched one falls back to a plain cancel.
const cancelCauseOf = (messages: readonly string[]): CancelCause | undefined =>
    CANCEL_CAUSES.find(({ sign }) => messages.some((message) => sign.test(message)))?.cause;

const AnnotationsSchema = z.array(z.object({ message: z.string().nullish() }));

// A completed job's annotations never change, so each job's are read once, across the runs a board and a fix read.
const ANNOTATIONS_KEPT = 300;
const kept = new BoundedMap<string, readonly string[]>(ANNOTATIONS_KEPT);
// Jobs asked about per run, at most: a run a person cancelled whole cancels every job still going, and each question is
// a request.
const ANNOTATED_READ = 20;

interface AnnotatedJob {
    readonly id: number;
    readonly conclusion: string | null;
}

// Whether a job's annotations are worth a request: it failed, or was cancelled in a way that may be a failure after all.
const worthAsking = (job: AnnotatedJob): boolean => job.conclusion === "cancelled" || job.conclusion === "failure" || job.conclusion === "timed_out";

/** Each failed or cancelled job's check run annotations, by job: why a cancel was a failure (cancelCauseOf), and whether
 *  a runner died under a failed job (the pipelines extension's fleet-verdict.ts). `account` tells one forge's job ids from another's; `annotations`
 *  reads a job's check run annotations (a job's id is its check run's). An answer that is not a list of annotations says
 *  nothing, and is asked again next time. */
export const jobAnnotations = async <J extends AnnotatedJob>(
    jobs: readonly J[],
    account: string,
    annotations: (jobId: number) => Promise<Response>,
): Promise<ReadonlyMap<J, readonly string[]>> => {
    const asked = jobs.filter(worthAsking).slice(0, ANNOTATED_READ);
    const found = new Map<J, readonly string[]>();
    await Promise.all(
        asked.map(async (job) => {
            const key = `${account}\n${job.id}`;
            let messages = kept.get(key);
            if (messages === undefined) {
                messages = await annotationsOf(await annotations(job.id));
                if (messages === undefined) {
                    return;
                }
                kept.set(key, messages);
            }
            found.set(job, messages);
        }),
    );
    return found;
};

/** One check run's annotation messages, from its annotations answer; undefined when the answer is no list of them. */
export const annotationsOf = async (response: Response): Promise<readonly string[] | undefined> => {
    const parsed = response.ok ? AnnotationsSchema.safeParse(await readJson(response)) : undefined;
    return parsed?.success === true ? parsed.data.flatMap(({ message }) => (message === undefined || message === null ? [] : [message])) : undefined;
};

// One job of a run's list as Actions serves it, narrowed to what tells a failure.
interface GithubJobEntry {
    readonly id: number;
    readonly name: string;
    readonly conclusion: string | null;
    readonly steps?: readonly { readonly name: string; readonly conclusion: string | null }[];
    readonly runner_name?: string | null;
}

/** A job of a run as main's fix agent hears of it, from the jobs list's entry and its check run's annotations (undefined
 *  where they were not read): failed, or cancelled in a way that is a failure after all (cancelCauseOf); none for any
 *  other. A cancel is a failure only by its annotations, and a job that concluded `timed_out` keeps that as its reason. */
export const githubFailedStep = (job: GithubJobEntry, annotations: readonly string[] | undefined): FailedStep[] => {
    const cause = job.conclusion === "cancelled" && annotations !== undefined ? cancelCauseOf(annotations) : undefined;
    if (cause === undefined && (job.conclusion === null || NOT_FAILED.has(job.conclusion))) {
        return [];
    }
    const steps = (job.steps ?? []).filter((candidate) => candidate.conclusion === "failure").map((candidate) => candidate.name);
    const [step] = steps;
    const reason = cause ?? (job.conclusion === "timed_out" ? "timed_out" : undefined);
    return [
        {
            job: job.name,
            id: job.id,
            ...opt("step", step),
            ...opt("steps", step === undefined ? undefined : steps),
            ...opt("reason", reason),
            ...opt("annotations", annotations !== undefined && annotations.length > 0 ? annotations : undefined),
            ...opt("runner", job.runner_name === null || job.runner_name === "" ? undefined : job.runner_name),
        },
    ];
};
