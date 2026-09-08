import { CI_POLL_INTERVAL_MS } from "@intentic/sandbox-contract";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { ciResultOf, dispatchCiRun, rememberCiRun } from "./events.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects } from "./projects.js";

// REST fallback for the `ci` trigger: polls only the repos in ciHooks.warnings() (no live webhook), never one that has
// it. Not a general-purpose poller or a freshness mechanism for the Pipelines view; it exists only to fire the events a
// webhook would have delivered.

// Deep enough per pass that a push burst between polls can't push a finished run out of the window.
const RUNS_PER_POLL = 20;

export interface CiPoller {
    readonly start: () => void;
    readonly stop: () => void;
    // One pass over every unwired repo; start also runs it immediately then on the interval.
    readonly poll: () => Promise<void>;
}

export const createCiPoller = (services: Services, wake: WakeFn, fetchFn: FetchFn = fetch, intervalMs = CI_POLL_INTERVAL_MS): CiPoller => {
    let timer: NodeJS.Timeout | undefined;
    let pass: Promise<void> = Promise.resolve();

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
            const author =
                announced.authorName !== undefined
                    ? { id: announced.authorName, name: announced.authorName }
                    : { id: project.account.provider, name: project.account.provider };
            await dispatchCiRun(services, announced, author, wake);
        }
        // Written after dispatch, so a crash mid-pass re-announces instead of silently dropping a run.
        await services.ciStore.recordAnnounced(project.repo, [...ids, ...known]);
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
            // Per repo: one failing vendor (revoked token, moved project) doesn't stop the rest.
            await pollRepo(project).catch((error: unknown) => services.logger.warn({ err: error, repo: project.repo }, "ci: poll failed"));
        }
    };

    // Serializes poll calls; a manual poll during the interval's pass chains after it instead of racing the
    // announced-ids record.
    const poll = (): Promise<void> => {
        const run = pass.then(pollOnce, pollOnce);
        pass = run.catch(() => undefined);
        return run;
    };

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
