import type { LandConflictReason } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { headSha } from "../../git/changes/changes.js";
import type { IsolatedAgent, RepoRecord } from "../registry/agents-store.js";
import { checkpointOf, carriesContent } from "./agent-changes.js";
import { agentBranchTips } from "./agent-refs.js";
import { dirtyPaths } from "./land.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Whether an agent has an outstanding delta, asked of git live, not remembered from the last land: a stored verdict has
// no invalidation, so a hand-merge or another agent's land could leave a stale `conflict` pointing at nothing left to
// resolve. Turn lifecycle events (`error`, `interrupted`) stay persisted instead (agents-store.ts).

// `landed` and `idle` are both 'nothing outstanding' (the board's Finished lane): one reached main, one never had
// anything to land.
export type LandStanding = "conflict" | "ready" | "landed" | "idle";

// Fixed order, so a cache key built from a cause set is stable however the report listed its paths.
const CAUSES: readonly LandConflictReason[] = ["workspace", "diverged", "binary"];

// What a stored refusal still amounts to today. `stands` is the gate the verdict reads; `causes` is who can clear what
// is left, which the board needs to offer a press that can actually work.
interface Refusal {
    readonly stands: boolean;
    readonly causes: readonly LandConflictReason[];
}

const NOTHING: Refusal = { stands: false, causes: [] };

// One repo of a composition as this pass read it.
interface RepoShas {
    readonly composed: RepoRecord;
    readonly head: string | undefined;
    readonly tip: string | undefined;
}

export interface LandStandings {
    // The current verdict; `idle` for an agent no pass has reached yet, the same lane `landed` places a card in.
    readonly of: (id: string) => LandStanding;
    // Which causes of a refused land still hold, in report order; empty for every standing but `conflict`.
    readonly causesOf: (id: string) => readonly LandConflictReason[];
    // An archived agent keeps whatever it was probed at while live, so refreshing a fleet of them costs nothing.
    // Branch-backed only: a workspace conversation owns no ref, so it rests at `idle`.
    readonly refresh: (entries: readonly IsolatedAgent[]) => Promise<boolean>;
    readonly forget: (ids: readonly string[]) => void;
}

// Every input to the verdict, not just the two shas: a land moves only `landedTip`, not HEAD or the tip, so keying on
// shas alone re-served a stale verdict right after a land. The refusal is keyed by what still stands, not by the stored
// report's presence: a `workspace` blocker the user has since cleared moves no sha, so nothing else here would notice.
const keyOf = (refusal: Refusal, repos: readonly RepoShas[]): string =>
    [
        refusal.stands ? `refused:${refusal.causes.join("+")}` : "-",
        ...repos.map(({ composed, head, tip }) => `${composed.repo}@${head ?? "-"}:${tip ?? "-"}:${composed.landedTip ?? "-"}:${composed.base}`),
    ].join("|");

// Whether one path of the main checkout still holds uncommitted work; what a `workspace` blocker's premise amounts to.
type DirtyRead = (path: string) => boolean;

// One status read per repo turned into that question. A read that failed answers yes to everything: an unreadable tree
// is no proof the user's edits went, and clearing a refusal on no evidence is the failure this whole module guards.
const readDirty = async (main: string, git: GitRunner): Promise<DirtyRead> => {
    const paths = await dirtyPaths(main, git).catch(() => undefined);
    return paths === undefined ? () => true : (path) => paths.has(path);
};

// Which of a stored report's blockers still have their premise. `diverged` and `binary` are premised on the two shas
// this standing already keys on, so they stand until a land re-judges them; a `workspace` blocker is premised on the
// user's uncommitted edits, which move with nothing keyed here, so it is the one re-read live. A report with no paths
// at all is a repo the land could not reach, which nothing here can re-probe, so it stands.
// A premise, not a verdict: land itself is the only thing that decides whether a patch applies, and it re-judges on the
// next pass. Leaning towards clearing is deliberate — a wrong `ready` costs one refused land, which arms the report
// again, while a wrong `conflict` is the dead end this exists to end.
const refusalOf = async (entry: IsolatedAgent, dirtyAt: (repo: string, path: string) => Promise<boolean>): Promise<Refusal> => {
    const conflicts = entry.landing.conflicts ?? [];
    if (conflicts.length === 0) {
        return NOTHING;
    }
    const held = new Set<LandConflictReason>();
    let unreachable = false;
    for (const conflict of conflicts) {
        unreachable ||= conflict.paths.length === 0;
        for (const blocked of conflict.paths) {
            if (blocked.reason !== "workspace" || (await dirtyAt(conflict.repo, blocked.path))) {
                held.add(blocked.reason);
            }
        }
    }
    const causes = CAUSES.filter((cause) => held.has(cause));
    return { stands: unreachable || causes.length > 0, causes };
};

// The per-repo reads one pass shares across the whole fleet, each spawned at most once: a fleet sees the same workspace
// shas and the same branch-tip sweep, and the dirty read is reached only from a stored `workspace` blocker, so an
// ordinary board never pays for it at all.
const passReaders = (worktrees: AgentWorktrees, git: GitRunner) => {
    const heads = new Map<string, Promise<string | undefined>>();
    const sweeps = new Map<string, Promise<Map<string, string>>>();
    const dirt = new Map<string, Promise<DirtyRead>>();
    const memo = <T>(cache: Map<string, Promise<T>>, repo: string, read: () => Promise<T>): Promise<T> => {
        let held = cache.get(repo);
        if (held === undefined) {
            held = read();
            cache.set(repo, held);
        }
        return held;
    };
    return {
        headOf: (repo: string): Promise<string | undefined> => memo(heads, repo, () => headSha(worktrees.mainDir(repo), git)),
        tipOf: async (repo: string, branch: string): Promise<string | undefined> =>
            (await memo(sweeps, repo, () => agentBranchTips(worktrees.mainDir(repo), git))).get(branch),
        dirtyAt: async (repo: string, path: string): Promise<boolean> =>
            (await memo(dirt, repo, () => readDirty(worktrees.mainDir(repo), git)))(path),
    };
};

// Whether the branch still carries content the main line has not absorbed, and whether it ever carried any: the two
// halves of "outstanding" that the stored refusal is only ever an explanation of.
const deltaOf = async (worktrees: AgentWorktrees, repos: readonly RepoShas[], git: GitRunner): Promise<{ outstanding: boolean; produced: boolean }> => {
    let outstanding = false;
    let produced = false;
    for (const { composed, head, tip } of repos) {
        if (tip === undefined) {
            continue; // The branch is gone: nothing of this agent's is left in this repo.
        }
        // Asked of the branch: hand-merged work shows here though it never landed via `landedTip`.
        produced ||= tip !== composed.base;
        const main = worktrees.mainDir(composed.repo);
        // Both halves matter: a rebase can leave a branch ahead of an anchor that already holds all of it.
        const anchor = await checkpointOf(main, main, tip, composed.landedTip, composed.base, git);
        if (anchor === tip || !(await carriesContent(main, anchor, tip, git))) {
            continue;
        }
        // Rewriting main (a rebase, a force-push) drags the anchor back behind content main already holds, which would
        // re-offer the whole delta; measured against main's own tree instead, a tip main already holds has nothing left.
        // The review keeps listing those paths as absorbed, which is why this reading lives here and not in the anchor.
        if (head !== undefined && !(await carriesContent(main, head, tip, git))) {
            continue;
        }
        outstanding = true;
    }
    return { outstanding, produced };
};

export const createLandStandings = (worktrees: AgentWorktrees, git: GitRunner = defaultGit): LandStandings => {
    const cache = new Map<string, { key: string; standing: LandStanding; causes: readonly LandConflictReason[] }>();
    return {
        of: (id) => cache.get(id)?.standing ?? "idle",
        causesOf: (id) => cache.get(id)?.causes ?? [],
        forget: (ids) => {
            for (const id of ids) {
                cache.delete(id);
            }
        },
        refresh: async (entries) => {
            const { headOf, tipOf, dirtyAt } = passReaders(worktrees, git);
            let moved = false;
            for (const entry of entries) {
                // Ref reads run in the main repo either way: the shared object store covers a retired worktree too.
                const shas = await Promise.all(
                    entry.placement.repos.map(async (composed) => ({
                        composed,
                        head: await headOf(composed.repo),
                        tip: await tipOf(composed.repo, entry.placement.branch),
                    })),
                );
                const refusal = await refusalOf(entry, dirtyAt);
                const key = keyOf(refusal, shas);
                const cached = cache.get(entry.id);
                if (cached?.key === key) {
                    continue;
                }
                const { outstanding, produced } = await deltaOf(worktrees, shas, git);
                // The report explains a refusal, it does not create one: nothing outstanding, nothing to be about.
                const standing: LandStanding = outstanding ? (refusal.stands ? "conflict" : "ready") : produced ? "landed" : "idle";
                // Causes ride only their own verdict: a report that outlived its delta says nothing about the card.
                const causes = standing === "conflict" ? refusal.causes : [];
                moved ||= cached?.standing !== standing || cached.causes.join("+") !== causes.join("+");
                cache.set(entry.id, { key, standing, causes });
            }
            return moved;
        },
    };
};
