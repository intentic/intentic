import { CI_POLL_INTERVAL_MS } from "@intentic/sandbox-contract";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { ciResultOf, dispatchCiRun, rememberCiRun } from "./events.js";
import { ciClientFor, type FetchFn } from "./providers.js";
import { ciProjects } from "./projects.js";

/* The pipeline trigger's fallback delivery — REST polling for exactly the repos whose provider webhook could
 * not be registered.
 *
 * A `ci` automation used to be silently conditional on something the owner never agreed to: the sandbox having
 * a public URL the provider can reach, and the connected token carrying hook scope (github's admin:repo_hook,
 * gitlab's Maintainer). Neither is true by default. The row looked armed, the Pipelines view carried a warning
 * nobody was reading, and the automation simply never fired — the single worst failure an automation can have,
 * because nothing about it looks like a failure.
 *
 * So the reconciler's warnings are read as a WORK LIST rather than as an apology: every repo in
 * ciHooks.warnings() is a repo whose pipelines this polls for instead. A repo with a live hook is never
 * polled, which is what keeps the two from announcing the same run — the handover in either direction is a
 * repo appearing in or leaving that map, and the conclusion memory both paths share (ci/events.ts) means an
 * edge event stays correct across it.
 *
 * Deliberately NOT a general-purpose poller: it is not a safety net under a working webhook, and it does not
 * make the Pipelines view fresher (that view backfills on its own read). One job — the events an automation is
 * waiting for, on a sandbox where nothing can be delivered to. */

// Per repo, per pass. The list endpoint is one call; this only has to be deep enough that a burst of pushes
// between two passes can't push a finished run out of the window before it is seen.
const RUNS_PER_POLL = 20;

export interface CiPoller {
    readonly start: () => void;
    readonly stop: () => void;
    // One pass over every unwired repo; `start` runs it immediately and then on the interval. Exposed for
    // tests and for a caller that just changed what a pass polls (a capability apply, a hook reconcile).
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
        /* Never polled before: adopt the current picture in silence. Announcing it would mean that connecting a
         * capability — or restarting the daemon on a workspace whose ci.json was never written — replays every
         * red branch in the workspace as news, which is a wake per repo for things that happened yesterday.
         *
         * Silent about the WAKES, not about the memory: each branch's current colour is still recorded (oldest
         * run first, so the newest wins), which is what lets the very next run be recognized as an edge. */
        if (known === undefined) {
            for (const run of terminal.toReversed()) {
                await rememberCiRun(services, run);
            }
            await services.ciStore.recordAnnounced(project.repo, ids);
            return;
        }
        // Oldest-first: the conclusion memory is a sequence, so replaying two runs of one branch out of order
        // would decide `pipeline_broken`/`pipeline_fixed` against the wrong previous colour.
        const fresh = terminal.filter((run) => !known.includes(run.runId)).toReversed();
        for (const run of fresh) {
            // The same one-extra-call enrichment the webhook route makes, for the same reason: a wake that
            // cannot name the failing job sends the agent to go and find it.
            const failedJobs = run.status === "failed" ? await client.failedJobs(project, run.runId).catch(() => []) : [];
            const announced = failedJobs.length > 0 ? { ...run, failedJobs } : run;
            services.ciRuns.upsert(announced);
            const author =
                announced.authorName !== undefined
                    ? { id: announced.authorName, name: announced.authorName }
                    : { id: project.account.provider, name: project.account.provider };
            await dispatchCiRun(services, announced, author, wake);
        }
        // Written after the dispatches, so a daemon that dies mid-pass re-announces rather than loses. A repeat
        // wake about a pipeline is noise; a missed one is the failure this whole file exists to prevent.
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
            // Per repo, so one vendor refusing (a revoked token, a project that moved) doesn't stop the rest.
            await pollRepo(project).catch((error: unknown) => services.logger.warn({ err: error, repo: project.repo }, "ci: poll failed"));
        }
    };

    // Serialized on the reconciler's pattern: a manual poll during the interval's pass must not run two passes
    // against one announced-ids record.
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
