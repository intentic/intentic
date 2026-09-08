import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { operationInProgress } from "./operation.js";

// Moves a branch back to its reflog's previous position (git has no native undo). Complements Checkpoints (which
// restores the worktree, not the branch); reads the branch's own reflog, not HEAD's, which conflates checkouts across
// branches.

// What the last reflog entry was; `other` means unrecognised but still undoable, since the reflog knows the position
// regardless.
export type UndoKind = "commit" | "amend" | "merge" | "rebase" | "cherry-pick" | "revert" | "reset" | "pull" | "other";

export interface UndoableAction {
    readonly kind: UndoKind;
    // The reflog's own subject line ("commit: fix the parser"), what the button names, in git's words.
    readonly description: string;
    readonly branch: string;
    // Where the branch is now, and where undoing returns it to.
    readonly sha: string;
    readonly previousSha: string;
    // Whether the action touched the worktree too, so undoing it needs a hard reset, not a soft one.
    readonly changesWorkingTree: boolean;
}

const WORKING_TREE_KINDS = new Set<UndoKind>(["merge", "rebase", "cherry-pick", "revert", "reset", "pull", "other"]);

// Order matters: `commit (amend)`/`commit (merge)` must be tested before the bare `commit` prefix. A branch-creation
// entry (branch:/clone:/checkout:) has no earlier position, so it's undefined, not `other`.
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

// US (\x1f) between fields: a reflog subject is free text and could contain any printable separator.
const SEP = "\x1f";

export const undoableAction = async (dir: string, git: GitRunner = defaultGit): Promise<UndoableAction | undefined> => {
    // A halted merge/rebase/cherry-pick ends by aborting, not by moving the branch; offering both would be two
    // recoveries for one state.
    if ((await operationInProgress(dir)) !== undefined) {
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

    // Each entry is the position moved TO, so the entry before current is the one to return to; a single entry means
    // the branch has never moved.
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

// Refused if `expectedPreviousSha` no longer matches (a stale view from another browser or an agent's land) rather than
// landing blind; re-read, not trusted. Soft moves only the branch; hard also returns the tree.
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
