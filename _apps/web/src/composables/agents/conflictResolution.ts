import type { IconName } from "@intentic-app/ui";
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

/* WHAT EACH CAUSE MEANS TO THE USER — the one copy of it, because a conflict is now named on two surfaces at
 * once and they must not drift: the report explains the causes as GROUPS above the review, and the file list
 * marks the individual ROWS those groups are talking about. A report that says "3 files couldn't be applied"
 * over a list of thirty identical-looking rows makes the reader hunt for the three; the shared glyph is what
 * turns the group heading into a pointer at them.
 *
 *   `icon`  rides both the group heading and the row mark — the same glyph in both places IS the link.
 *   `mark`  one word, because it sits on a row next to a truncating path and a diffstat.
 *   `title` the group heading, plural, reading on from the count line above it.
 *   `fix`   who can clear it, which is the ladder of buttons underneath.
 *   `row`   the same thing said about ONE file, standing on its own — a row's tooltip has no count line and
 *           no button ladder under it to lean on.
 *
 * Declaration order is the report's group order: the agent's own two causes first, the user's in the middle
 * where the ladder puts it. Deliberately not REASON_BRIEF below, which says all of this to the AGENT. */
export const REASON_COPY: Record<LandConflictReason, { icon: IconName; mark: string; title: string; fix: string; row: string }> = {
    diverged: {
        icon: `sync`,
        mark: `moved`,
        title: `your workspace moved on since the agent branched`,
        fix: `The agent can rebase onto it and merge these itself.`,
        row: `Your workspace moved on since the agent branched — the agent can rebase onto it and merge this itself.`,
    },
    workspace: {
        icon: `user`,
        mark: `yours`,
        title: `you have uncommitted edits to these`,
        fix: `Only you can clear this — git cannot merge through unstaged work, and the agent's checkout cannot see it.`,
        row: `You have uncommitted edits to this file — only you can clear it, by committing or stashing them.`,
    },
    binary: {
        icon: `image`,
        mark: `binary`,
        title: `binary files, which have no automatic merge`,
        fix: `The agent can re-create them against the current file, or pick a side.`,
        row: `A binary file has no automatic merge — the agent can re-create it against the current file, or pick a side.`,
    },
};

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
