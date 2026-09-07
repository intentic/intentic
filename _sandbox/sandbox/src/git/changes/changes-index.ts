import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../../history/history.js";
import { changedFiles, headSha } from "./changes.js";
import { identity } from "../git.js";

/* THE INDEX MOVES OF THE CHANGES PANEL: stage, unstage, commit what is staged, discard. These are the verbs
 * that WRITE to the user's own repo (changes.ts only reads it), so the commit here IS the review's "approve".
 * Each takes the injectable GitRunner (defaultGit shells out) so its command sequence is unit-testable without
 * a real repo. */

/* HOW MUCH OF ONE COMMAND LINE THE PATHS MAY FILL, and why any of this is here.
 *
 * An argv is bounded by the operating system (ARG_MAX; 2MB on Linux, and the environment is counted against
 * the same ceiling), so "name every path" stops working at a size a repository reaches for perfectly ordinary
 * reasons: a directory overhaul, a mass delete, a dropped project of thirty thousand untracked files. Past it
 * the spawn fails with E2BIG, which surfaces as a git verb that simply refuses, with an error about argument
 * lists that says nothing about the review the user was doing.
 *
 * The ceiling used to be dodged rather than handled, by a `.max(500)` on every path array in the wire contract
 * — which is how the panel ended up able to stage only the rows it had drawn, and the user ended up committing
 * a large change set five hundred files at a time. Splitting the call is the honest fix, and it is nearly free:
 * git's work is per path either way, so an extra process per ~96KB of names is noise beside the tree walk it
 * was always going to do. With that here, list length is no longer anybody else's problem.
 *
 * Well under the real ceiling on purpose: this counts the paths only, while the kernel counts the whole
 * environment with them, and a slice this size still puts a thousand-odd typical paths in each call. */
const ARGV_BUDGET_BYTES = 96 * 1024;

// Split a path list into runs that each fit the budget. A single path longer than the budget still gets its own
// call rather than being dropped: the OS limit on one argument is separate and far higher, so it works, and
// silently skipping a file would be the one outcome worse than a failed spawn.
export const chunkPaths = (paths: readonly string[]): readonly (readonly string[])[] => {
    const chunks: string[][] = [];
    let current: string[] = [];
    let used = 0;
    for (const path of paths) {
        const cost = Buffer.byteLength(path, "utf8") + 1;
        if (current.length > 0 && used + cost > ARGV_BUDGET_BYTES) {
            chunks.push(current);
            current = [];
            used = 0;
        }
        current.push(path);
        used += cost;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
};

// Run one git command per chunk. Sequential, not concurrent: every caller here writes the index, and two git
// processes writing one index race for `index.lock` and one of them loses.
const overPaths = async (dir: string, paths: readonly string[], argsFor: (chunk: readonly string[]) => string[], git: GitRunner): Promise<void> => {
    for (const chunk of chunkPaths(paths)) {
        await git(dir, argsFor(chunk));
    }
};

// Stage exactly `paths`, adds, edits AND deletions (`-A` covers a removed file, which a bare `add` skips).
export const stagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    await overPaths(dir, paths, (chunk) => ["add", "-A", "--", ...chunk], git);
};

/* Stage the whole repository, the one scope git can express without naming anything: one spawn, no list to
 * build, and no ceiling to chunk under however many files are pending. This is what "stage everything and
 * commit" resolves to, and it is why that shape has always reached files the review never shipped a row for.
 *
 * The two flags are the ones the daemon's own whole-repo stage has always carried (scaffold's gitCommitAll,
 * which is what the Changes panel's "Commit all" used to route to). Kept identical on purpose: moving that
 * button onto this changes how the commit is RECORDED (it runs the repo's hooks now, where gitCommitAll's
 * `--no-verify` did not) and deliberately nothing about which files get collected:
 *   --ignore-errors             , one unreadable file does not abandon the other four thousand. In a workspace
 *                                 where an agent may be writing while you stage, that is a real case and the
 *                                 whole-or-nothing alternative is the worse one.
 *   advice.addEmbeddedRepo=false, a nested repo is a scanned repo of its own here, not a gitlink to warn about. */
export const stageAll = async (dir: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors"]);
};

/* Unstage exactly `paths`, leaving the worktree untouched. On an unborn HEAD there is nothing to reset TO, so
 * the index entry is dropped instead (`rm --cached`), the file returns to untracked rather than erroring.
 *
 * PATH-LIMITED EVEN WHEN THE TARGET IS THE WHOLE INDEX, which is the one place chunking is doing more than
 * dodging a ceiling. A bare `git reset` resets the index in a single spawn, but it also clears MERGE_HEAD: mid
 * merge or rebase, "unstage everything" would silently abandon the operation and every conflict resolved so
 * far. `git reset -- <paths>` never touches that state, so the loop is the safe spelling at every size. */
export const unstagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    if (paths.length === 0) {
        return;
    }
    const head = await headSha(dir, git);
    await overPaths(
        dir,
        paths,
        head !== undefined ? (chunk) => ["reset", "-q", "--", ...chunk] : (chunk) => ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...chunk],
        git,
    );
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
    // tracked deletion + an untracked file). Chunked like every other list here: this one is built from the
    // repo's own status rather than from the request, so it was never bounded by what a caller could send.
    await overPaths(
        dir,
        list,
        head !== undefined ? (chunk) => ["reset", "-q", "--", ...chunk] : (chunk) => ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...chunk],
        git,
    );
    // Everything the targets still hold is now on the unstaged side (they were just unstaged), so that is the
    // only list to consult: "added" there means untracked (delete it), anything else is tracked (restore it).
    const after = (await changedFiles(dir, git)).unstaged.filter((change) => targets.has(change.path));
    const tracked = after.filter((change) => change.status !== "added").map((change) => change.path);
    const untracked = after.filter((change) => change.status === "added").map((change) => change.path);
    await overPaths(dir, tracked, (chunk) => ["checkout", "-q", "-f", "HEAD", "--", ...chunk], git);
    await overPaths(dir, untracked, (chunk) => ["clean", "-q", "-f", "-f", "-d", "--", ...chunk], git);
};
