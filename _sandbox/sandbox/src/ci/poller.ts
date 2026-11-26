import { type Backoff, createBackoff, serialLock } from "@intentic/base/async";
import { CI_POLL_INTERVAL_MS, isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { ciResultOf, dispatchCiRun, rememberCiRun } from "./events.js";
import { publishCiFeed } from "../seams/ci-feed-bus.js";
import { opt } from "../opt.js";
import { createCiFailureLog, vendorStatusOf } from "./logs/ci-failure-log.js";
import { isMainLine } from "./main-line.js";
import { forgeClientFor as ciClientFor, type ForgeClient as CiClient, type FailedStep } from "../forge/client.js";
import type { FetchFn } from "../forge/http.js";
import { ciProjects, type CiProject } from "./projects.js";

// REST fallback for the `ci` trigger: polls only the repos in ciHooks.warnings() (no live webhook), never one that has
// it. Not a general-purpose poller or a freshness mechanism for the Pipelines view; it exists only to fire the events a
// webhook would have delivered: a finished run, and a job of a main line's run still going that failed, which main's fix
// agent starts on (the pipelines extension hears it on the CI feed). In-flight runs are read on main lines only, since a
// job webhook would have said it at once there and every other branch's failure is heard with its run.

// Deep enough per pass that a push burst between polls can't push a finished run out of the window.
const RUNS_PER_POLL = 20;

// A refused token (401) is asked again after a pause that doubles up to this, rather than every pass for hours. A new
// token for the account ends the pause at once, since nothing about the old refusal speaks for it. The pause is
// jittered so the repos one revoked token refused don't all come back on the same pass.
const REFUSED_BACKOFF_MAX_MS = 30 * 60_000;

interface Refusal {
    readonly token: string;
    readonly until: number;
    readonly pause: Backoff;
}

export interface CiPoller {
    readonly start: () => void;
    readonly stop: () => void;
    // One pass over every unwired repo; start also runs it immediately then on the interval.
    readonly poll: () => Promise<void>;
}

// Whether a listed run is over and heard of: a result, or a cancel, which is no result but goes on the CI feed, where
// main's fix agent reads what passed in it (events.ts dispatchCiRun).
const isOver = (run: PipelineRun): boolean => ciResultOf(run) !== undefined || run.status === "canceled";

// A main line's run still going: each job that already failed, on the CI feed as its job webhook would have put it.
const failedInFlight = async (services: Services, client: CiClient, project: CiProject, run: PipelineRun): Promise<void> => {
    if (!(await isMainLine(services, project, run.branch))) {
        return;
    }
    // Best-effort, as the job webhook it stands in for: a forge that will not list them now is asked on the next pass.
    let steps: readonly FailedStep[] = [];
    try {
        steps = await client.failedSteps(project, run.runId);
    } catch (error) {
        services.logger.warn({ err: error, repo: project.repo, runId: run.runId }, "ci: a running run's failed jobs could not be read");
    }
    for (const step of steps) {
        publishCiFeed({
            kind: "job",
            repo: project.repo,
            host: project.account.provider,
            project: project.project,
            runId: run.runId,
            ...opt("workflow", run.workflow),
            job: step.job,
            branch: run.branch,
            sha: run.sha,
            status: "failed",
            url: run.url,
            failed: {
                jobId: step.id,
                ...opt("step", step.step),
                ...opt("steps", step.steps === undefined ? undefined : [...step.steps]),
                ...opt("reason", step.reason),
                ...opt("trigger", run.trigger),
                ...opt("annotations", step.annotations === undefined ? undefined : [...step.annotations]),
                ...opt("runner", step.runner),
            },
        });
    }
};

export const createCiPoller = (
    services: Services,
    fetchFn: FetchFn = fetch,
    intervalMs = CI_POLL_INTERVAL_MS,
    now: () => number = Date.now,
    random: () => number = Math.random,
): CiPoller => {
    let timer: NodeJS.Timeout | undefined;
    const serially = serialLock();
    const failures = createCiFailureLog(services.logger, "ci: poll failed", "ci: poll works again", now);
    // repo → the refused token and when to try it again.
    const refusals = new Map<string, Refusal>();

    const pollRepo = async (project: Awaited<ReturnType<typeof ciProjects>>[number]): Promise<void> => {
        const client = ciClientFor(project.account.provider, fetchFn);
        const listed = await client.listRuns(project, RUNS_PER_POLL);
        const terminal = listed.filter(isOver);
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
            await dispatchCiRun(services, project, announced, author);
        }
        // Written after each run is dispatched, so a crash mid-pass re-announces instead of silently dropping one. An
        // automation's wake rides the listener batcher, which only this process holds; the feed's reader catches up on
        // a run it missed from the forge (the pipelines extension does on every gap in its stream).
        await services.ciStore.recordAnnounced(project.repo, [...ids, ...known]);
        // What a job webhook would have said: a job of a main line's run still going failed. Said again on every pass
        // while the run goes on; a reader hears each job once however often it is said (the pipelines extension's
        // streak keeps what it heard).
        for (const run of listed.filter((candidate) => isPipelineInFlight(candidate.status)).toReversed()) {
            await failedInFlight(services, client, project, run);
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
                    const pause =
                        refusal?.token === project.account.token
                            ? refusal.pause
                            : createBackoff({ floorMs: intervalMs * 2, capMs: REFUSED_BACKOFF_MAX_MS, random });
                    refusals.set(project.repo, { token: project.account.token, until: now() + pause.next(), pause });
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
