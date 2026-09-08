import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../../history/history.js";
import { changedFiles, headSha } from "./changes.js";
import { identity } from "../git.js";

// Index moves of the Changes panel: stage, unstage, commit staged, discard; these write to the repo, unlike changes.ts.
// Each takes an injectable GitRunner (defaultGit shells out), unit-testable without a real repo.

// Argv is bounded by the OS (ARG_MAX); paths are chunked to stay well under it rather than truncating the list.
const ARGV_BUDGET_BYTES = 96 * 1024;

// Splits a path list into runs that fit the budget; an over-budget path still gets its own call, never dropped.
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

// Runs one git command per chunk, sequentially: concurrent writers would race for `index.lock`.
const overPaths = async (dir: string, paths: readonly string[], argsFor: (chunk: readonly string[]) => string[], git: GitRunner): Promise<void> => {
    for (const chunk of chunkPaths(paths)) {
        await git(dir, argsFor(chunk));
    }
};

// Stages exactly `paths`: adds, edits, and deletions (`-A` covers a removal, which a bare `add` skips).
export const stagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    await overPaths(dir, paths, (chunk) => ["add", "-A", "--", ...chunk], git);
};

// Stages the whole repo in one spawn, with no ceiling to chunk under; what a whole-repo commit resolves to.
// - --ignore-errors: one unreadable file doesn't abandon the rest (an agent may be writing while you stage).
// - advice.addEmbeddedRepo=false: a nested repo is scanned here, not warned about as a gitlink.
export const stageAll = async (dir: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors"]);
};

// Unstages exactly `paths`, worktree untouched; on an unborn HEAD the entry is dropped instead (`rm --cached`).
// Path-limited even for the whole index: a bare `git reset` clears MERGE_HEAD, abandoning a mid-merge or rebase.
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

// Commits whatever is staged, touching nothing else; the only way the panel records a commit.
// False means the index is already clean; a whole-index commit also works mid-merge, unlike `commit --only`.
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

// Discards uncommitted work: everything, or exactly `paths`; tracked content returns to HEAD, untracked is deleted.
// Ignored files always survive (no -x); the doubled -f also removes an embedded repo a single -f would skip.
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
    // A staged rename spans two paths; discarding either leg must undo both, so `from` is read off the staged side.
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
    // Unstages targets first so the re-scan sees plain worktree-vs-HEAD states (a rename decomposes into two).
    await overPaths(
        dir,
        list,
        head !== undefined ? (chunk) => ["reset", "-q", "--", ...chunk] : (chunk) => ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...chunk],
        git,
    );
    // Targets are now on the unstaged side; "added" means untracked (delete), anything else tracked (restore).
    const after = (await changedFiles(dir, git)).unstaged.filter((change) => targets.has(change.path));
    const tracked = after.filter((change) => change.status !== "added").map((change) => change.path);
    const untracked = after.filter((change) => change.status === "added").map((change) => change.path);
    await overPaths(dir, tracked, (chunk) => ["checkout", "-q", "-f", "HEAD", "--", ...chunk], git);
    await overPaths(dir, untracked, (chunk) => ["clean", "-q", "-f", "-f", "-d", "--", ...chunk], git);
};
