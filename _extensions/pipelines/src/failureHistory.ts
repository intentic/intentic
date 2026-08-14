import type { PipelineJob, PipelineRun } from "@intentic/sandbox-contract";

/* "Is this the same failure as last time?" — the question a 75%-failure repo actually needs answered.
 *
 * A row that says a run failed tells you nothing you can prioritise. What separates a new problem from the
 * one you already know about is whether the SAME job keeps breaking: `eslint` red for nine runs straight is
 * one broken thing to fix, not nine failures to triage, and a job that failed only in the newest run is the
 * thing that actually changed.
 *
 * Counted per repo+branch, because the same job name on two branches is two different stories.
 */

export interface JobFailureRun {
    readonly repo: string;
    readonly branch: string;
    readonly createdAt: number;
    // Undefined while that run's jobs haven't loaded yet — distinct from "loaded, and nothing failed", which
    // is an empty array and DOES break a streak.
    readonly failed: readonly string[] | undefined;
}

export interface RecurringFailure {
    readonly job: string;
    readonly repo: string;
    readonly branch: string;
    // Consecutive most-recent runs on this branch in which the job failed.
    readonly runs: number;
}

// Two runs in a row is already a pattern worth naming; one is just a failure, which the row itself shows.
const RECURRING_MIN = 2;

const failedJobNames = (jobs: readonly PipelineJob[]): string[] => jobs.filter((job) => job.status === `failed`).map((job) => job.name);

// A run's failed-job names, preferring the jobs we fetched and falling back to the summary the daemon attaches
// to failed runs (webhook-delivered runs carry it; the REST backfill does not fill it).
export const failedOf = (run: PipelineRun, jobs: readonly PipelineJob[] | undefined): readonly string[] | undefined =>
    jobs !== undefined ? failedJobNames(jobs) : run.failedJobs;

// Walk each branch newest-first and count how far back each job has failed WITHOUT interruption. A run whose
// jobs haven't loaded stops the walk rather than breaking the streak: absence of data is not evidence the job
// passed, and guessing either way would make the count flicker as rows load.
export const recurringFailures = (history: readonly JobFailureRun[]): RecurringFailure[] => {
    const byBranch = new Map<string, JobFailureRun[]>();
    for (const entry of history) {
        const key = `${entry.repo}\n${entry.branch}`;
        const group = byBranch.get(key);
        if (group === undefined) {
            byBranch.set(key, [entry]);
            continue;
        }
        group.push(entry);
    }

    const recurring: RecurringFailure[] = [];
    for (const group of byBranch.values()) {
        const newestFirst = group.toSorted((a, b) => b.createdAt - a.createdAt);
        // Jobs still on their streak as we walk back; a job absent from a run's failures has ended its run.
        const streaks = new Map<string, number>();
        const live = new Set<string>();
        let first = true;
        for (const run of newestFirst) {
            if (run.failed === undefined) {
                break;
            }
            const failedNow = new Set(run.failed);
            if (first) {
                for (const job of failedNow) {
                    streaks.set(job, 1);
                    live.add(job);
                }
                first = false;
                continue;
            }
            // Collected first: ending a job's streak mutates `live`, which must not happen mid-iteration.
            const ended: string[] = [];
            for (const job of live) {
                if (failedNow.has(job)) {
                    streaks.set(job, (streaks.get(job) ?? 0) + 1);
                    continue;
                }
                ended.push(job);
            }
            for (const job of ended) {
                live.delete(job);
            }
            if (live.size === 0) {
                break;
            }
        }
        const [newest] = newestFirst;
        if (newest === undefined) {
            continue;
        }
        for (const [job, runs] of streaks) {
            if (runs >= RECURRING_MIN) {
                recurring.push({ job, repo: newest.repo, branch: newest.branch, runs });
            }
        }
    }
    // Worst offender first — the one to fix.
    return recurring.toSorted((a, b) => b.runs - a.runs || a.job.localeCompare(b.job));
};
