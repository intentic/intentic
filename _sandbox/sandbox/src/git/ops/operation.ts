import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists } from "../../path-exists.js";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

// The operation a worktree is halted in, and the way out. Only external actors (a terminal rebase, a user's shell, a
// failed land) can leave one, since every verb this daemon runs itself self-aborts on failure. Reads the same
// per-worktree marker files `git status` does.

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

// Whether the sequencer still holds queued picks; the shared todo list's first real line names cherry-pick vs revert.
// Needed because committing a resolved pick by hand clears CHERRY_PICK_HEAD but leaves the rest queued.
const queuedSequence = async (gitDir: string): Promise<GitOperation | undefined> => {
    try {
        const todo = await readFile(join(gitDir, "sequencer", "todo"), "utf8");
        const first = todo
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line !== "" && !line.startsWith("#"));
        if (first === undefined) {
            return undefined;
        }
        return first.startsWith("revert ") ? "revert" : first.startsWith("pick ") ? "cherry-pick" : undefined;
    } catch {
        return undefined;
    }
};

// The per-worktree git dir (not the common dir), since every marker is per-worktree. Read straight off `.git` rather
// than `rev-parse --git-dir`, avoiding a spawn per repo per scan; unmemoized, so nothing goes stale.
const gitDirOf = async (dir: string): Promise<string | undefined> => {
    const entry = join(dir, ".git");
    try {
        const stats = await lstat(entry);
        if (stats.isDirectory()) {
            return entry;
        }
        const target = /^gitdir:\s*(.+?)\s*$/.exec(await readFile(entry, "utf8"))?.[1];
        // A relative pointer is resolved against the dir holding it, the rule gitfiles are defined by.
        return target === undefined ? undefined : resolve(dir, target);
    } catch {
        return undefined; // Not a repo (or a torn pointer): the same "nothing to report" as before.
    }
};

// No git runner: every answer here comes straight from the filesystem.
export const operationInProgress = async (dir: string): Promise<GitOperation | undefined> => {
    const gitDir = await gitDirOf(dir);
    if (gitDir === undefined) {
        return undefined;
    }

    // `rebase-merge` is the interactive/merge backend; `rebase-apply` is shared with `git am`. The `applying` marker
    // inside tells them apart, since `rebase --abort` can't end an `am`.
    if (await pathExists(join(gitDir, "rebase-merge"))) {
        return "rebase";
    }
    if (await pathExists(join(gitDir, "rebase-apply"))) {
        return (await pathExists(join(gitDir, "rebase-apply", "applying"))) ? undefined : "rebase";
    }

    if (await pathExists(join(gitDir, "REVERT_HEAD"))) {
        return "revert";
    }
    if (await pathExists(join(gitDir, "CHERRY_PICK_HEAD"))) {
        return "cherry-pick";
    }
    // Markers cleared but the sequence unfinished, see queuedSequence.
    const queued = await queuedSequence(gitDir);
    if (queued !== undefined) {
        return queued;
    }

    // Checked last: a rebase that stops on a conflicted merge commit also writes MERGE_HEAD, so checking it first would
    // offer `merge --abort` instead of `rebase --abort`.
    return (await pathExists(join(gitDir, "MERGE_HEAD"))) ? "merge" : undefined;
};

// Git's own `--abort` for the given verb; the caller has already established which operation is in progress.
export const abortOperation = async (dir: string, operation: GitOperation, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, [operation, "--abort"]);
};
