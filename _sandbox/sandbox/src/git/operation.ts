import { access, lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* THE OPERATION A WORKTREE IS HALTED IN THE MIDDLE OF, and the way out of it.
 *
 * Every git verb this daemon runs itself aborts cleanly on failure (changes.ts runOrAbort), so nothing the UI
 * starts can leave a repo mid-operation. What CAN is everything else: an agent running `git rebase` in a
 * terminal, a user in a shell, a `land` that hit a conflict. Those leave a worktree git refuses to do almost
 * anything with, no commit, no checkout, no clean diff, and until now no surface named the state or offered a
 * way out of it. The Changes panel would list the conflicted files without ever saying WHY they were conflicted.
 *
 * Git records these as marker files in the PER-WORKTREE git dir, which is also how `git status` reports them, so
 * this reads the same evidence git does rather than parsing its prose. */

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

/* Whether the sequencer still holds QUEUED picks. The todo list is shared by cherry-pick and revert, which
 * distinguish themselves by the verb on each line, so the first real line names the operation.
 *
 * This exists because of a case the marker files alone get wrong: committing a resolved pick by hand clears
 * CHERRY_PICK_HEAD while leaving the rest of the sequence queued, and git goes on reporting a cherry-pick in
 * progress. A check that stopped at the markers would call that worktree clean and offer no abort. */
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

// The per-worktree git dir. NOT the common dir. Every marker below is per worktree, which is what makes an
// agent's linked worktree report its own halted state rather than the main checkout's.
//
// Read straight off the `.git` entry rather than asked of `rev-parse --git-dir`, because this runs for every
// repo on every Changes scan and the spawn was a scan-wide multiplier for an answer the filesystem already
// holds: every caller passes a checkout ROOT (the workspace repo dirs, an agent's worktree), where `.git` is
// either the admin dir itself or a pointer FILE whose one line is the path (`gitdir: <path>`, what
// repo-git-dirs.ts and worktree checkouts both write, and exactly what git's own discovery reads). No memo, so
// nothing can go stale: a re-created checkout is re-read from its fresh pointer on the next call.
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
        return undefined; // Not a repo (or a torn pointer) — the same "nothing to report" as before.
    }
};

// No git runner: every answer below comes from the filesystem, which is the whole point of the change above.
export const operationInProgress = async (dir: string): Promise<GitOperation | undefined> => {
    const gitDir = await gitDirOf(dir);
    if (gitDir === undefined) {
        return undefined;
    }

    /* `rebase-merge` covers the interactive and merge backends; `rebase-apply` the patch backend, which
     * `git am` SHARES. An `am` in progress is not a rebase and `git rebase --abort` is not what ends it, so the
     * `applying` marker inside distinguishes them and we report nothing rather than offering an abort that
     * would fail. */
    if (await exists(join(gitDir, "rebase-merge"))) {
        return "rebase";
    }
    if (await exists(join(gitDir, "rebase-apply"))) {
        return (await exists(join(gitDir, "rebase-apply", "applying"))) ? undefined : "rebase";
    }

    if (await exists(join(gitDir, "REVERT_HEAD"))) {
        return "revert";
    }
    if (await exists(join(gitDir, "CHERRY_PICK_HEAD"))) {
        return "cherry-pick";
    }
    // Markers cleared but the sequence unfinished, see queuedSequence.
    const queued = await queuedSequence(gitDir);
    if (queued !== undefined) {
        return queued;
    }

    /* Checked LAST, after the rebase markers, and that order matters: a rebase that stops on a
     * conflicted merge commit writes MERGE_HEAD too, and there `git merge --abort` is not what ends the
     * operation, `git rebase --abort` is. Reading MERGE_HEAD first would offer the wrong escape hatch. */
    return (await exists(join(gitDir, "MERGE_HEAD"))) ? "merge" : undefined;
};

// End the operation and return the worktree to where it started. Git's own `--abort` for each verb; the caller
// has already established which one is in progress, and git's error propagates if it has since finished.
export const abortOperation = async (dir: string, operation: GitOperation, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, [operation, "--abort"]);
};
