import type { LandConflict, LandConflictReason } from "@intentic/sandbox-contract";

/* WHO CAN ACTUALLY CLEAR A LAND CONFLICT — and what we say to them.
 *
 * A refused land reports per-repo blockers, each carrying its cause (see LandConflictSchema). The causes are
 * not variations on one problem: they differ in WHO is able to act, which is the only question the report has
 * to answer before it offers a button.
 *
 *   diverged — the main line's committed content moved under the agent. The agent rebases onto it and
 *              resolves in its OWN worktree, where a bad resolution costs nobody anything. This is the common
 *              case and the one the whole flow is built around.
 *   binary   — no automatic merge exists. Still the agent's job: it can re-create the file against the
 *              current one, or pick a side on purpose.
 *   workspace — the user has uncommitted edits on that path. The agent literally cannot reach them: its
 *              worktree is a different checkout, and a three-way apply goes through the main index, which git
 *              refuses while the working tree disagrees with it. Only the user can commit or stash.
 *
 * So the split below is the report's spine, and the prompt is what the agent's half turns into. */

// One blocked path with the repo it came from. The wire groups by repo and the UI groups by cause, so both
// want the rows flat — and a bare path is ambiguous the moment a composition holds more than one repo.
export interface Blocker {
    readonly repo: string;
    readonly path: string;
    readonly reason: LandConflictReason;
}

export const blockersOf = (conflicts: readonly LandConflict[] | undefined): readonly Blocker[] =>
    (conflicts ?? []).flatMap((conflict) => conflict.paths.map((blocked) => ({ repo: conflict.repo, path: blocked.path, reason: blocked.reason })));

// Repo-qualified, exactly like a review row's label (useAgentChanges): the root repo's paths read as
// themselves, a nested repo's carry the directory that disambiguates them.
export const blockerLabel = (blocker: Blocker): string => (blocker.repo === `root` ? blocker.path : `${blocker.repo}/${blocker.path}`);

// The agent's half of the report — everything a rebase in its own worktree could reconcile.
export const agentBlockers = (blockers: readonly Blocker[]): readonly Blocker[] => blockers.filter((blocker) => blocker.reason !== `workspace`);

// The user's half — paths held by their own uncommitted edits, which nothing but a commit or a stash clears.
export const userBlockers = (blockers: readonly Blocker[]): readonly Blocker[] => blockers.filter((blocker) => blocker.reason === `workspace`);

// Why each path is blocked, addressed TO THE AGENT. Deliberately not the panel's REASON_COPY, which speaks to
// the user about their own tree ("you have uncommitted edits to these") — read by the agent that would be an
// instruction to go and touch them.
const REASON_BRIEF: Record<LandConflictReason, string> = {
    diverged: `the main line's committed content moved under you since you branched`,
    binary: `git has no automatic merge for a binary file, so re-create it against the current one or pick a side deliberately`,
    workspace: `the user has uncommitted edits of their own here`,
};

// Grouped under a repo heading rather than repo-qualified per line: the agent works one checkout at a time, and
// the heading is the `cd` it implies. `reasons` is off for a listing whose whole set shares one cause — the
// section already says it, and repeating it on every line reads as four different problems.
const listing = (blockers: readonly Blocker[], reasons: boolean): string => {
    const byRepo = new Map<string, Blocker[]>();
    for (const blocker of blockers) {
        const bucket = byRepo.get(blocker.repo);
        if (bucket === undefined) {
            byRepo.set(blocker.repo, [blocker]);
        } else {
            bucket.push(blocker);
        }
    }
    return [...byRepo]
        .map(([repo, group]) =>
            [repo, ...group.map((blocker) => `  - ${blocker.path}${reasons ? ` — ${REASON_BRIEF[blocker.reason]}` : ``}`)].join(`\n`),
        )
        .join(`\n`);
};

/* WHAT WE ASK THE AGENT TO DO. One composed message, sent as an ordinary turn — so it sits in the transcript
 * as a user message the human can read, and Stop, steering and the queue all work on it unchanged.
 *
 * Three things in here are load-bearing, and each is a way the turn fails without them:
 *   · COMMIT FIRST. The agent's worktree is dirty between lands — land's own gitCommitAll runs at land time,
 *     not before — and `git rebase` refuses to start on a dirty tree. Without this step the agent's first
 *     command errors and it improvises from there.
 *   · `git worktree list` rather than a path we bake in. The agent's checkout is a linked worktree of the
 *     user's repo, so the main checkout and the branch it holds are things git will simply tell it; a
 *     hardcoded /work would be a second copy of a fact the daemon owns, wrong the day the layout moves.
 *   · KEEP BOTH SIDES. Left to itself a model will happily make the markers go away by taking one side, which
 *     is how "resolved" ends up meaning "silently dropped the change that moved underneath me".
 *
 * The user's own blocked paths are named but fenced off: the agent cannot fix them from its worktree, and a
 * report that omitted them would have it wondering why the land it triggers still refuses. */
export const resolvePrompt = (conflicts: readonly LandConflict[] | undefined): string => {
    const blockers = blockersOf(conflicts);
    const mine = agentBlockers(blockers);
    const theirs = userBlockers(blockers);
    return [
        `Landing your work hit a merge conflict, so none of it reached the user's workspace — it is all still on your branch. Bring the branch up to date with the user's main line and resolve the conflict yourself.`,
        `For each repo below — \`root\` is your working directory, any other name is that subdirectory of it:`,
        [
            `1. Commit whatever is still loose in the worktree (\`git add -A && git commit\`). A rebase refuses to start on a dirty tree.`,
            `2. Find the user's checkout with \`git worktree list\`. The FIRST entry is theirs, and the branch in brackets is the one your work has to land on.`,
            `3. \`git rebase <that branch>\`. If the rebase gets away from you, \`git rebase --abort\` and \`git merge <that branch>\` instead — either way your delta has to end up applying to the current main line.`,
            `4. Resolve every conflict yourself: read the files, and keep the intent of BOTH sides — your change and whatever moved underneath it. Do not take one side wholesale to make the markers go away.`,
            `5. Check the result still builds and its tests still pass, as far as this project makes that cheap.`,
        ].join(`\n`),
        `What blocked the land:\n${listing(mine, true)}`,
        ...(theirs.length === 0
            ? []
            : [
                  `Leave these alone — the user has uncommitted edits of their own on them, and only they can clear that. Rebasing will not unblock them, and they are not yours to touch:\n${listing(theirs, false)}`,
              ]),
        `Stay inside your own worktree: never edit, stage or commit in the user's checkout. When your turn ends the app lands the result automatically, so stop once the rebase is clean and the code holds together.`,
    ].join(`\n\n`);
};
