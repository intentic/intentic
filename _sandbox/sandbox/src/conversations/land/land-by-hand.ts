import { includeProducedFiles } from "../produced-files.js";
import type { AgentSpan, LandMode, LandResult } from "@intentic/sandbox-contract/schemas/agents";
import type { Services } from "../../composition.js";
import { reportChildConflict } from "./child-lands.js";
import { opt } from "../../opt.js";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { agentBranchTips } from "../../git/agent-refs.js";
import { type IsolatedAgent, isIsolated, type RepoRecord } from "../registry/agents-store.js";
import { landAgent, type LandOutcome } from "./land.js";
import { reportLandRepairs } from "./rederive.js";
import { intoOf, type LandTarget, landTargetOf, recordedTargetOf, upstreamOf, underLeases } from "./land-target.js";
import { keepLandFailure, settleParentBooks } from "./turn-landing.js";
import { syncBeforeLand } from "./sync.js";
import { settleLandingInBackground, versionCommitsSettled, versionProjectFolders } from "./version-landed.js";

// A land a person pressed: the same pre-land rebase an automatic land takes, then the installed tree reconciled behind
// it, as an automatic land does. Runs inside the conversation's land lease (landByHandLeased takes it). A spawned
// child's press goes where its turn's own land goes (land-target.ts): into its parent's checkout, under the parent's
// lease too, with none of the main tree's after-land. The same door is its parent's `merge`, in `merge` mode.

export type LandByHandDeps = Pick<Services, "agentWorktrees" | "agents" | "conversations" | "dependencies" | "events" | "history" | "logger" | "perf" | "turns" | "transcripts"> &
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
        const repos = entry.placement.repos.map(({ repo }) => repo);
        await versionCommitsSettled(services, repos);
        // What file sync delivered since the turn ended, committed so the rebase below reaches it (version-landed.ts).
        await versionProjectFolders(services, repos);
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
    reportLandRepairs(services.logger, entry.id, result);
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
export const landByHandLeased = async (services: LandByHandDeps, entry: IsolatedAgent, mode: LandMode, rung: AgentSpan, includeDocuments = false): Promise<LandResult> => {
    const target = await landTargetOf(services, entry);
    const into = intoOf(target);
    const result = await underLeases(services.conversations, entry.id, into, async () => {
        if (includeDocuments && mode !== "measure") {
            await includeProducedFiles(services, entry);
        }
        return landByHand(services, entry, mode, rung, target);
    });
    await settleParentBooks(services, { into, landed: result.landed });
    return result;
};

// WORK BROUGHT IN BY HAND, SAID SO. A land the sandbox refused leaves the work on the branch and the card in Attention
// until a land goes through. Somebody can bring that work in themselves instead (a patch applied, a fork resolving it
// against other work), and when they adapt it on the way the standing probe cannot recognise it by content
// (standing.ts absorbedIn), so nothing they do moves the card. On 2026-10-20 a parent applied a held child's diff with
// `git apply -3`, kept both sides of 21 clashing files and renumbered a version the child had claimed, and landed: the
// child read `conflict` for good, held its parent's card in Attention with it, and the only press that cleared it was
// Discard, which deletes the conversation.
//
// This is the press that says so. It records each repo's branch tip as landed where the work was headed, the parent's
// checkout or the main tree, through the registry's one land write (recordLanded), so the conflict report goes with it
// and the card files as landed. Nothing is written into any tree, and the branch keeps every commit: a later land of the
// same conversation carries only what is newer than this tip. It runs under the conversation's land lease, so it waits
// for a land under way and reads the record that land left.

export type SettleAnswer = { readonly settled: true; readonly repos: readonly string[] } | { readonly settled: false };

export interface SettleDeps {
    readonly agents: Pick<Services["agents"], "entry" | "recordLanded">;
    readonly conversations: Pick<Services["conversations"], "withLandLease">;
    readonly agentWorktrees: Pick<Services["agentWorktrees"], "mainDir">;
    readonly logger: Pick<Services["logger"], "info">;
}

/** Records a conversation's held work as brought in by hand; `settled: false` when it held nothing to record. */
export const settleByHand = (deps: SettleDeps, conversationId: string, git: GitRunner = defaultGit, now: number = Date.now()): Promise<SettleAnswer> =>
    deps.conversations.withLandLease(conversationId, async () => {
        const entry = deps.agents.entry(conversationId);
        return entry === undefined || !isIsolated(entry) ? { settled: false } : settle(deps, entry, git, now);
    });

const settle = async (deps: SettleDeps, entry: IsolatedAgent, git: GitRunner, now: number): Promise<SettleAnswer> => {
    const settled: string[] = [];
    const repos: RepoRecord[] = [];
    for (const composed of entry.placement.repos) {
        const tip = (await agentBranchTips(deps.agentWorktrees.mainDir(composed.repo), git)).get(entry.placement.branch);
        if (tip === undefined || tip === (composed.landedTip ?? composed.base)) {
            repos.push(composed);
            continue;
        }
        // No landedHead: nothing was written, so there is no write to attribute (origins.ts) or to look for in the tree
        // (landed-presence.ts). The tip alone is the rung the next delta is measured from.
        repos.push({ repo: composed.repo, base: composed.base, landedTip: tip, landedAt: now });
        settled.push(composed.repo);
    }
    if (settled.length === 0 && (entry.landing.conflicts ?? []).length === 0) {
        return { settled: false };
    }
    const outcome: LandOutcome = {
        landed: true,
        // Nothing reached a tree, so nothing is announced and no version is owed (land-marks.ts owesVersionCommit).
        changed: false,
        advanced: true,
        // A verdict, so it replaces the stored refusal rather than carrying it across.
        adjudicated: true,
        conflicts: [],
        repos,
        diff: entry.landing.diff ?? { files: 0, insertions: 0, deletions: 0 },
        ...opt("into", intoOf(recordedTargetOf(deps.agents, entry))),
    };
    await deps.agents.recordLanded(entry.id, outcome);
    deps.logger.info({ conversationId: entry.id, repos: settled }, "land: held work recorded as brought in by hand, nothing written");
    return { settled: true, repos: settled };
};
