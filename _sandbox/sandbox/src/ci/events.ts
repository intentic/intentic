import type { PipelineRun, ListenerMessage } from "@intentic/sandbox-contract";
import { dispatchListenerMessage } from "../automations/listeners.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";

// Turns a finished PipelineRun into `ci` listener messages for the webhook (ci/webhook.routes.ts) and the poller
// (ci/poller.ts); the previous-conclusion memory is written only here. Canceled and skipped runs produce nothing.

// Provider name for CI triggers; one value for both vendors, narrowed by repo, branch and result, not by host.
export const CI_PROVIDER = "ci";
export const CI_EVENT_TYPES = new Set(["pipeline_failed", "pipeline_broken", "pipeline_succeeded", "pipeline_fixed"]);

// pipeline_broken/pipeline_fixed fire only when the previous conclusion is known; an unknown one is never guessed as
// the opposite color, so a cold start reports no edges.
const typesFor = (status: "failed" | "success", previous: "failed" | "success" | undefined): string[] =>
    status === "failed"
        ? ["pipeline_failed", ...(previous === "success" ? ["pipeline_broken"] : [])]
        : ["pipeline_succeeded", ...(previous === "failed" ? ["pipeline_fixed"] : [])];

const sha7 = (sha: string): string => sha.slice(0, 7);

const headline = (type: string, run: PipelineRun): string => {
    if (type === "pipeline_fixed") {
        return "CI fixed (back to green)";
    }
    if (type === "pipeline_broken") {
        return "CI just broke (was green)";
    }
    return run.status === "failed" ? "CI failed" : "CI passed";
};

const contentOf = (run: PipelineRun, type: string): string => {
    const jobs = run.failedJobs !== undefined && run.failedJobs.length > 0 ? `, failed jobs: ${run.failedJobs.join(", ")}` : "";
    return `${headline(type, run)}: ${run.repo} ${run.branch} @ ${sha7(run.sha)}${jobs}, ${run.url}`;
};

// channelId (repo) and branch are message fields, not `extra` keys, since a `ci` trigger narrows on them; `extra`
// carries only what a woken agent reads.
const ciMessageOf = (run: PipelineRun, type: string, author: { id: string; name: string }): ListenerMessage => ({
    provider: CI_PROVIDER,
    type,
    id: `${run.host}:${run.project}:${run.runId}:${type}`,
    channelId: run.repo,
    branch: run.branch,
    author,
    content: contentOf(run, type),
    timestamp: new Date().toISOString(),
    extra: {
        host: run.host,
        repo: run.repo,
        project: run.project,
        runId: run.runId,
        sha: run.sha,
        status: run.status,
        url: run.url,
        ...(run.failedJobs !== undefined ? { failedJobs: run.failedJobs } : {}),
        ...(run.durationSeconds !== undefined ? { durationSeconds: run.durationSeconds } : {}),
    },
});

// Whether this run is a result an automation can act on; canceled and skipped are outcomes, not results.
export const ciResultOf = (run: PipelineRun): "failed" | "success" | undefined =>
    run.status === "failed" || run.status === "success" ? run.status : undefined;

// Records this run's conclusion and returns the previous one. Call alone (no dispatch) to seed memory on a cold start,
// before any run needs a previous conclusion to edge against.
export const rememberCiRun = async (services: Services, run: PipelineRun): Promise<"failed" | "success" | undefined> => {
    const result = ciResultOf(run);
    if (result === undefined) {
        return undefined;
    }
    const previous = await services.ciStore.lastConclusion(run.repo, run.branch);
    await services.ciStore.recordConclusion(run.repo, run.branch, result, Date.now());
    return previous;
};

// Records the run's conclusion and dispatches the matching listener messages; returns the dispatched event types, empty
// if not a result. Conclusion is recorded before dispatch, so a wake cannot be replayed as the previous state by the
// next run.
export const dispatchCiRun = async (
    services: Services,
    run: PipelineRun,
    author: { id: string; name: string },
    wake: WakeFn,
): Promise<readonly string[]> => {
    const result = ciResultOf(run);
    if (result === undefined) {
        return [];
    }
    const types = typesFor(result, await rememberCiRun(services, run));
    for (const type of types) {
        await dispatchListenerMessage(services, ciMessageOf(run, type, author), wake);
    }
    return types;
};
