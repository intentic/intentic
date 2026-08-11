import type { AgentSpan, GitChange, WorkspaceModule } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { changesAgainstBase, changesBetweenRefs, headSha } from "../git/changes.js";
import { readModules } from "../workspace/modules.js";
import type { IsolatedAgent, PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

/* WHAT DID THIS AGENT CHANGE — asked once, answered here, for every surface that reports a number.
 *
 * There are two of those surfaces and they used to compute the answer separately: the review lists the delta
 * per file (agents.routes.ts diff), and the fleet card counts it ("336 · +15604 −4427"), from a diffstat land
 * took while it had the shas in hand. Separate computations meant separate ANCHORS — the review measured from
 * the merge-base and the card from the frozen creation-time base — so a worktree that had synced onto newer
 * main commits showed six files in the review and three hundred and thirty-six on its own card, the difference
 * being every commit main gained in between. Both numbers claimed to be "what this agent did"; the user cannot
 * tell which one lied, so both stop being worth reading.
 *
 * So the reading lives in one place and both surfaces call it. The card still holds a SNAPSHOT of it (a roster
 * of live agents cannot re-diff every card on every frame) — refreshed at each land, which is where a turn's
 * work becomes final — but a snapshot of the same number the review computes live, rather than of a different
 * one.
 */

// `git merge-base --is-ancestor` answers by exit code, which the runner surfaces as a throw.
const isAncestor = async (dir: string, ancestor: string, descendant: string, git: GitRunner): Promise<boolean> => {
    try {
        await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
};

/* WHERE an agent's delta is measured from — which decides what "this agent's work" even means. Shared by the
 * land (with its landedTip rung, for the incremental remainder) and by everything that reports the cumulative
 * output (without it), because two answers to "what did this agent do" that disagree are worse than either.
 *
 * An incremental land continues from `landedTip`, so a second land carries only what the agent has done
 * since the first. Everything else asks git: the agent's own work is what its tip has that the main line does
 * not, i.e. the delta from their MERGE-BASE.
 *
 * The base recorded at worktree creation is only the last resort, because it is a sha frozen in time and the
 * branch does not have to keep agreeing with it. Rebase an agent onto the current main line — the natural
 * response to being told the main tree moved on — and the branch now CONTAINS main's commits. Diffing from
 * the frozen base then yields "what this agent did PLUS everything main did since": a patch of dozens of
 * files that can never apply, because the main tree already has its own half of it. What the user sees for
 * that is a conflict report naming files the agent never touched, and no way forward. (The review and the
 * card each had the same bug for the same reason — see the header.) The merge-base is immune — it moves with
 * the sync, and the delta stays exactly the agent's own work. */
export const anchorOf = async (
    // Where the ref reads run — the worktree while the checkout is attached, the main repo once it is retired
    // (the object store is shared, so every sha the branch names answers in both).
    dir: string,
    main: string,
    tip: string,
    landedTip: string | undefined,
    base: string,
    git: GitRunner = defaultGit,
): Promise<string> => {
    const head = await headSha(main, git);
    let merged = "";
    if (head !== undefined) {
        try {
            merged = (await git(dir, ["merge-base", head, tip])).stdout.trim();
        } catch {
            // Unrelated histories — the merge-base rung simply doesn't exist.
        }
    }
    /* landedTip only while the branch still descends from it (a rewrite that dropped the landed work has to
     * re-land it) AND the merge-base still sits behind it. The second condition is what a `merge main` into
     * the branch changes: the branch then contains main-line state landedTip's span predates, and a patch
     * measured from landedTip carries pre-images main has already moved past — every such hunk "conflicts"
     * with content the merge already reconciled, which read to the user as a land that could never succeed.
     * Once the merge-base is no longer an ancestor of landedTip, IT is the honest anchor: everything at or
     * before it is in main by definition, and anything landed-but-newer that the span re-offers is excluded
     * per file by classifyDelta's reverse probe, exactly as for work that reached main by another road. */
    if (landedTip !== undefined && (await isAncestor(dir, landedTip, tip, git))) {
        if (merged === "" || (await isAncestor(dir, merged, landedTip, git))) {
            return landedTip;
        }
        return merged;
    }
    return merged === "" ? base : merged;
};

/* DOES A SPAN CARRY ANYTHING — the question two shas cannot answer, and the one every "is there work
 * outstanding?" reading actually means to ask.
 *
 * A tip that sits ahead of its anchor LOOKS like outstanding work, and normally is. But commits and content
 * are different things, and a rebase is what pulls them apart: replaying a branch onto a main line that has
 * absorbed its work drops the commits that come out empty ONE BY ONE, so a pair that cancels out — a
 * generated lock file written one way and then back the other — survives as two commits spanning nothing.
 * The branch is then two commits "ahead" of a main tree holding every byte of it.
 *
 * Read off the shas alone, that branch offered "Land now" for good: the press had nothing to apply, and only
 * the land's own bookkeeping (land.ts, the empty-patch case) could retire it — which is exactly the pass a
 * turn ending on a dismissed question never reaches. The land has always asked the real question, by building
 * the patch and finding it empty; this asks it for the price of one ref read, which is what makes it
 * affordable on a whole-roster probe.
 *
 * TREES, not a diff: two commits differ in content precisely when their trees differ, git's trees being
 * canonical — so this is the same answer `git diff` would give, without walking anything to get it. */
export const carriesContent = async (dir: string, from: string, tip: string, git: GitRunner = defaultGit): Promise<boolean> => {
    if (from === tip) {
        return false;
    }
    try {
        const [fromTree, tipTree] = (await git(dir, ["rev-parse", `${from}^{tree}`, `${tip}^{tree}`])).stdout.trim().split("\n");
        return fromTree === undefined || tipTree === undefined || fromTree !== tipTree;
    } catch {
        // A sha that will not resolve is not an emptiness claim — answer the way the bare comparison did, and
        // let the land itself report whatever is really wrong with the ref.
        return true;
    }
};

/* ONE repo of one agent's composition, in the GitChange shape the Changes panel already renders.
 *
 * The checkout when it is on disk, the two refs out of the main repo when it is not — decided per repo, NOT by
 * archivedAt: a restored agent keeps the marker clear while its checkout stays retired until the next turn
 * re-attaches it, and reading the worktree path then reported a full branch as "no changes". The refs tell the
 * same story either way (retiring committed the worktree's remainder onto the branch; the object store is
 * shared), minus one thing only an attached checkout has — uncommitted work, which is in the delta while the
 * worktree holds it and in `tip` once a land's provenance commit has swept it up.
 */
export const agentRepoChanges = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    span: AgentSpan,
    git: GitRunner = defaultGit,
): Promise<GitChange[]> => {
    const main = worktrees.mainDir(composed.repo);
    const attached = await worktrees.attached(entry.id, composed.repo);
    const dir = attached ? worktrees.worktreeDir(entry.id, composed.repo) : main;
    const from = await anchorOf(dir, main, entry.branch, span === "outstanding" ? composed.landedTip : undefined, composed.base, git);
    return attached ? changesAgainstBase(dir, from, git) : changesBetweenRefs(main, from, entry.branch, git);
};

/* THE PACKAGE LAYOUT those changes are grouped under, read from THE SAME TREE they were read from — the one
 * thing that keeps the review's headings and its rows talking about the same world.
 *
 * The workspace-wide read (/workspace/modules) cannot do this job: it walks /work, and an agent works in a
 * worktree of its own. A package the agent has just created has its manifest only there, so /work could not
 * name it — and a brand-new package is the case where naming matters most, because every one of its files is
 * a change. The review listed them all as loose files of the repo, under no package at all.
 *
 * A RETIRED checkout falls back to the main repo, exactly as the file diff beside it does: the worktree is
 * gone, the branch's tree is not on disk, and by the time an agent is retired its work has normally landed —
 * so the main tree is both the only cheap answer and, nearly always, the right one.
 */
export const agentRepoModules = async (worktrees: AgentWorktrees, entry: IsolatedAgent, repo: string): Promise<WorkspaceModule[]> =>
    readModules((await worktrees.attached(entry.id, repo)) ? worktrees.worktreeDir(entry.id, repo) : worktrees.mainDir(repo));
