import type { AgentSpan, LandMode, LandResult } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { reportChildConflict } from "../../agent/subagents/child-lands.js";
import { opt } from "../../opt.js";
import type { IsolatedAgent, RepoRecord } from "../registry/agents-store.js";
import { landAgent, reportLockfileFailures } from "./land.js";
import { intoOf, type LandTarget, landTargetOf, upstreamOf, underLeases } from "./land-target.js";
import { keepLandFailure, settleParentBooks } from "../../agent/run/placement/turn-landing.js";
import { syncBeforeLand } from "./sync.js";
import { settleLandingInBackground, versionCommitsSettled } from "./version-landed.js";

// A land a person pressed: the same pre-land rebase an automatic land takes, then the installed tree reconciled behind
// it, as an automatic land does. Runs inside the conversation's land lease (landByHandLeased takes it). A spawned
// child's press goes where its turn's own land goes (land-target.ts): into its parent's checkout, under the parent's
// lease too, with none of the main tree's after-land. The same door is its parent's `merge`, in `merge` mode.

export type LandByHandDeps = Pick<Services, "agentWorktrees" | "agents" | "conversations" | "dependencies" | "events" | "history" | "logger" | "perf" | "turns"> &
    Parameters<typeof settleLandingInBackground>[0];

// The composition a manual land applies: the same pre-land rebase as auto-land, with `base` moved onto what each
// repo now sits on. A git fault here lands on the old base instead of failing the land.
const syncedComposition = async (services: LandByHandDeps, entry: IsolatedAgent, target: LandTarget): Promise<RepoRecord[]> => {
    try {
        return [
            ...(await syncBeforeLand(
                services.agentWorktrees,
                { id: entry.id, title: entry.social.title?.text, repos: entry.placement.repos },
                services.agents.recordWorktree,
                upstreamOf(entry, target),
            )),
        ];
    } catch (error) {
        services.logger.warn({ err: error, id: entry.id }, "agents: pre-land sync failed, landing on the old base");
        return [...entry.placement.repos];
    }
};

// What a land that reached the tree sets in motion: the commit-box chip's draft (not awaited), the user-write
// attribution (same convention as git.discard), and the workspace event.
const announceLanded = (services: LandByHandDeps, entry: IsolatedAgent, span: readonly { repo: string; from: string; dir: string }[]): void => {
    settleLandingInBackground(services, entry.id);
    services.history.notifyUserWrite();
    services.events.publish("workspace", {
        event: "agent.landed",
        agentId: entry.id,
        ...opt("title", entry.social.title?.text),
        branch: entry.placement.branch,
        outcome: "landed",
        repos: [...span],
    });
};

export const landByHand = async (services: LandByHandDeps, entry: IsolatedAgent, mode: LandMode, rung: AgentSpan, target: LandTarget): Promise<LandResult> => {
    const into = intoOf(target);
    // As an automatic land does (turn-landing.ts): another land's version commit first, so its work is history here.
    if (into === undefined) {
        await versionCommitsSettled(
            services,
            entry.placement.repos.map(({ repo }) => repo),
        );
    }
    const composition = await syncedComposition(services, entry, target);
    // Snapshotted after the sync: a rebase orphans the sha a stale span would name.
    const span = composition.map(({ repo, base, landedTip }) => ({
        repo,
        from: rung === "cumulative" ? base : (landedTip ?? base),
        dir: services.agentWorktrees.worktreeDir(entry.id, repo),
    }));
    // A land that breaks stays on the card until one goes through (recordLandFailure); the press still hears the error.
    const result = await services.perf
        .track("agent.land", { id: entry.id, mode, span: rung }, () =>
            landAgent(services.agentWorktrees, { ...entry, placement: { ...entry.placement, repos: composition } }, mode, rung, into),
        )
        .catch(async (cause: unknown) => {
            await keepLandFailure(services, entry.id, cause);
            throw cause;
        });
    reportLockfileFailures(services.logger, entry.id, result);
    // Stores the tips and conflict report, re-derives standing, and clears the prior ending without a turn.
    await services.agents.recordLanded(entry.id, result);
    // A spawned child's parent, still supervising, is told its press met a conflict and nothing reached the tree. A
    // press into the parent's own checkout is the parent's to answer, and its door (`merge`) answers it in the reply.
    if (into === undefined && !result.landed && result.held !== true && (result.conflicts?.length ?? 0) > 0) {
        void reportChildConflict(
            services,
            entry.id,
            (result.conflicts ?? []).flatMap(({ repo, paths }) => paths.map(({ path }) => (repo === "root" ? path : `${repo}/${path}`))),
        );
    }
    // Only on a resting agent: a running turn would have its mutex freed and its ending overwritten.
    if (!services.conversations.running(entry.id)) {
        await services.conversations.send(entry.id, { kind: "settle" }).settled;
    }

    if (into === undefined && result.landed && result.changed) {
        announceLanded(services, entry, span);
        // The install a moved manifest owes, the same one an auto-land reconciles.
        void services.dependencies
            .reconcileLand({
                kind: "land",
                agentId: entry.id,
                ...opt("title", entry.social.title?.text),
                branch: entry.placement.branch,
                repos: [...span],
            })
            .catch((error: unknown) => services.logger.warn({ err: error, id: entry.id }, "agents: the installed tree could not be reconciled after the land"));
    }
    return {
        landed: result.landed,
        // Carried, not dropped: a press that found nothing on the branch is the one outcome the review can't
        // see for itself, and it used to reach the button as plain success.
        changed: result.changed,
        ...(result.conflicts !== undefined ? { conflicts: result.conflicts } : {}),
        // A `merge` land's leftover-conflict paths; omitting it blanked the panel's finish-N-files strip.
        ...(result.resolving !== undefined ? { resolving: result.resolving } : {}),
        ...(result.held === true ? { held: true } : {}),
    };
};

// The press whole: where the work goes decided first, then the land under the lease of every checkout it writes, and a
// parent that took it brought up to date once those leases are free (its own measure takes its lease again).
export const landByHandLeased = async (services: LandByHandDeps, entry: IsolatedAgent, mode: LandMode, rung: AgentSpan): Promise<LandResult> => {
    const target = await landTargetOf(services, entry);
    const into = intoOf(target);
    const result = await underLeases(services.conversations, entry.id, into, () => landByHand(services, entry, mode, rung, target));
    await settleParentBooks(services, { into, landed: result.landed });
    return result;
};
