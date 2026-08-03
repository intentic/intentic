import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { operationInProgress } from "./operation.js";

/* UNDOING THE LAST THING THAT MOVED A BRANCH.
 *
 * Git has no `undo`. What it has is the REFLOG — a per-ref record of every position that ref has held — so
 * undoing an action means moving the branch back to the position it held before it, which is what this reads.
 *
 * WHY THIS IS NOT THE CHECKPOINTS TIMELINE, which already exists and already covers destructive git verbs: a
 * checkpoint restores the WORKING TREE, and this moves the BRANCH. After a bad rebase or a reset the files may
 * be exactly right and the ref exactly wrong, and restoring a whole worktree snapshot to fix a ref is both a
 * much bigger hammer and the wrong tool — it would take every unrelated edit made since back with it. The two
 * are complements, and the safety net under this one is the other: the route checkpoints before it resets.
 *
 * IT READS THE BRANCH'S OWN REFLOG, NOT HEAD'S. HEAD's reflog also records checkouts, so the entry before the
 * current one routinely belongs to a DIFFERENT branch — and resetting to it would move the wrong branch to a
 * position it never held. That is a data-loss bug wearing an undo button, and the reason for the extra lookup. */

// What the last reflog entry was, as far as we can name it. `other` is deliberate rather than a failure: an
// action this does not recognise is still undoable — the reflog records where the ref was regardless — and the
// UI can say so honestly instead of hiding a working button behind a vocabulary gap.
export type UndoKind = "commit" | "amend" | "merge" | "rebase" | "cherry-pick" | "revert" | "reset" | "pull" | "other";

export interface UndoableAction {
    readonly kind: UndoKind;
    // The reflog's own subject line ("commit: fix the parser") — what the button names, in git's words.
    readonly description: string;
    readonly branch: string;
    // Where the branch is now, and where undoing returns it to.
    readonly sha: string;
    readonly previousSha: string;
    // Whether the action changed the WORKING TREE as well as the ref, so undoing it faithfully needs a hard
    // reset rather than a soft one. A commit only moved the ref (its content is already in the tree); a merge,
    // rebase, cherry-pick, revert, reset or pull rewrote files.
    readonly changesWorkingTree: boolean;
}

const WORKING_TREE_KINDS = new Set<UndoKind>(["merge", "rebase", "cherry-pick", "revert", "reset", "pull", "other"]);

/* The reflog subject → what happened. Order matters: git writes `commit (amend)` and `commit (merge)` as
 * prefixes of `commit`, so the specific spellings have to be tested first or every amend reads as a commit.
 *
 * A subject that names the branch COMING INTO EXISTENCE has no earlier position to return to — undoing it would
 * mean deleting the branch, which is a different verb with different consequences — so those answer undefined
 * rather than `other`. */
const kindOf = (subject: string): UndoKind | undefined => {
    if (subject.startsWith("branch:") || subject.startsWith("clone:") || subject.startsWith("checkout:")) {
        return undefined;
    }
    if (subject.startsWith("commit (amend)")) {
        return "amend";
    }
    if (subject.startsWith("commit (merge)")) {
        return "merge";
    }
    if (subject.startsWith("commit (cherry-pick)")) {
        return "cherry-pick";
    }
    if (subject.startsWith("commit")) {
        return "commit";
    }
    if (subject.startsWith("pull --rebase")) {
        return "rebase";
    }
    for (const [prefix, kind] of [
        ["revert", "revert"],
        ["merge", "merge"],
        ["rebase", "rebase"],
        ["pull", "pull"],
        ["reset", "reset"],
        ["cherry-pick", "cherry-pick"],
    ] as const) {
        if (subject.startsWith(prefix)) {
            return kind;
        }
    }
    return "other";
};

// US (\x1f) between the two fields, as commitLog uses: a reflog subject is free text that routinely contains
// every ordinary punctuation character, so anything printable would eventually split a message in half.
const SEP = "\x1f";

export const undoableAction = async (dir: string, git: GitRunner = defaultGit): Promise<UndoableAction | undefined> => {
    // A halted merge/rebase/cherry-pick ends by ABORTING it, not by moving the branch — offering both would be
    // offering two different recoveries for one state, and only one of them is correct.
    if ((await operationInProgress(dir, git)) !== undefined) {
        return undefined;
    }
    // A detached HEAD has no branch reflog to walk back through, and nothing a reset could usefully move.
    const branch = (await git(dir, ["branch", "--show-current"]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (branch === "") {
        return undefined;
    }

    const output = await git(dir, ["reflog", "show", `--format=%H${SEP}%gs`, "-n", "2", `refs/heads/${branch}`]).catch(() => undefined);
    if (output === undefined) {
        return undefined;
    }
    const entries = output.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => line.split(SEP));

    // Each entry records the position the ref moved TO, so the entry BEFORE the current one holds the position
    // to return to. A branch with only one entry has never moved since it was created — nothing to undo.
    const [current, previous] = entries;
    const sha = current?.[0]?.trim() ?? "";
    const previousSha = previous?.[0]?.trim() ?? "";
    const description = current?.[1]?.trim() ?? "";
    if (sha === "" || previousSha === "" || description === "" || sha === previousSha) {
        return undefined;
    }

    const kind = kindOf(description);
    if (kind === undefined) {
        return undefined;
    }
    return { kind, description, branch, sha, previousSha, changesWorkingTree: WORKING_TREE_KINDS.has(kind) };
};

/* Move the branch back. `expectedPreviousSha` is the position the CALLER was shown, and the undo is refused when
 * it no longer matches — so an undo prepared against a stale view (another browser committed, the agent landed)
 * cannot quietly land somewhere the user never looked at. That check is the whole reason this re-reads rather
 * than trusting its argument.
 *
 * Soft moves the branch and nothing else, leaving what the undone action produced in the worktree and index;
 * hard also returns the tree. The caller decides, because "undo the commit but keep my files" and "undo the
 * rebase entirely" are both things people mean by undo. */
export const undoLastAction = async (
    dir: string,
    expectedPreviousSha: string,
    discardChanges: boolean,
    git: GitRunner = defaultGit,
): Promise<{ ok: true; action: UndoableAction } | { ok: false; reason: string }> => {
    const action = await undoableAction(dir, git);
    if (action === undefined) {
        return { ok: false, reason: "nothing to undo" };
    }
    if (action.previousSha !== expectedPreviousSha) {
        return { ok: false, reason: "the repository moved since this undo was prepared" };
    }
    await git(dir, ["reset", discardChanges ? "--hard" : "--soft", action.previousSha]);
    return { ok: true, action };
};
