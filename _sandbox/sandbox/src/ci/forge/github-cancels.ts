import { BoundedMap } from "@intentic/base/held";
import { z } from "zod";

/* WHY GITHUB CANCELLED A JOB. Actions reports a job that ran past its `timeout-minutes`, and one no runner ever took, as
   `cancelled`: the same word as a person's cancel or a newer push's. The first is the code's failure (a hang, a test
   grown slow) and the second the fleet's; any other cancel is nobody's. Only the job's check run says which, in its
   annotations. (2026-11-03: main's CI sat red for hours on a migrations job past its 15 minutes, and Nightly on a clock
   check past its 30 and an iOS job no macOS runner took, while main's fix agent heard of none of them, since a
   cancelled job was never a failed one.) */

type CancelCause = "timed_out" | "runner_unavailable";

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

// A completed job's annotations never change, so each is read once, by job, across the runs a board and a fix read.
const CAUSES_KEPT = 300;
const causes = new BoundedMap<string, CancelCause | "none">(CAUSES_KEPT);
// Cancelled jobs asked about per run, at most: a run a person cancelled whole cancels every job still going, and each
// question is a request.
const CANCELLED_READ = 12;

interface CancellableJob {
    readonly id: number;
    readonly conclusion: string | null;
}

// Each cancelled job of a run whose cancel says it failed after all, with why. `account` tells one forge's job ids from
// another's; `annotations` reads a job's check run annotations (a job's id is its check run's). An answer that is not a
// list of annotations says nothing, and is asked again next time.
export const cancelledFailures = async <J extends CancellableJob>(
    jobs: readonly J[],
    account: string,
    annotations: (jobId: number) => Promise<Response>,
): Promise<ReadonlyMap<J, CancelCause>> => {
    const asked = jobs.filter((job) => job.conclusion === "cancelled").slice(0, CANCELLED_READ);
    const found = new Map<J, CancelCause>();
    await Promise.all(
        asked.map(async (job) => {
            const key = `${account}\n${job.id}`;
            let known = causes.get(key);
            if (known === undefined) {
                const response = await annotations(job.id);
                const parsed = response.ok ? AnnotationsSchema.safeParse(await response.json()) : undefined;
                if (parsed?.success !== true) {
                    return;
                }
                known = cancelCauseOf(parsed.data.flatMap(({ message }) => (message === undefined || message === null ? [] : [message]))) ?? "none";
                causes.set(key, known);
            }
            if (known !== "none") {
                found.set(job, known);
            }
        }),
    );
    return found;
};
