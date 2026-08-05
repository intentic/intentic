import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { headSha } from "../git/changes.js";
import type { IsolatedAgent, PersistedAgent } from "./agents-store.js";
import { anchorOf } from "./agent-changes.js";
import { agentBranchTips } from "./agent-refs.js";
import type { AgentWorktrees } from "./worktrees.js";

/* WHERE AN AGENT'S WORK STANDS RELATIVE TO THE MAIN TREE — asked of git, not remembered from the last land.
 *
 * `ready`, `landed` and `conflict` used to be PERSISTED statuses: the land pass wrote its verdict onto the
 * entry and every surface read it back. But those three are not facts about the agent, they are answers to a
 * question about two shas — "does agent/<id> hold work the main line does not?" — and that question has a live
 * answer at every moment. A stored answer is a cache, and this one had no invalidation: nothing rewrote it when
 * the world moved underneath it. So a branch whose work reached main by another road — a user merging it by
 * hand, an agent told to commit onto the main line, another agent's land absorbing the same hunks — kept its
 * card on the last refusal for good, pointing at a conflict that no longer existed and could never be resolved
 * because there was nothing left to land. The Changes panel, which computes its side fresh, sat on the same
 * screen saying the agent had changed nothing.
 *
 * The turn lifecycle is the opposite kind of fact and stays persisted (agents-store.ts): `error` and
 * `interrupted` are events, not states of the world, and nothing but the entry remembers them.
 *
 * WHAT IS DERIVED, in one rule: an agent is `conflict` or `ready` exactly while it has an OUTSTANDING delta —
 * something at its tip that the anchor does not cover — and `conflict` only if the last land refused. Which
 * makes the stale-conflict case impossible rather than merely fixed: a conflict verdict has a premise, and once
 * the delta is empty the premise is gone whatever the report says. The anchor is land's own (anchorOf), so this
 * cannot drift from what a land would actually do — the same rung, asked as a question instead of taken as an
 * instruction.
 */

// `landed` and `idle` are the two shapes of "nothing outstanding": work that reached the main tree, and an
// agent that never had any (a turn that only answered a question). Both are the board's Finished lane.
export type LandStanding = "conflict" | "ready" | "landed" | "idle";

export interface LandStandings {
    // The current verdict. `idle` for an agent no pass has reached yet — the resting answer, and the one that
    // places a card in the same lane `landed` would.
    readonly of: (id: string) => LandStanding;
    /* Re-probe these agents, and say whether any VERDICT moved (the caller broadcasts on true, so a roster
     * read that changes nothing costs no revision).
     *
     * Callers pass the LIVE roster. An archived agent keeps whatever it was probed at while live — its checkout
     * is retired, its card is a record rather than a control, and `idle` and `landed` place it in the same lane
     * — so a fleet with a thousand of them still refreshes in the size of the work in flight.
     *
     * BRANCH-BACKED only, by type: a standing is a question about two shas, and a workspace conversation owns no
     * ref to ask it of. Its clean resting state is `idle`, projected in agents-registry.ts. */
    readonly refresh: (entries: readonly IsolatedAgent[]) => Promise<boolean>;
    readonly forget: (ids: readonly string[]) => void;
}

/* What a verdict was computed against — EVERY input to it, because a matching key skips the re-probe entirely.
 *
 * The two shas are the obvious half, and each moves on its own: the branch tip when the agent works, main's
 * HEAD when anyone commits — including the hand-merge that strands a conflict. They are NOT the whole question,
 * and a land is the case that proves it. Landing patches the main WORKING TREE: HEAD stays where it is, and the
 * tip was already there (the provenance commit happened when the turn ended). The only thing that moves is
 * `landedTip` — the rung anchorOf measures the outstanding delta from. Keyed on shas alone, the pass after a
 * land re-served the standing from before it, so a card kept offering "Land now" for work already sitting in
 * the user's workspace, until something unrelated happened to move a sha. `base` is the same kind of input, and
 * moves when a worktree is re-created under an existing entry.
 *
 * `conflicts` belongs here for the same reason on the failure path: it is what separates `conflict` from
 * `ready` over one identical delta, and a refused `check` land leaves the workspace byte-identical — its report
 * is the ONLY thing that changed. Only its presence is keyed, never its contents: which paths refused doesn't
 * enter the verdict (see the standing below), so a re-worded report of the same refusal is not a new answer. */
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
            /* Two reads per repo for the WHOLE pass, not per agent: a fleet shares its workspace, so the key of
             * every agent in it names the same handful of main-tree shas, and every branch tip the pass will ask
             * for is in the one ref sweep. Both memos are keyed on the repo and hold the in-flight promise, so
             * the repos an entry composes can be probed together without two of them racing to the same spawn. */
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
                // Ref reads run in the MAIN repo whether or not the checkout is attached: the object store is
                // shared, so a retired worktree's branch answers here exactly as its own dir would.
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
                        continue; // The branch is gone — nothing of this agent's is left in this repo.
                    }
                    // Did this agent ever write anything? Asked of the branch, NOT of `landedTip`: the entry
                    // records a tip only for a land this daemon performed, and the case that most needs the
                    // right answer here is the one where nobody did — work merged into the main line by hand
                    // leaves an entry that never landed anything and a branch that is nonetheless done.
                    produced ||= tip !== composed.base;
                    const main = worktrees.mainDir(composed.repo);
                    if ((await anchorOf(main, main, tip, composed.landedTip, composed.base, git)) !== tip) {
                        outstanding = true;
                    }
                }
                // The report explains a refusal; it does not create one. With nothing outstanding there is
                // nothing it could still be about — see the header.
                const standing: LandStanding = outstanding ? (conflicted ? "conflict" : "ready") : produced ? "landed" : "idle";
                moved ||= cached?.standing !== standing;
                cache.set(entry.id, { key, standing });
            }
            return moved;
        },
    };
};
