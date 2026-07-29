import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { headSha } from "../git/changes.js";
import type { PersistedAgent } from "./agents-store.js";
import { anchorOf, branchSha } from "./land.js";
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
     * — so a fleet with a thousand of them still refreshes in the size of the work in flight. */
    readonly refresh: (entries: readonly PersistedAgent[]) => Promise<boolean>;
    readonly forget: (ids: readonly string[]) => void;
}

// What a verdict was computed against. Both halves matter and each moves on its own: the branch tip changes
// when the agent works, main's HEAD when anyone commits — including the hand-merge that strands a conflict.
const keyOf = (repos: readonly { repo: string; head: string | undefined; tip: string | undefined }[]): string =>
    repos.map(({ repo, head, tip }) => `${repo}@${head ?? "-"}:${tip ?? "-"}`).join("|");

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
            // One HEAD read per repo for the whole pass, not per agent: a fleet shares its workspace, and the
            // key of every agent in it names the same handful of main-tree shas.
            const heads = new Map<string, string | undefined>();
            const headOf = async (repo: string): Promise<string | undefined> => {
                if (!heads.has(repo)) {
                    heads.set(repo, await headSha(worktrees.mainDir(repo), git));
                }
                return heads.get(repo);
            };
            let moved = false;
            for (const entry of entries) {
                // Ref reads run in the MAIN repo whether or not the checkout is attached: the object store is
                // shared, so a retired worktree's branch answers here exactly as its own dir would.
                const shas = await Promise.all(
                    entry.repos.map(async (composed) => ({
                        composed,
                        head: await headOf(composed.repo),
                        tip: await branchSha(worktrees.mainDir(composed.repo), entry.branch, git),
                    })),
                );
                const key = keyOf(shas.map(({ composed, head, tip }) => ({ repo: composed.repo, head, tip })));
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
                const standing: LandStanding = outstanding
                    ? entry.conflicts !== undefined && entry.conflicts.length > 0
                        ? "conflict"
                        : "ready"
                    : produced
                      ? "landed"
                      : "idle";
                moved ||= cached?.standing !== standing;
                cache.set(entry.id, { key, standing });
            }
            return moved;
        },
    };
};
