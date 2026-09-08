import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { headSha } from "../../git/changes/changes.js";
import type { IsolatedAgent, PersistedAgent } from "../registry/agents-store.js";
import { anchorOf, carriesContent } from "./agent-changes.js";
import { agentBranchTips } from "./agent-refs.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Whether an agent has an outstanding delta, asked of git live, not remembered from the last land: a stored verdict has
// no invalidation, so a hand-merge or another agent's land could leave a stale `conflict` pointing at nothing left to
// resolve. Turn lifecycle events (`error`, `interrupted`) stay persisted instead (agents-store.ts).

// `landed` and `idle` are both 'nothing outstanding' (the board's Finished lane): one reached main, one never had
// anything to land.
export type LandStanding = "conflict" | "ready" | "landed" | "idle";

export interface LandStandings {
    // The current verdict; `idle` for an agent no pass has reached yet, the same lane `landed` places a card in.
    readonly of: (id: string) => LandStanding;
    // An archived agent keeps whatever it was probed at while live, so refreshing a fleet of them costs nothing.
    // Branch-backed only: a workspace conversation owns no ref, so it rests at `idle`.
    readonly refresh: (entries: readonly IsolatedAgent[]) => Promise<boolean>;
    readonly forget: (ids: readonly string[]) => void;
}

// Every input to the verdict, not just the two shas: a land moves only `landedTip`, not HEAD or the tip, so keying on
// shas alone re-served a stale verdict right after a land. `conflicts`' presence, not content, is keyed too.
const keyOf = (
    conflicted: boolean,
    repos: readonly { composed: PersistedAgent["repos"][number]; head: string | undefined; tip: string | undefined }[],
): string =>
    [
        conflicted ? "refused" : "-",
        ...repos.map(({ composed, head, tip }) => `${composed.repo}@${head ?? "-"}:${tip ?? "-"}:${composed.landedTip ?? "-"}:${composed.base}`),
    ].join("|");

export const createLandStandings = (worktrees: AgentWorktrees, git: GitRunner = defaultGit): LandStandings => {
    const cache = new Map<string, { key: string; standing: LandStanding }>();
    return {
        of: (id) => cache.get(id)?.standing ?? "idle",
        forget: (ids) => {
            for (const id of ids) {
                cache.delete(id);
            }
        },
        refresh: async (entries) => {
            // Two reads per repo for the whole pass, not per agent: a fleet shares its workspace shas and branch tips.
            const heads = new Map<string, Promise<string | undefined>>();
            const headOf = (repo: string): Promise<string | undefined> => {
                let head = heads.get(repo);
                if (head === undefined) {
                    head = headSha(worktrees.mainDir(repo), git);
                    heads.set(repo, head);
                }
                return head;
            };
            const sweeps = new Map<string, Promise<Map<string, string>>>();
            const tipOf = async (repo: string, branch: string): Promise<string | undefined> => {
                let sweep = sweeps.get(repo);
                if (sweep === undefined) {
                    sweep = agentBranchTips(worktrees.mainDir(repo), git);
                    sweeps.set(repo, sweep);
                }
                return (await sweep).get(branch);
            };
            let moved = false;
            for (const entry of entries) {
                // Ref reads run in the main repo either way: the shared object store covers a retired worktree too.
                const shas = await Promise.all(
                    entry.repos.map(async (composed) => ({
                        composed,
                        head: await headOf(composed.repo),
                        tip: await tipOf(composed.repo, entry.branch),
                    })),
                );
                const conflicted = entry.conflicts !== undefined && entry.conflicts.length > 0;
                const key = keyOf(conflicted, shas);
                const cached = cache.get(entry.id);
                if (cached?.key === key) {
                    continue;
                }
                let outstanding = false;
                let produced = false;
                for (const { composed, tip } of shas) {
                    if (tip === undefined) {
                        continue; // The branch is gone: nothing of this agent's is left in this repo.
                    }
                    // Asked of the branch: hand-merged work shows here though it never landed via `landedTip`.
                    produced ||= tip !== composed.base;
                    const main = worktrees.mainDir(composed.repo);
                    // Both halves matter: a rebase can leave a branch ahead of an anchor that already holds all of it.
                    const anchor = await anchorOf(main, main, tip, composed.landedTip, composed.base, git);
                    if (anchor !== tip && (await carriesContent(main, anchor, tip, git))) {
                        outstanding = true;
                    }
                }
                // The report explains a refusal, it does not create one: nothing outstanding, nothing to be about.
                const standing: LandStanding = outstanding ? (conflicted ? "conflict" : "ready") : produced ? "landed" : "idle";
                moved ||= cached?.standing !== standing;
                cache.set(entry.id, { key, standing });
            }
            return moved;
        },
    };
};
