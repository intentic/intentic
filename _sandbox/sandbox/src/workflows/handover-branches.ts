import { join } from "node:path";
import type { RepoBase } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { branchSha } from "../agents/agent-refs.js";

/* WHICH REPOSITORIES A FINISHED STEP ACTUALLY LEFT WORK IN — asked before the next step is told where to look.
 *
 * A handover names a branch so the step after it can review real changes rather than a summary of them
 * (workflow-brief.ts's `branches`). That name is DERIVED — `agent/<conversation>` against every repo in the
 * run's composition — and a derived name is a claim, not a fact. Three ordinary things make the claim false:
 * a step that touched one repo of six, a turn that ended unclean so the worktree was never committed onto the
 * branch, and a step whose work was real but produced no diff against the run's pinned base.
 *
 * WHAT AN UNCHECKED NAME COSTS. The reviewer is told to run a diff. The diff is empty or the ref does not
 * resolve at all. Nothing looks wrong, so the reviewer says nothing is wrong — a green review of work it never
 * saw, which is strictly worse than no review, because the run now carries a verdict somebody will trust. That
 * is the exact failure the branch name was added to prevent, and naming a branch without resolving it
 * reintroduces it one layer down.
 *
 * So the name is resolved before it is handed on, and a repo that cannot be shown to hold committed work is
 * dropped from the handover. Dropping is the safe direction and not a close call: a dropped repo sends the
 * reviewer to the step's own report — less than it deserved, but true — while a kept one sends it somewhere
 * empty and calls the result a review.
 *
 * THIS DOES NOT FAIL THE STEP. A research step, a planning step, a step whose whole output is its document:
 * all of them legitimately finish with nothing committed anywhere, and refusing their handover would break the
 * ordinary case to catch the broken one. An empty result is a fact the brief states plainly instead.
 */

export interface HandoverBranch {
    readonly repo: string;
    readonly base: string;
    readonly branch: string;
}

// The main checkout a repo entry names. "root" is the workspace itself; anything else is its root-relative
// directory — the same mapping worktrees.ts uses, and the one the `repo` field has meant since it was written.
const mainDirOf = (root: string, repo: string): string => (repo === "root" ? root : join(root, repo));

/* Does this branch carry anything the pinned base does not?
 *
 * `rev-list --count <base>..<tip>` is the question the reviewer's own diff command asks, so asking it here is
 * asking exactly what the handover is about to promise — not a proxy for it.
 *
 * A THROW HERE KEEPS THE BRANCH, which is the opposite of what this module does everywhere else and is
 * deliberate. By the time this runs the branch has already been shown to exist and point at a commit, so the
 * only ways the count fails are histories git cannot walk between — unrelated roots, a base whose objects were
 * pruned — and those are cases where a diff is still the most informative thing the reviewer can be handed.
 * The dangerous state is a branch that is not there; this is a branch that is there and hard to measure.
 */
const carriesCommits = async (dir: string, base: string, tip: string, git: GitRunner): Promise<boolean> => {
    try {
        const { stdout } = await git(dir, ["rev-list", "--count", `${base}..${tip}`]);
        return Number(stdout.trim()) > 0;
    } catch {
        return true;
    }
};

/* The repos of `repos` that genuinely hold `branch`, in the order they were given.
 *
 * One `for-each-ref` and at most one `rev-list` per repo, all of them in parallel: this runs once per handover
 * edge, on the far side of a whole agent turn, so the cost is invisible next to what it is guarding.
 *
 * An unresolvable branch is dropped SILENTLY here rather than logged, because the absence is not always a
 * fault — most of the time it is a step that had no business touching that repo — and the brief says the
 * honest thing about the empty case anyway.
 */
export const resolvedBranches = async (
    root: string,
    repos: readonly RepoBase[],
    branch: string,
    git: GitRunner = defaultGit,
): Promise<readonly HandoverBranch[]> => {
    const checked = await Promise.all(
        repos.map(async ({ repo, base }): Promise<HandoverBranch | undefined> => {
            const dir = mainDirOf(root, repo);
            // Undefined means neither the live nor the parked spelling of the branch exists in this repo — the
            // reviewer's diff command would not even resolve its right-hand side.
            const tip = await branchSha(dir, branch, git).catch(() => undefined);
            if (tip === undefined) {
                return undefined;
            }
            return (await carriesCommits(dir, base, tip, git)) ? { repo, base, branch } : undefined;
        }),
    );
    return checked.filter((entry): entry is HandoverBranch => entry !== undefined);
};
