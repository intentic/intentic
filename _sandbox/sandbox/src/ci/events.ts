import { isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { CI_PROVIDER } from "../automations/catalog.js";
import { dispatchListenerMessage } from "../automations/listeners.js";
import type { Services } from "../composition.js";
import { publishCiFeed } from "../seams/ci-feed-bus.js";
import { mainLinesClaimed } from "./main-line-claims.js";
import { isMainLine } from "./main-line.js";
import type { CiProject } from "./projects.js";

// Turns a finished PipelineRun into `ci` listener messages for the webhook (ci/webhook.routes.ts) and the poller
// (ci/poller.ts), and into a `run` frame on the CI feed for programs (feed/ci-feed.ts), however it ended; the
// previous-conclusion memory is written only here. Canceled and skipped runs produce no message, but reach the feed,
// where main's fix agent (the pipelines extension's) hears what passed in a cancelled run. While an extension claims main
// lines' failures (main-line-claims.ts), a repository's main line failing is that extension's one fix agent's, so its
// failure events reach no automation listening on every branch: one failed main run starts one agent, and none is told
// to push its own fix to main beside it.

// pipeline_broken/pipeline_fixed fire only when the previous conclusion is known; an unknown one is never guessed as
// the opposite verdict, so a cold start reports no edges.
const typesFor = (status: "failed" | "success", previous: "failed" | "success" | undefined): string[] =>
    status === "failed"
        ? ["pipeline_failed", ...(previous === "success" ? ["pipeline_broken"] : [])]
        : ["pipeline_succeeded", ...(previous === "failed" ? ["pipeline_fixed"] : [])];

const sha7 = (sha: string): string => sha.slice(0, 7);

const headline = (type: string, run: PipelineRun): string => {
    if (type === "pipeline_fixed") {
        return "CI fixed (passing again)";
    }
    if (type === "pipeline_broken") {
        return "CI just broke (was passing)";
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

// Whether the run's failure belongs to an extension's fix agent rather than to the `ci` automations.
const claimedFailure = async (services: Services, project: CiProject, run: PipelineRun): Promise<boolean> =>
    run.status === "failed" && (await mainLinesClaimed(services)) && (await isMainLine(services, project, run.branch));

// Records the run's conclusion, puts it on the CI feed and dispatches the matching listener messages. Conclusion is
// recorded before dispatch, so a wake cannot be replayed as the previous state by the next run. Answers the event types
// the run produced, dispatched or not; empty if not a result.
export const dispatchCiRun = async (services: Services, project: CiProject, run: PipelineRun, author: { id: string; name: string }): Promise<readonly string[]> => {
    if (!isPipelineInFlight(run.status)) {
        // First, and whatever it ended as: a program reading the feed (the Deployments extension, main's fix agent)
        // decides what a run means.
        publishCiFeed({ kind: "run", run });
    }
    const result = ciResultOf(run);
    if (result === undefined) {
        return [];
    }
    const types = typesFor(result, await rememberCiRun(services, run));
    // An automation that names the branch asked for exactly these events (a notice when main fails), so it still hears
    // them; one listening on every branch, as the "Fix failing CI" template does, would be a second agent on main.
    const hears = (await claimedFailure(services, project, run)) ? (trigger: { readonly branch?: string | undefined }) => trigger.branch !== undefined : undefined;
    for (const type of types) {
        await dispatchListenerMessage(services, ciMessageOf(run, type, author), undefined, undefined, hears);
    }
    return types;
};
