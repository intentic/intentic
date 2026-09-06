import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../../history/history.js";
import { changedFiles, headSha } from "./changes.js";
import { identity } from "../git.js";

/* THE INDEX MOVES OF THE CHANGES PANEL: stage, unstage, commit what is staged, discard. These are the verbs
 * that WRITE to the user's own repo (changes.ts only reads it), so the commit here IS the review's "approve".
 * Each takes the injectable GitRunner (defaultGit shells out) so its command sequence is unit-testable without
 * a real repo. */

// Stage exactly `paths`, adds, edits AND deletions (`-A` covers a removed file, which a bare `add` skips).
export const stagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    if (paths.length === 0) {
        return;
    }
    await git(dir, ["add", "-A", "--", ...paths]);
};

// Unstage exactly `paths`, leaving the worktree untouched. On an unborn HEAD there is nothing to reset TO, so
// the index entry is dropped instead (`rm --cached`), the file returns to untracked rather than erroring.
export const unstagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    if (paths.length === 0) {
        return;
    }
    const head = await headSha(dir, git);
    if (head !== undefined) {
        await git(dir, ["reset", "-q", "--", ...paths]);
    } else {
        await git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...paths]);
    }
};

// Commit whatever is currently staged, touching neither the worktree nor any unstaged change, plain `git
// commit`. This is the ONLY way the panel records a commit (commitAll stages everything first, then lands
// here in spirit): the index is git's own answer to "what goes in", so nothing else needs to name paths.
// False ⇒ the index is clean, so there was nothing to do.
//
// Being a whole-index commit is also what makes it work mid-merge. The `commit --only` this replaces could
// not: git refuses a partial commit while MERGE_HEAD exists, and it refused only AFTER the paths had been
// staged, a commit that never happened, leaving the index moved.
export const commitIndex = async (
    dir: string,
    message: string,
    author: { readonly name: string; readonly email: string },
    git: GitRunner = defaultGit,
): Promise<boolean> => {
    const head = await headSha(dir, git);
    try {
        await git(dir, ["diff", "--cached", "--quiet", head ?? EMPTY_TREE]);
        return false;
    } catch {
        // The index differs from HEAD, fall through to commit.
    }
    await git(dir, [...identity(author), "commit", "-q", "-m", message]);
    return true;
};

// Discard uncommitted work: everything (no paths) or exactly `paths`. Tracked content returns to HEAD;
// untracked files are deleted. Ignored files (secrets, node_modules, nested repo dirs) always survive,
// clean runs without -x. The doubled -f also removes an embedded repo the agent git-init'ed (a single -f
// silently skips it, leaving a "discarded" dir behind).
export const discardPaths = async (dir: string, paths: readonly string[] | undefined, git: GitRunner = defaultGit): Promise<void> => {
    const head = await headSha(dir, git);
    if (paths === undefined) {
        if (head !== undefined) {
            await git(dir, ["reset", "-q", "--hard"]);
        } else {
            await git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "."]);
        }
        await git(dir, ["clean", "-q", "-f", "-f", "-d"]);
        return;
    }
    // A staged rename spans two paths, discarding either leg must undo both. Renames only ever appear on the
    // staged side (git detects them against HEAD), so that is the side to read `from` off.
    const { staged } = await changedFiles(dir, git);
    const targets = new Set<string>(paths);
    for (const change of staged) {
        if (change.from !== undefined && targets.has(change.path)) {
            targets.add(change.from);
        }
    }
    const list = [...targets];
    if (list.length === 0) {
        return;
    }
    // Unstage the targets so the re-scan below sees plain worktree-vs-HEAD states (renames decompose into a
    // tracked deletion + an untracked file).
    if (head !== undefined) {
        await git(dir, ["reset", "-q", "--", ...list]);
    } else {
        await git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...list]);
    }
    // Everything the targets still hold is now on the unstaged side (they were just unstaged), so that is the
    // only list to consult: "added" there means untracked (delete it), anything else is tracked (restore it).
    const after = (await changedFiles(dir, git)).unstaged.filter((change) => targets.has(change.path));
    const tracked = after.filter((change) => change.status !== "added").map((change) => change.path);
    const untracked = after.filter((change) => change.status === "added").map((change) => change.path);
    if (tracked.length > 0) {
        await git(dir, ["checkout", "-q", "-f", "HEAD", "--", ...tracked]);
    }
    if (untracked.length > 0) {
        await git(dir, ["clean", "-q", "-f", "-f", "-d", "--", ...untracked]);
    }
};
