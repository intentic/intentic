import type { PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import type { CiFailure } from "./ci-store.js";
import { fixerOf, isMainsOwn, type WorkflowSpan } from "./main-streak.js";
import type { CiProject } from "./projects.js";
import { ciClientFor, type FetchFn } from "./providers.js";

/* HOW MAIN'S FAILURE COMES OFF, and what main's fix agent says about it on the way: the best-effort steps every door of
   main-fixer.ts shares, the end of a streak in each of the ways it can end, and the boot's filling in of what a failure
   kept before workflows were timed apart does not know. */

// Where a best-effort step failed, for its log line.
interface Where {
    readonly repo?: string;
    readonly runId?: number;
    readonly jobId?: number;
    readonly fixer?: string;
    readonly type?: string;
}

// A best-effort step: what it answers, or, when it throws, the fallback, with the failure logged. Nothing the fixer does
// may fail the delivery or the pass that brought it the news.
export const orElse = async <T>(services: Pick<Services, "logger">, work: Promise<T>, fallback: T, message: string, where: Where): Promise<T> => {
    try {
        return await work;
    } catch (error) {
        services.logger.warn({ ...where, err: error }, message);
        return fallback;
    }
};

export const tell = (services: Services, type: string, content: string, outcome: "ok" | "error", conversationId?: string): void => {
    void orElse(
        services,
        services.activity.append({ direction: "system", type, content, outcome, ...opt("conversationId", conversationId) }),
        undefined,
        "ci repair: activity append failed",
        { type },
    );
};

// How a streak ended: a run of every workflow on it passed (`passed`); every job that failed on it passed since, in runs
// that did not pass whole (`recovered`); a person set it aside (`set-aside`); or what was left on it is measured by
// nothing any more, a workflow that has not run for MAIN_FAILURE_STALE_MS or a run that is not main's CI (`unmeasured`).
type StreakEnd =
    | { readonly kind: "passed" | "recovered"; readonly run: PipelineRun }
    | { readonly kind: "set-aside" }
    | { readonly kind: "unmeasured" };

// The sentence the activity feed says a streak ended in, after the branch and the repository.
const endedAs = (end: StreakEnd, minutes: number, runs: number): string => {
    const lasted = `${minutes} min and ${runs} failed run(s) after it began failing`;
    switch (end.kind) {
        case "passed":
            return `passed again at ${end.run.sha.slice(0, 7)}, ${lasted}`;
        case "recovered":
            return `no longer fails: every job that failed on it has passed since, the last of them in run ${end.run.runId} at ${end.run.sha.slice(0, 7)}, ${lasted}`;
        case "set-aside":
            return `was set aside by hand, ${lasted}`;
        default:
            return `no longer counts as failing: nothing measures what still failed on it (a run that is not main's CI, or a workflow that has not run for two weeks), ${lasted}`;
    }
};

// The streak is over: said, logged with what it cost, and a fix agent still working told it may stop.
const ended = async (services: Services, repo: string, branch: string, streak: CiFailure, end: StreakEnd): Promise<void> => {
    await services.ciStore.failure(repo, branch, () => undefined);
    publishRuntimeChange("ci");
    const fixer = fixerOf(streak);
    const agent = fixer === undefined ? undefined : services.agents.get(fixer);
    const lastedMs = Date.now() - streak.since;
    services.logger.info(
        {
            repo,
            branch,
            how: end.kind,
            lastedMs,
            runs: streak.count,
            turns: streak.turns,
            handedOver: streak.decisions.some((decision) => decision.kind === "spent"),
            fixer,
            costUsd: agent?.costUsd,
            inputTokens: agent?.inputTokens,
            outputTokens: agent?.outputTokens,
        },
        "ci repair: streak ended",
    );
    const minutes = Math.max(1, Math.round(lastedMs / 60_000));
    const cost = agent?.costUsd === undefined ? "" : `, for $${agent.costUsd.toFixed(2)}`;
    tell(
        services,
        "ci.repair_retired",
        `${branch} of ${repo} ${endedAs(end, minutes, streak.count)}${fixer === undefined ? "" : `; its fix agent took ${streak.turns} turn(s)${cost}`}.`,
        "ok",
        fixer,
    );
    if (fixer !== undefined && services.conversations.running(fixer)) {
        const why = "run" in end ? `passed in run ${end.run.runId}: main no longer fails` : `no longer counts as failing`;
        await orElse(
            services,
            services.turns.steer(fixer, { text: `${branch} of "${repo}" ${why}. Finish what you are doing without starting anything new.`, voice: "sandbox" }),
            false,
            "ci repair: the fix agent could not be told main passes again",
            { fixer },
        );
    }
};

// The streak as a change made it: kept, or ended the way `end` says once no workflow is left on it. Called under the
// branch's lock, with `next` worked out from the streak read under it.
export const setDown = async (services: Services, repo: string, branch: string, streak: CiFailure, next: CiFailure | undefined, end: StreakEnd): Promise<void> => {
    if (next === undefined) {
        await ended(services, repo, branch, streak, end);
        return;
    }
    if (next !== streak) {
        await services.ciStore.failure(repo, branch, (current) => (current === undefined ? current : next));
        publishRuntimeChange("ci");
    }
};

// What the forge says of each workflow a failure kept before 2026-11-03 holds with no times: when its newest failed run
// failed and what set it off, and since when it fails, which is after its newest pass when one is on file, else since the
// streak began. A run the forge will not answer for is left to the next boot. Read outside the branch's lock, since it
// asks the forge; main-streak.ts withLearnedSpans merges it under the lock.
export const timedApart = async (
    services: Services,
    project: CiProject,
    branch: string,
    streak: CiFailure,
    fetchFn: FetchFn,
): Promise<Readonly<Record<string, WorkflowSpan | "not-mains">>> => {
    const client = ciClientFor(project.account.provider, fetchFn);
    const passes = await services.ciStore.passes(project.repo, branch);
    const createdAt = async (runId: number | undefined): Promise<PipelineRun | undefined> =>
        runId === undefined
            ? undefined
            : orElse(services, client.run(project, runId), undefined, "ci repair: a failing workflow's run could not be read", { repo: project.repo, runId });
    const learned: Record<string, WorkflowSpan | "not-mains"> = {};
    for (const [workflow, runId] of Object.entries(streak.workflows).filter(([name]) => streak.spans[name] === undefined)) {
        const failed = await createdAt(runId);
        if (failed === undefined) {
            continue;
        }
        if (!isMainsOwn(failed.trigger)) {
            learned[workflow] = "not-mains";
            continue;
        }
        const passed = await createdAt(passes[workflow]);
        learned[workflow] = { since: Math.max(streak.since, passed?.createdAt ?? 0), failedAt: failed.createdAt, ...opt("trigger", failed.trigger) };
    }
    return learned;
};
