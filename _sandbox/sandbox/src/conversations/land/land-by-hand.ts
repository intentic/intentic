import type { AgentSpan, LandMode, LandResult } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import type { IsolatedAgent, RepoRecord } from "../registry/agents-store.js";
import { landAgent, reportLockfileFailures } from "./land.js";
import { syncBeforeLand } from "./sync.js";
import { verifyLandedTree } from "./verify-landed.js";
import { settleLandingInBackground, versionCommitsSettled } from "./version-landed.js";

// A land a person pressed: the same pre-land rebase an automatic land takes, then the whole repository's check queued
// behind it. Runs inside the conversation's land lease, which the route holds.

export type LandByHandDeps = Pick<Services, "agentWorktrees" | "agents" | "conversations" | "events" | "history" | "logger" | "perf"> &
    Parameters<typeof verifyLandedTree>[0] &
    Parameters<typeof settleLandingInBackground>[0];

// The composition a manual land applies: the same pre-land rebase as auto-land, with `base` moved onto what each
// repo now sits on. A git fault here lands on the old base instead of failing the land.
const syncedComposition = async (services: LandByHandDeps, entry: IsolatedAgent): Promise<RepoRecord[]> => {
    try {
        return [
            ...(await syncBeforeLand(
                services.agentWorktrees,
                { id: entry.id, title: entry.social.title?.text, repos: entry.placement.repos },
                services.agents.recordWorktree,
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

export const landByHand = async (services: LandByHandDeps, entry: IsolatedAgent, mode: LandMode, rung: AgentSpan): Promise<LandResult> => {
    // As an automatic land does (turn-landing.ts): another land's version commit first, so its work is history here.
    await versionCommitsSettled(
        services,
        entry.placement.repos.map(({ repo }) => repo),
    );
    const composition = await syncedComposition(services, entry);
    // Snapshotted after the sync: a rebase orphans the sha a stale span would name.
    const span = composition.map(({ repo, base, landedTip }) => ({
        repo,
        from: rung === "cumulative" ? base : (landedTip ?? base),
        dir: services.agentWorktrees.worktreeDir(entry.id, repo),
    }));
    const result = await services.perf.track("agent.land", { id: entry.id, mode, span: rung }, () =>
        landAgent(services.agentWorktrees, { ...entry, placement: { ...entry.placement, repos: composition } }, mode, rung),
    );
    reportLockfileFailures(services.logger, entry.id, result);
    // Stores the tips and conflict report, re-derives standing, and clears the prior ending without a turn.
    await services.agents.recordLanded(entry.id, result);
    // Only on a resting agent: a running turn would have its mutex freed and its ending overwritten.
    if (!services.conversations.running(entry.id)) {
        await services.conversations.send(entry.id, { kind: "settle" }).settled;
    }
    if (result.landed && result.changed) {
        announceLanded(services, entry, span);
        // The whole repository's check, the same one an auto-land queues; the Land button used to skip it, which
        // is how a week of lands produced a dozen verdicts.
        void verifyLandedTree(
            services,
            {
                kind: "land",
                agentId: entry.id,
                ...opt("title", entry.social.title?.text),
                branch: entry.placement.branch,
                repos: [...span],
            },
        ).catch((error: unknown) => services.logger.warn({ err: error, id: entry.id }, "agents: land verify could not be queued"));
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
