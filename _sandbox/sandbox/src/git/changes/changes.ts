import { join } from "node:path";
import type { GitChange } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../../history/history.js";
import { readWorkspaceFile, statWorkspaceFileSize } from "../../workspace/files/workspace-files.js";
import { parseNameStatusZ, parseNumstatZ, parseStatusV2 } from "./changes-porcelain.js";
import { MAX_FILE_DIFF_BYTES } from "./diff-partial.js";

// Working-tree review: uncommitted changes (status vs HEAD) and the cumulative delta of an agent's checkout or branch.
// Rest of the review sits beside this file: porcelain parsers, index moves, diffs, and the commit graph.
// Runs against the real git dir; each function takes an injectable GitRunner (defaultGit shells out).

// HEAD's sha; undefined on an unborn HEAD, where everything reads as added and index-reset needs a different spelling.
// Exported for land/origins, which re-check it to see whether landed work is still uncommitted.
export const headSha = async (dir: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    try {
        return (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
    } catch {
        return undefined;
    }
};

// Merges per-file +/- counts from `--numstat -z` onto a change list; `scope` matches the name-status list's own diff.
// No numstat entry (binary, or a skipped conflict) keeps counts undefined; untracked is withUntrackedLineStats's job.
const withLineStats = async (dir: string, scope: readonly string[], changes: GitChange[], git: GitRunner): Promise<GitChange[]> => {
    if (changes.length === 0) {
        return changes;
    }
    const { stdout } = await git(dir, ["diff", "--numstat", "-z", "--find-renames", ...scope]);
    const stats = parseNumstatZ(stdout);
    return changes.map((change) => {
        const stat = stats.get(change.path);
        return stat === undefined ? change : { ...change, ...stat };
    });
};

// An untracked file has no blob either side, so numstat never names it; counted the way git counts a file.
// Read directly, not shelled to `git diff --no-index`: that's one process per file across a whole dropped project.
const untrackedLineStats = async (dir: string, path: string): Promise<{ additions: number; deletions: number } | undefined> => {
    const abs = join(dir, path);
    const size = await statWorkspaceFileSize(abs);
    // Gone since the ls-files walk, or past what one read may hold (MAX_TEXT_BYTES); no counts either way.
    if (size === undefined || size > MAX_FILE_DIFF_BYTES) {
        return undefined;
    }
    const content = await readWorkspaceFile(abs);
    if (content === undefined || content.includes("\0")) {
        return undefined;
    }
    return { additions: content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0), deletions: 0 };
};

// Thousands of untracked paths would hold every file in memory at once; read a few at a time off a shared cursor.
// Files not in `untracked` are left exactly as the numstat pass returned them.
const UNTRACKED_READ_CONCURRENCY = 8;
const withUntrackedLineStats = async (dir: string, untracked: readonly string[], changes: GitChange[]): Promise<GitChange[]> => {
    if (untracked.length === 0) {
        return changes;
    }
    const stats = new Map<string, { additions: number; deletions: number }>();
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(UNTRACKED_READ_CONCURRENCY, untracked.length) }, async () => {
            for (let index = cursor++; index < untracked.length; index = cursor++) {
                const path = untracked[index] ?? "";
                const stat = await untrackedLineStats(dir, path);
                if (stat !== undefined) {
                    stats.set(path, stat);
                }
            }
        }),
    );
    return changes.map((change) => {
        const stat = stats.get(change.path);
        return stat === undefined ? change : { ...change, ...stat };
    });
};

// Uncommitted work split as git and VSCode's SCM view model it: conflicted, staged (vs HEAD), unstaged (+ untracked).
// Staged and unstaged stay separate: a path can hold both with different statuses (a staged rename, then edited).
// Conflicts are their own list, never staged: an unmerged path has no stage 0, and git refuses to commit one.
// Three spawns, not seven: --no-optional-locks (skip index.lock), -uall (untracked dirs), --find-renames (renames).
export const changedFiles = async (
    dir: string,
    git: GitRunner = defaultGit,
): Promise<{
    branch?: string;
    head?: string;
    conflicted: GitChange[];
    staged: GitChange[];
    unstaged: GitChange[];
    // Each side's blob name, for the caller counting code (code-counts.ts); free here, a spawn per file elsewhere.
    blobs: Map<string, { head?: string; index?: string }>;
}> => {
    const { stdout } = await git(dir, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "-uall", "--find-renames"]);
    const { branch, head, conflicted, staged: stagedNames, unstaged: unstagedNames, untracked, blobs } = parseStatusV2(stdout);
    // On an unborn HEAD the empty tree stands in for a commit, so a first commit in progress reports staged files.
    const base = head ?? EMPTY_TREE;
    // Untracked files are unstaged by definition; appended at the end so tracked rows keep git's order.
    for (const path of untracked) {
        unstagedNames.push({ path, status: "added" });
    }
    // No numstat for a conflict: line counts have no answer across three stages, so the row shows none.
    const [staged, unstaged] = await Promise.all([
        withLineStats(dir, ["--cached", base], stagedNames, git),
        withLineStats(dir, [], unstagedNames, git).then((changes) => withUntrackedLineStats(dir, untracked, changes)),
    ]);
    // `head` rides along free from the status read; other readers would each spend a rev-parse for the same sha.
    return { ...(branch !== undefined ? { branch } : {}), ...(head !== undefined ? { head } : {}), conflicted, staged, unstaged, blobs };
};

// Cumulative delta vs a fixed base sha: committed work since base, plus staged/unstaged, merged with untracked files.
// The agents review reads a conversation worktree with this; `base` is where the worktree branched from.
export const changesAgainstBase = async (dir: string, base: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    // --find-renames on both passes, or a rename splits into delete+add that numstat can only answer half of.
    const { stdout } = await git(dir, ["diff", "--name-status", "-z", "--find-renames", base]);
    const changes = new Map(parseNameStatusZ(stdout).map((change) => [change.path, change]));
    const untrackedOut = (await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0");
    const untracked: string[] = [];
    for (const path of untrackedOut) {
        if (path !== "" && !changes.has(path)) {
            changes.set(path, { path, status: "added" });
            untracked.push(path);
        }
    }
    // Same numstat pass as the working-tree review; untracked files added above are counted from disk instead.
    const counted = await withLineStats(dir, [base], [...changes.values()], git);
    return withUntrackedLineStats(dir, untracked, counted);
};

// Same cumulative delta as changesAgainstBase, from two refs instead of a checkout; what an archived review runs on.
// No untracked pass needed: archiving commits whatever the worktree held onto the branch first.
export const changesBetweenRefs = async (dir: string, base: string, tip: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    const { stdout } = await git(dir, ["diff", "--name-status", "-z", "--find-renames", base, tip]);
    return withLineStats(dir, [base, tip], parseNameStatusZ(stdout), git);
};

// Every path the working trees under `root` have changed, root-relative, across the root repo and each nested one.
// A nested repo shows as one untracked entry in the root's own status; dropped here since it answers for itself.
export const dirtyPathsAcross = async (root: string, repos: readonly string[], git: GitRunner = defaultGit): Promise<string[]> => {
    const nested = new Set(repos.flatMap((repo) => [repo, `${repo}/`]));
    const paths = new Set<string>();
    const collect = async (dir: string, prefix: string): Promise<void> => {
        const { conflicted, staged, unstaged } = await changedFiles(dir, git).catch(() => ({ conflicted: [], staged: [], unstaged: [] }));
        for (const change of [...conflicted, ...staged, ...unstaged]) {
            for (const path of [change.path, change.from]) {
                if (path !== undefined && !(prefix === "" && nested.has(path))) {
                    paths.add(prefix === "" ? path : `${prefix}/${path}`);
                }
            }
        }
    };
    await Promise.all([collect(root, ""), ...repos.map((repo) => collect(join(root, repo), repo))]);
    return [...paths];
};
