import type { AgentSpan, GitChange, WorkspaceModule } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { changesAgainstBase, changesBetweenRefs, headSha, materializedPaths } from "../git/changes.js";
import { refAgainstRef, withCodeCounts, worktreeAgainstRef } from "../git/code-counts.js";
import { readModules } from "../workspace/modules.js";
import type { IsolatedAgent, PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

/* WHAT DID THIS AGENT CHANGE, asked once, answered here, for every surface that reports a number.
 *
 * There are two of those surfaces and they used to compute the answer separately: the review lists the delta
 * per file (agents.routes.ts diff), and the fleet card counts it ("336 · +15604 −4427"), from a diffstat land
 * took while it had the shas in hand. Separate computations meant separate ANCHORS, the review measured from
 * the merge-base and the card from the frozen creation-time base, so a worktree that had synced onto newer
 * main commits showed six files in the review and three hundred and thirty-six on its own card, the difference
 * being every commit main gained in between. Both numbers claimed to be "what this agent did"; the user cannot
 * tell which one lied, so both stop being worth reading.
 *
 * So the reading lives in one place and both surfaces call it. The card still holds a SNAPSHOT of it (a roster
 * of live agents cannot re-diff every card on every frame), refreshed at each land, which is where a turn's
 * work becomes final, but a snapshot of the same number the review computes live, rather than of a different
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

/* WHERE an agent's delta is measured from, which decides what "this agent's work" even means. Shared by the
 * land (with its landedTip rung, for the incremental remainder) and by everything that reports the cumulative
 * output (without it), because two answers to "what did this agent do" that disagree are worse than either.
 *
 * An incremental land continues from `landedTip`, so a second land carries only what the agent has done
 * since the first. Everything else asks git: the agent's own work is what its tip has that the main line does
 * not, i.e. the delta from their MERGE-BASE.
 *
 * The base recorded at worktree creation is only the last resort, because it is a sha frozen in time and the
 * branch does not have to keep agreeing with it. Rebase an agent onto the current main line, the natural
 * response to being told the main tree moved on, and the branch now CONTAINS main's commits. Diffing from
 * the frozen base then yields "what this agent did PLUS everything main did since": a patch of dozens of
 * files that can never apply, because the main tree already has its own half of it. What the user sees for
 * that is a conflict report naming files the agent never touched, and no way forward. (The review and the
 * card each had the same bug for the same reason, see the header.) The merge-base is immune, it moves with
 * the sync, and the delta stays exactly the agent's own work. */
export const anchorOf = async (
    // Where the ref reads run, the worktree while the checkout is attached, the main repo once it is retired
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
            // Unrelated histories, the merge-base rung simply doesn't exist.
        }
    }
    /* landedTip only while the branch still descends from it (a rewrite that dropped the landed work has to
     * re-land it) AND the merge-base still sits behind it. The second condition is what a `merge main` into
     * the branch changes: the branch then contains main-line state landedTip's span predates, and a patch
     * measured from landedTip carries pre-images main has already moved past, every such hunk "conflicts"
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

/* DOES A SPAN CARRY ANYTHING, the question two shas cannot answer, and the one every "is there work
 * outstanding?" reading actually means to ask.
 *
 * A tip that sits ahead of its anchor LOOKS like outstanding work, and normally is. But commits and content
 * are different things, and a rebase is what pulls them apart: replaying a branch onto a main line that has
 * absorbed its work drops the commits that come out empty ONE BY ONE, so a pair that cancels out, a
 * generated lock file written one way and then back the other, survives as two commits spanning nothing.
 * The branch is then two commits "ahead" of a main tree holding every byte of it.
 *
 * Read off the shas alone, that branch offered "Land now" for good: the press had nothing to apply, and only
 * the land's own bookkeeping (land.ts, the empty-patch case) could retire it, which is exactly the pass a
 * turn ending on a dismissed question never reaches. The land has always asked the real question, by building
 * the patch and finding it empty; this asks it for the price of one ref read, which is what makes it
 * affordable on a whole-roster probe.
 *
 * TREES, not a diff: two commits differ in content precisely when their trees differ, git's trees being
 * canonical, so this is the same answer `git diff` would give, without walking anything to get it. */
export const carriesContent = async (dir: string, from: string, tip: string, git: GitRunner = defaultGit): Promise<boolean> => {
    if (from === tip) {
        return false;
    }
    try {
        const [fromTree, tipTree] = (await git(dir, ["rev-parse", `${from}^{tree}`, `${tip}^{tree}`])).stdout.trim().split("\n");
        return fromTree === undefined || tipTree === undefined || fromTree !== tipTree;
    } catch {
        // A sha that will not resolve is not an emptiness claim, answer the way the bare comparison did, and
        // let the land itself report whatever is really wrong with the ref.
        return true;
    }
};

/* ONE repo of one agent's composition, in the GitChange shape the Changes panel already renders.
 *
 * The checkout when it is on disk, the two refs out of the main repo when it is not, decided per repo, NOT by
 * archivedAt: a restored agent keeps the marker clear while its checkout stays retired until the next turn
 * re-attaches it, and reading the worktree path then reported a full branch as "no changes". The refs tell the
 * same story either way (retiring committed the worktree's remainder onto the branch; the object store is
 * shared), minus one thing only an attached checkout has, uncommitted work, which is in the delta while the
 * worktree holds it and in `tip` once a land's provenance commit has swept it up.
 */
export const agentRepoChanges = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    span: AgentSpan,
    git: GitRunner = defaultGit,
): Promise<GitChange[]> => {
    const { dir, attached, from } = await agentRepoScope(worktrees, entry, composed, span, git);
    return attached ? changesAgainstBase(dir, from, git) : changesBetweenRefs(worktrees.mainDir(composed.repo), from, entry.branch, git);
};

/* WHERE those rows were read from, which the counting pass needs and the reading above already worked out: the
 * checkout or the main repo, and the ref the delta is measured from. Separated rather than recomputed, because
 * the two answers disagreeing is the whole class of bug agent-changes exists to prevent. */
const agentRepoScope = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    span: AgentSpan,
    git: GitRunner,
): Promise<{ dir: string; attached: boolean; from: string }> => {
    const main = worktrees.mainDir(composed.repo);
    const attached = await worktrees.attached(entry.id, composed.repo);
    const dir = attached ? worktrees.worktreeDir(entry.id, composed.repo) : main;
    return {
        dir,
        attached,
        from: await anchorOf(dir, main, entry.branch, span === "outstanding" ? composed.landedTip : undefined, composed.base, git),
    };
};

/* THE REVIEW'S OWN READING: the same cumulative rows, each carrying the code-only +/− the panel draws beside it
 * (git/code-counts.ts), so the number a reviewer sees when the list arrives is the number it keeps.
 *
 * Only the review takes this path. The fleet card's counter sums git's own totals and never draws the code's, so
 * making it pay for a tokenizer walk per file, on a snapshot taken at every land, would be spending the daemon's
 * loop on a reading nobody looks at. */
export const agentRepoReview = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    git: GitRunner = defaultGit,
): Promise<GitChange[]> => {
    const { dir, attached, from } = await agentRepoScope(worktrees, entry, composed, "cumulative", git);
    const main = worktrees.mainDir(composed.repo);
    const changes = attached ? await changesAgainstBase(dir, from, git) : await changesBetweenRefs(main, from, entry.branch, git);
    return attached ? withCodeCounts(dir, changes, worktreeAgainstRef(dir, from)) : withCodeCounts(main, changes, refAgainstRef(from, entry.branch));
};

/* WHAT THE MAIN WORKSPACE ALREADY HOLDS, asked of the TREE, per path, which is the one question every
 * sha-based reading of an agent's work gets wrong the moment the user touches the result of a land.
 *
 * Everything else in this file measures a span between two commits, and a span is exactly what "is this in
 * main?" cannot be answered by. A land copies content into the main WORKING TREE as an uncommitted patch;
 * main's HEAD never moves, and the branch never moves either. So when the user then reviews that patch and
 * commits half of it and discards the other half, no sha anywhere records what happened, and every reading
 * built on shas answers exactly as it did before:
 *
 *   · the merge-base the review is anchored at is a FORK POINT, and main gaining commits does not move a fork
 *     point. `base..tip` therefore keeps listing every file the agent ever touched, including the ones whose
 *     content main now holds byte for byte, until something rebases the branch (agents/sync.ts, at the next
 *     turn) and the list silently corrects itself;
 *   · the per-row `landed` flag was the delta from `landedTip`, which is the tip itself after a land, so every
 *     row read "landed" whatever the user had since done to it: discard the file in the Changes panel and the
 *     review still claimed your workspace had it, with nothing left for "Land now" to apply.
 *
 * Both are the same mistake, and this is the answer to both: ask the tree. Three states, and the review needs
 * all three told apart, because the user's next move is different for each.
 *
 *   ABSORBED    main's HEAD holds this content: the user accepted it, it is their commit now, and it is no
 *               longer a difference against main. The row goes.
 *   IN WORKSPACE the main working tree holds it, uncommitted: the steady state right after a land, the work
 *               waiting in the Changes panel. The row stays, flagged landed.
 *   NEITHER     discarded, reverted, or never landed. The row stays, unflagged, and this is what "Land now"
 *               applies.
 *
 * Cheap by construction: two `--name-only` reads per repo, plus a content comparison over one small set. It
 * REPLACES the second full delta pass the diff route used to take to compute the same flag, so the review
 * spends about what it did.
 */
export interface MainPresence {
    // Paths whose content main's own history already carries. Not a difference against main any more.
    readonly absorbed: ReadonlySet<string>;
    // Paths the main working tree holds right now, committed or not. The review's `landed`.
    readonly inWorkspace: ReadonlySet<string>;
}

const NO_PATHS: ReadonlySet<string> = new Set();

// One `-z` listing as a set, with every path copied out of git's stdout (materializedPaths): these outlive the
// call frame inside the sets above, and a sliced path pins the whole listing (see git/changes.ts).
const pathSet = async (dir: string, args: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> =>
    new Set(materializedPaths((await git(dir, args)).stdout));

/* An untracked file in the main tree is invisible to `git diff`, which walks the commit and the index and
 * nothing else. That is precisely the shape a landed-but-uncommitted NEW file has, so without this every
 * freshly created file would report as still outstanding on the one path the review is most often read on.
 *
 * Compared by CONTENT rather than by presence, unlike the card's own probe (landed-presence.ts, where the
 * question is only whether a landing survived): turn 1 creates a file and lands it, turn 2 rewrites it and has
 * not landed yet, and "a file of that name is sitting in /work" is true while the answer the review needs is
 * no. `hash-object` reads the working copy, which is where a land puts its content; the index would answer for
 * a staging the user has not done. Chunked, because this is argv and a review can be hundreds of files.
 *
 * It hashes the file as it sits, so a repo with a clean filter or CRLF conversion configured would hash to
 * something the tree's blob does not match and the path stays listed as outstanding. That is the safe
 * direction, and the only one worth having: a "Land now" that re-applies content already there is a no-op the
 * land itself recognises, while the opposite error hides work the user has not got. */
const HASH_CHUNK = 100;
const untrackedMatches = async (main: string, tip: string, paths: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> => {
    const matched = new Set<string>();
    for (let cursor = 0; cursor < paths.length; cursor += HASH_CHUNK) {
        const batch = paths.slice(cursor, cursor + HASH_CHUNK);
        try {
            // `ls-tree` answers only for the paths that ARE in the tree, so a path the branch does not carry
            // simply comes back absent instead of failing the whole batch.
            const [onDisk, inTree] = await Promise.all([
                git(main, ["hash-object", "--", ...batch]),
                git(main, ["ls-tree", "-z", "--full-name", tip, "--", ...batch]),
            ]);
            const hashes = onDisk.stdout.trim().split("\n");
            const tree = new Map(
                materializedPaths(inTree.stdout).map((record) => {
                    // `<mode> SP <type> SP <sha> TAB <path>`
                    const tab = record.indexOf("\t");
                    return [record.slice(tab + 1), record.slice(0, tab).split(" ")[2] ?? ""] as const;
                }),
            );
            for (const [index, path] of batch.entries()) {
                const hash = hashes[index];
                if (hash !== undefined && hash !== "" && tree.get(path) === hash) {
                    matched.add(path);
                }
            }
        } catch {
            // A file that vanished between the walk and the hash, or a ref that will not resolve: this batch
            // says nothing, which leaves its paths reported as outstanding. The honest failure direction, a
            // "Land now" that applies work already there is a no-op, the reverse loses it.
        }
    }
    return matched;
};

// Nothing known: every row is a difference and none of them is in the tree. What a probe that could not run
// answers with, and the one direction it is safe to be wrong in, see presentInMain.
const NOTHING: MainPresence = { absorbed: NO_PATHS, inWorkspace: NO_PATHS };

/* A REFUSAL TO ANSWER MUST NOT LOOK LIKE AN ANSWER. A pruned branch, a rewritten history, a main checkout
 * that has gone: any of them makes these reads throw, and this probe decides both which rows exist and which
 * of them the user already has. Failing outward would take the repo out of the review entirely (the route
 * skips a repo it cannot read); failing to "everything is landed" would hide work nobody has.
 *
 * So it fails to the honest end of the range: every row shown, none of them claimed to be in the tree. The
 * cost of being wrong that way is a "Land now" that re-applies content already there, which the land itself
 * recognises and turns into a no-op; the cost of the other way is work the user cannot see is missing. */
export const presentInMain = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    paths: readonly string[],
    git: GitRunner = defaultGit,
): Promise<MainPresence> => {
    if (paths.length === 0) {
        return NOTHING;
    }
    try {
        return await probeMain(worktrees, entry, composed, paths, git);
    } catch {
        return NOTHING;
    }
};

const probeMain = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    composed: PersistedAgent["repos"][number],
    paths: readonly string[],
    git: GitRunner,
): Promise<MainPresence> => {
    const main = worktrees.mainDir(composed.repo);
    const own = new Set(paths);
    /* WHAT THE BRANCH TIP DOES NOT SPEAK FOR: the agent's own uncommitted work, which exists only while a turn
     * is mid-write (every land and every retire sweeps the remainder onto the branch first, so a resting
     * worktree is clean). Its content is on disk in the agent's checkout and in no commit, so both comparisons
     * below, which are against `tip`, would be answering about the wrong bytes. Outstanding by construction
     * instead: work the agent has not committed cannot be work the user has already accepted. */
    const dir = worktrees.worktreeDir(entry.id, composed.repo);
    const midWrite = !(await worktrees.attached(entry.id, composed.repo))
        ? NO_PATHS
        : new Set([
              ...(await pathSet(dir, ["diff", "--name-only", "--no-renames", "-z", "HEAD"], git)),
              ...(await pathSet(dir, ["ls-files", "--others", "--exclude-standard", "-z"], git)),
          ]);

    const head = await headSha(main, git);
    // `--no-renames` on both: the rows this is joined onto are read WITH rename detection, so their path is the
    // destination, and a destination is what both listings name. Detection here would only re-pair paths that
    // are being looked up one by one anyway.
    const [vsHead, vsWorktree] = await Promise.all([
        // Against main's HISTORY. An unborn main (a repo with no commit yet) holds nothing, so nothing of the
        // agent's can have been absorbed by it.
        head === undefined
            ? Promise.resolve(new Set(paths) as ReadonlySet<string>)
            : pathSet(main, ["diff", "--name-only", "--no-renames", "-z", head, entry.branch], git),
        // Against main's INDEX AND WORKING TREE, which is where a land leaves its content.
        pathSet(main, ["diff", "--name-only", "--no-renames", "-z", entry.branch], git),
    ]);

    const untracked = await pathSet(main, ["ls-files", "--others", "--exclude-standard", "-z"], git);
    const blind = [...vsWorktree].filter((path) => own.has(path) && untracked.has(path));
    const materialized = blind.length === 0 ? NO_PATHS : await untrackedMatches(main, entry.branch, blind, git);
    return verdicts(own, { midWrite, vsHead, vsWorktree, materialized });
};

// The three states, decided per path off the four listings above. Absorbed implies in-workspace: main's
// history holding the content is this file's strongest "your workspace has it", the same rule the card's own
// probe reads a commit by (landed-presence.ts), and it survives the user editing the file afterwards, which is
// their work on top of the agent's rather than the agent's work going missing.
const verdicts = (
    own: ReadonlySet<string>,
    listings: { midWrite: ReadonlySet<string>; vsHead: ReadonlySet<string>; vsWorktree: ReadonlySet<string>; materialized: ReadonlySet<string> },
): MainPresence => {
    const absorbed = new Set<string>();
    const inWorkspace = new Set<string>();
    for (const path of own) {
        if (listings.midWrite.has(path)) {
            continue;
        }
        if (!listings.vsHead.has(path)) {
            absorbed.add(path);
        }
        if (!listings.vsHead.has(path) || !listings.vsWorktree.has(path) || listings.materialized.has(path)) {
            inWorkspace.add(path);
        }
    }
    return { absorbed, inWorkspace };
};

/* THE PACKAGE LAYOUT those changes are grouped under, read from THE SAME TREE they were read from, the one
 * thing that keeps the review's headings and its rows talking about the same world.
 *
 * The workspace-wide read (/workspace/modules) cannot do this job: it walks /work, and an agent works in a
 * worktree of its own. A package the agent has just created has its manifest only there, so /work could not
 * name it, and a brand-new package is the case where naming matters most, because every one of its files is
 * a change. The review listed them all as loose files of the repo, under no package at all.
 *
 * A RETIRED checkout falls back to the main repo, exactly as the file diff beside it does: the worktree is
 * gone, the branch's tree is not on disk, and by the time an agent is retired its work has normally landed,
 * so the main tree is both the only cheap answer and, nearly always, the right one.
 */
export const agentRepoModules = async (worktrees: AgentWorktrees, entry: IsolatedAgent, repo: string): Promise<WorkspaceModule[]> =>
    readModules((await worktrees.attached(entry.id, repo)) ? worktrees.worktreeDir(entry.id, repo) : worktrees.mainDir(repo));
