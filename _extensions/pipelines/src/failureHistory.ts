import type { PipelineJob, PipelineRun } from "@intentic/sandbox-contract";

// Whether the same job keeps failing across runs, not just whether a run failed; counted per repo+branch since the same
// job name on different branches is a different story.

export interface JobFailureRun {
    readonly repo: string;
    readonly branch: string;
    readonly createdAt: number;
    // Undefined until that run's jobs load; distinct from an empty array, which does break a streak.
    readonly failed: readonly string[] | undefined;
}

export interface RecurringFailure {
    readonly job: string;
    readonly repo: string;
    readonly branch: string;
    // Consecutive most-recent runs on this branch in which the job failed.
    readonly runs: number;
}

// Two consecutive failures is the threshold for calling it a recurring pattern.
const RECURRING_MIN = 2;

const failedJobNames = (jobs: readonly PipelineJob[]): string[] => jobs.filter((job) => job.status === `failed`).map((job) => job.name);

// Failed-job names for a run: prefers fetched jobs, falling back to the daemon's summary (present on webhook-delivered
// runs, absent from REST backfill).
export const failedOf = (run: PipelineRun, jobs: readonly PipelineJob[] | undefined): readonly string[] | undefined =>
    jobs !== undefined ? failedJobNames(jobs) : run.failedJobs;

// Walks each branch newest-first, counting each job's uninterrupted failure streak; a run with unloaded jobs stops the
// walk instead of breaking the streak, since missing data is not evidence the job passed.
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
        // Jobs still on their streak while walking back; a job absent from a run's failures has ended it.
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
            // Collected first since mutating `live` mid-iteration is unsafe.
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
    // Worst offender first.
    return recurring.toSorted((a, b) => b.runs - a.runs || a.job.localeCompare(b.job));
};
