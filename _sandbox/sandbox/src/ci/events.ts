import type { PipelineRun } from "@intentic/sandbox-contract";
import type { ListenerMessage } from "@intentic/sandbox-contract";
import { dispatchListenerMessage } from "../automations/listeners.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";

/* What a finished pipeline SAYS to the automations layer — the one place a PipelineRun becomes `ci` listener
 * messages, shared by the two things that can learn a run finished: the provider webhook (ci/webhook.routes.ts)
 * and the REST poller that stands in for it when hooks could not be registered (ci/poller.ts).
 *
 * It lives apart from both because the interesting logic is neither vendor's: which of the four event types a
 * terminal run is, which needs the PREVIOUS conclusion on that repo+branch, which is why the conclusion memory
 * (ci-store.ts) is written here rather than at either call site. Two copies of that would be two answers to
 * "was this branch already red", and the poller's copy would be the one nobody re-read.
 *
 * Canceled and skipped runs produce nothing: they are outcomes, not results, and an automation woken by a
 * cancelled pipeline has nothing to do about it. */

// `ci` — the core listener provider automations name, alongside `webchat` the other source with no gateway
// extension behind it. One provider for both vendors: a trigger narrows by repo, branch and result, not by who
// hosts the pipeline.
export const CI_PROVIDER = "ci";
export const CI_EVENT_TYPES = new Set(["pipeline_failed", "pipeline_broken", "pipeline_succeeded", "pipeline_fixed"]);

/* The two EDGE events, and why they are worth their own types.
 *
 * `pipeline_failed` fires on every red run, which is the honest reading of "CI failed" and also, on a branch
 * that has been red for a day, a wake every push about a thing already known. `pipeline_broken` is the moment
 * it WENT red — red after a known green — and is what a "tell me when main breaks" automation actually means.
 * `pipeline_fixed` is its mirror and predates it; the pair is now symmetric.
 *
 * Both edges require a KNOWN previous conclusion rather than treating an unknown one as the opposite colour.
 * A daemon that has never seen a branch knows nothing about an edge, and guessing would make the first pass
 * after a restart — or after connecting a capability — announce that every red branch in the workspace just
 * broke. */
const typesFor = (status: "failed" | "success", previous: "failed" | "success" | undefined): string[] =>
    status === "failed"
        ? ["pipeline_failed", ...(previous === "success" ? ["pipeline_broken"] : [])]
        : ["pipeline_succeeded", ...(previous === "failed" ? ["pipeline_fixed"] : [])];

const sha7 = (sha: string): string => sha.slice(0, 7);

const headline = (type: string, run: PipelineRun): string => {
    if (type === "pipeline_fixed") return "CI fixed (back to green)";
    if (type === "pipeline_broken") return "CI just broke (was green)";
    return run.status === "failed" ? "CI failed" : "CI passed";
};

const contentOf = (run: PipelineRun, type: string): string => {
    const jobs = run.failedJobs !== undefined && run.failedJobs.length > 0 ? ` — failed jobs: ${run.failedJobs.join(", ")}` : "";
    return `${headline(type, run)}: ${run.repo} ${run.branch} @ ${sha7(run.sha)}${jobs} — ${run.url}`;
};

// `channelId` is the workspace repo and `branch` the ref — the two axes a `ci` trigger narrows on, so both are
// message fields rather than keys in `extra`, which carries only what the woken agent reads.
export const ciMessageOf = (run: PipelineRun, type: string, author: { id: string; name: string }): ListenerMessage => ({
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

// Whether this run is a RESULT — something an automation could act on. Canceled and skipped are outcomes, not
// results, and produce nothing on either path.
export const ciResultOf = (run: PipelineRun): "failed" | "success" | undefined =>
    run.status === "failed" || run.status === "success" ? run.status : undefined;

/* Teach the conclusion memory what this run means for its branch, and hand back what the branch was BEFORE it.
 *
 * The poller's first pass over a repo calls this ALONE: adopting the picture it finds has to leave the memory
 * knowing the current colour of every branch without waking anything, or the first real run after a cold start
 * has no previous colour to be an edge against and the `pipeline_broken` nobody wanted to miss is exactly the
 * one that gets missed. */
export const rememberCiRun = async (services: Services, run: PipelineRun): Promise<"failed" | "success" | undefined> => {
    const result = ciResultOf(run);
    if (result === undefined) {
        return undefined;
    }
    const previous = await services.ciStore.lastConclusion(run.repo, run.branch);
    await services.ciStore.recordConclusion(run.repo, run.branch, result, Date.now());
    return previous;
};

/* Record what this run means for its branch and wake whatever is listening. Returns the event types it
 * dispatched — empty for a run that is not a result, which is how a caller tells "nothing to say" from "said
 * something nobody was listening to" (dispatchListenerMessage's own return is the matched automations).
 *
 * The conclusion is recorded BEFORE the wakes so a fire that outlives this call cannot be re-read as the
 * previous state by the next run of the same branch. */
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
