import type { LandConflict, LandConflictReason } from "../schemas/agents.js";
import { withoutResumeNote } from "./resume.js";

// The turn sent to a conversation whose land refused, asking it to rebase and resolve, recognised by its opening. The
// app sends it on a Resolve press and the daemon to a home conversation (home/home-conflict.ts), so it is composed here,
// where the fold must recognise it as well: that turn's own rebase notice would otherwise tell the reader the thing the
// turn was sent to fix.

// Anchored on by the chat and the fold, so it must stay unique and stable across releases.
export const LAND_CONFLICT_OPENING =
    "Landing your work hit a merge conflict, none of it reached the user's workspace; it is all still on your branch. Rebase onto the main line and resolve the conflicts yourself. In each repo below (`root` is your working directory, any other name that subdirectory of it):";

// Whether a stored prompt is one. A turn the daemon re-ran carries the same prompt after its resume note.
export const isLandConflict = (prompt: string): boolean => withoutResumeNote(prompt.trim()).startsWith(LAND_CONFLICT_OPENING);

// One blocked path with its repo; flattened since the wire groups by repo, and a reader groups by cause.
export interface Blocker {
    readonly repo: string;
    readonly path: string;
    readonly reason: LandConflictReason;
}

export const blockersOf = (conflicts: readonly LandConflict[] | undefined): readonly Blocker[] =>
    (conflicts ?? []).flatMap((conflict) => conflict.paths.map((blocked) => ({ repo: conflict.repo, path: blocked.path, reason: blocked.reason })));

// The agent's half: everything a rebase in its own worktree can reconcile.
export const agentBlockers = (blockers: readonly Blocker[]): readonly Blocker[] => blockers.filter((blocker) => blocker.reason !== "workspace");

// The user's half: paths held by uncommitted edits, clearable only by a commit or stash.
export const userBlockers = (blockers: readonly Blocker[]): readonly Blocker[] => blockers.filter((blocker) => blocker.reason === "workspace");

// Why each path is blocked, addressed to the agent; distinct from the chat's own copy, which speaks to the user.
const REASON_BRIEF = {
    diverged: "the main line's committed content moved under you since you branched",
    binary: "git has no automatic merge for a binary file, so re-create it against the current one or pick a side deliberately",
    workspace: "the user has uncommitted edits of their own here",
} satisfies Record<LandConflictReason, string>;

// Grouped under a repo heading (the `cd` the agent implies) rather than repo-qualified per line. `reasons` is off
// when a listing's whole set already shares one cause, stated once by the section itself.
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
    return [...byRepo].map(([repo, group]) => [repo, ...group.map((blocker) => `  - ${blocker.path}${reasons ? `, ${REASON_BRIEF[blocker.reason]}` : ""}`)].join("\n")).join("\n");
};

// Named main line, when every conflicted repo agrees (the normal case, since a workspace's repos branch together).
// Falls back to self-discovery when repos disagree or a name is missing.
const sharedMainBranch = (conflicts: readonly LandConflict[] | undefined): string | undefined => {
    const names = new Set((conflicts ?? []).map((conflict) => conflict.mainBranch));
    const only = names.size === 1 ? [...names][0] : undefined;
    return only === undefined || only === "" ? undefined : only;
};

/**
 * The turn that asks a conversation to rebase and resolve a land that refused: sent by the app's Resolve press, and by
 * the daemon to a home conversation, whose person is never asked to. Required for the turn to succeed: commit first
 * (rebase refuses a dirty tree), name the main branch, keep both sides of each conflict.
 */
export const landConflictPrompt = (conflicts: readonly LandConflict[] | undefined): string => {
    const blockers = blockersOf(conflicts);
    const theirs = userBlockers(blockers);
    const main = sharedMainBranch(conflicts);
    return [
        LAND_CONFLICT_OPENING,
        [
            "1. `git add -A && git commit`: a rebase refuses to start on a dirty tree.",
            main === undefined
                ? "2. `git rebase <branch>`, where `<branch>` is the one in brackets on the FIRST line of `git worktree list`, the user's main line. If the rebase gets away from you: `git rebase --abort`, then `git merge <branch>` instead."
                : `2. \`git rebase ${main}\`, that is the user's main line. If the rebase gets away from you: \`git rebase --abort\`, then \`git merge ${main}\` instead.`,
            "3. Resolve each conflict keeping the intent of BOTH sides: your change and whatever moved underneath it. Do not take one side wholesale.",
            "4. Check what you resolved: re-run the tests of the files the conflicts were in, not the project's whole suite; CI runs the rest on what is pushed.",
        ].join("\n"),
        `What blocked the land:\n${listing(agentBlockers(blockers), true)}`,
        ...(theirs.length === 0
            ? []
            : [`Leave these alone: the user has uncommitted edits on them, which only they can clear; rebasing will not unblock them:\n${listing(theirs, false)}`]),
        "Stay inside your own worktree: never edit, stage or commit in the user's checkout. The app re-lands automatically when your turn ends, stop once the rebase is clean.",
    ].join("\n\n");
};
