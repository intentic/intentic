import { serialLock } from "@intentic/base/async";
import { CI_POLL_INTERVAL_MS, isPipelineInFlight } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { ciResultOf, dispatchCiRun, rememberCiRun } from "./events.js";
import { createCiFailureLog, vendorStatusOf } from "./logs/ci-failure-log.js";
import { runInFlight } from "./main-fixer.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects } from "./projects.js";

// REST fallback for the `ci` trigger: polls only the repos in ciHooks.warnings() (no live webhook), never one that has
// it. Not a general-purpose poller or a freshness mechanism for the Pipelines view; it exists only to fire the events a
// webhook would have delivered: a finished run, and a job of a run still going that failed, which main's fix agent
// starts on (main-fixer.ts).

// Deep enough per pass that a push burst between polls can't push a finished run out of the window.
const RUNS_PER_POLL = 20;

// A refused token (401) is asked again after a pause that doubles up to this, rather than every pass for hours. A new
// token for the account ends the pause at once, since nothing about the old refusal speaks for it.
const REFUSED_BACKOFF_MAX_MS = 30 * 60_000;

interface Refusal {
    readonly token: string;
    readonly until: number;
    readonly pauseMs: number;
}

export interface CiPoller {
    readonly start: () => void;
    readonly stop: () => void;
    // One pass over every unwired repo; start also runs it immediately then on the interval.
    readonly poll: () => Promise<void>;
}

export const createCiPoller = (
    services: Services,
    fetchFn: FetchFn = fetch,
    intervalMs = CI_POLL_INTERVAL_MS,
    now: () => number = Date.now,
): CiPoller => {
    let timer: NodeJS.Timeout | undefined;
    const serially = serialLock();
    const failures = createCiFailureLog(services.logger, "ci: poll failed", "ci: poll works again", now);
    // repo → the refused token and when to try it again.
    const refusals = new Map<string, Refusal>();

    const pollRepo = async (project: Awaited<ReturnType<typeof ciProjects>>[number]): Promise<void> => {
        const client = ciClientFor(project.account.provider, fetchFn);
        const listed = await client.listRuns(project, RUNS_PER_POLL);
        const terminal = listed.filter((run) => ciResultOf(run) !== undefined);
        const known = await services.ciStore.announcedRuns(project.repo);
        const ids = terminal.map((run) => run.runId);
        // First poll of a repo adopts state silently; it still records it so the next run can edge against it.
        if (known === undefined) {
            for (const run of terminal.toReversed()) {
                await rememberCiRun(services, run);
            }
            await services.ciStore.recordAnnounced(project.repo, ids);
            return;
        }
        // Oldest-first: an out-of-order replay would decide pipeline_broken/fixed against the wrong previous state.
        const fresh = terminal.filter((run) => !known.includes(run.runId)).toReversed();
        for (const run of fresh) {
            // Same enrichment the webhook route makes: a wake naming the failing job saves the agent a lookup.
            const failedJobs = run.status === "failed" ? await client.failedJobs(project, run.runId).catch(() => []) : [];
            const announced = failedJobs.length > 0 ? { ...run, failedJobs } : run;
            services.ciRuns.upsert(announced);
            // The webhook's stand-in for this repo, so an open board reads the same push either way.
            publishRuntimeChange("ci");
            const author =
                announced.authorName !== undefined
                    ? { id: announced.authorName, name: announced.authorName }
                    : { id: project.account.provider, name: project.account.provider };
            // Awaited, unlike the webhook: the run is recorded as heard below, and main's fix agent must have it on file
            // first.
            await (await dispatchCiRun(services, project, announced, author, fetchFn)).fixed;
        }
        // Written after main's fix agent has each run on file, so a crash mid-pass re-announces instead of silently
        // dropping a failure of main's. An automation's wake rides the listener batcher, which only this process holds.
        await services.ciStore.recordAnnounced(project.repo, [...ids, ...known]);
        // What a job webhook would have said: a job of a run still going failed. Each is heard once, however often a
        // pass lists it.
        for (const run of listed.filter((candidate) => isPipelineInFlight(candidate.status)).toReversed()) {
            await runInFlight(services, project, run, fetchFn);
        }
    };

    const pollOnce = async (): Promise<void> => {
        const unwired = services.ciHooks.warnings();
        if (unwired.size === 0) {
            return;
        }
        for (const project of await ciProjects(services)) {
            if (!unwired.has(project.repo)) {
                continue;
            }
            const refusal = refusals.get(project.repo);
            if (refusal !== undefined && refusal.token === project.account.token && now() < refusal.until) {
                continue;
            }
            // Per repo: one failing vendor (revoked token, moved project) doesn't stop the rest.
            try {
                await pollRepo(project);
                refusals.delete(project.repo);
                failures.succeeded(project.repo);
            } catch (error) {
                failures.failed(project.repo, error);
                if (vendorStatusOf(error) === 401) {
                    const pauseMs =
                        refusal?.token === project.account.token ? Math.min(refusal.pauseMs * 2, REFUSED_BACKOFF_MAX_MS) : intervalMs * 2;
                    refusals.set(project.repo, { token: project.account.token, until: now() + pauseMs, pauseMs });
                }
            }
        }
    };

    // Serializes poll calls; a manual poll during the interval's pass chains after it instead of racing the
    // announced-ids record.
    const poll = (): Promise<void> => serially(pollOnce);

    return {
        poll,
        start: () => {
            void poll().catch((error: unknown) => services.logger.warn({ err: error }, "ci: poll pass failed"));
            timer = setInterval(
                () => void poll().catch((error: unknown) => services.logger.warn({ err: error }, "ci: poll pass failed")),
                intervalMs,
            );
        },
        stop: () => clearInterval(timer),
    };
};
