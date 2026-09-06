import { join } from "node:path";
import type { GitChange } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../../history/history.js";
import { readWorkspaceFile, statWorkspaceFileSize } from "../../workspace/files/workspace-files.js";
import { parseNameStatusZ, parseNumstatZ, parseStatusV2 } from "./changes-porcelain.js";
import { MAX_FILE_DIFF_BYTES } from "./diff-partial.js";

// Working-tree review over a real repo: uncommitted changes (status vs HEAD), and the cumulative delta of an
// agent's checkout or branch. The rest of the review sits beside this file: the porcelain parsers
// (changes-porcelain.ts), the index moves (changes-index.ts), the per-file diffs (changes-diff.ts) and the
// commit graph with its actions (changes-commits.ts). Everything runs against the repo's real git dir, unlike
// the shadow history, these are the user's own branches, so a commit here IS the review's "approve". All
// functions take the injectable GitRunner (defaultGit shells out) so command sequences are unit-testable
// without a real repo.

// HEAD's sha; undefined on an unborn HEAD (a repo initialized but never committed), everything is "added"
// there and the index-reset verbs need a different spelling. Exported for land/origins, which record and then
// re-check it to decide whether an agent's landed work is still the uncommitted content of the main tree.
export const headSha = async (dir: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    try {
        return (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
    } catch {
        return undefined;
    }
};

// Merge per-file +/- line counts onto a change list from a `git diff --numstat -z` variant (rename detection
// on, so a rename's counts key on the new path, the shape parseNumstatZ handles). `scope` is the diff's own
// arguments, so the counts always come from the SAME comparison the name-status list did: index-vs-HEAD for the
// staged side, worktree-vs-index for the unstaged side. A change with no numstat entry keeps undefined counts,
// which the UI omits, a binary file (git reports `-\t-`), or a conflict, which gets no numstat pass at all.
// Untracked files are absent from every numstat because they have no blob on either side; withUntrackedLineStats
// answers for those.
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

/* THE LINE COUNT OF A FILE GIT HAS NEVER SEEN.
 *
 * An untracked file has no blob on either side, so no `git diff --numstat` names it, and the row that
 * ls-files put in the list therefore carried no counts. That reads as a cosmetic gap on one row and is not:
 * the review header and the fleet card SUM these counts, so every file an agent had newly written counted as
 * zero until the moment it was committed. The same work read "+805 −861" while a new 89-line file sat
 * untracked and "+894 −861" one commit later, with nothing about the work itself having changed.
 *
 * The whole content of a new file is an addition, so the count is its line count, measured the way git
 * measures one, where a trailing partial line still counts (`printf 'a\nb'` is two additions).
 *
 * Read here rather than shelled to `git diff --no-index`, which would give the same numbers: that is one
 * process per file, and this list is a whole dropped project's worth of paths on the Changes panel. The size
 * cap and the NUL test for binary are the ones worktreeSide (changes-diff.ts) already applies to the diff BODY, so a row's badge
 * and the diff it opens never disagree about what is renderable. */
const untrackedLineStats = async (dir: string, path: string): Promise<{ additions: number; deletions: number } | undefined> => {
    const abs = join(dir, path);
    const size = await statWorkspaceFileSize(abs);
    // Gone since the ls-files walk, or past what one read may hold (see workspace-files' MAX_TEXT_BYTES note,
    // whole-file reads are what once blocked the daemon's only loop). No counts, exactly as before.
    if (size === undefined || size > MAX_FILE_DIFF_BYTES) {
        return undefined;
    }
    const content = await readWorkspaceFile(abs);
    if (content === undefined || content.includes("\0")) {
        return undefined;
    }
    return { additions: content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0), deletions: 0 };
};

// A whole dropped project can be thousands of untracked paths, and each read holds its file in memory for as
// long as it takes to count, so they run a few at a time off a shared cursor rather than all at once (the
// archive teardown pool's shape). Files not in `untracked` are left exactly as the numstat pass returned them.
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

// One repo's uncommitted work, split the way git actually models it, and the way VSCode's SCM view renders it:
//
//   conflicted = unmerged paths        (`U` on either side), a merge git could not finish
//   staged     = index vs HEAD         (`git diff --cached`), what `git commit` would record right now
//   unstaged   = worktree vs index     (`git diff`) + untracked files
//
// The two clean sides stay two lists, because a path can legitimately appear on BOTH with DIFFERENT statuses (a
// staged rename whose new file was then edited, the classic `MM`). Reporting one status per path, as this once
// did, made a partially-staged file carry a stat that matched neither side. What produces the two lists is one
// `--porcelain=v2` read, its `XY` is exactly those two sides (see parseStatusV2), and each side then gets its
// OWN numstat pass, so every count still describes the diff it is displayed under.
//
// Conflicts are their own list, not a third opinion about staging: an unmerged path has no stage 0 at all, so
// "what would a commit record" has no answer for it, git refuses to commit while one exists. Listing it as
// staged (which the `U` letter, read as a fallback "modified", used to do) claimed it was ready to commit and
// offered an index-vs-HEAD diff that cannot be computed. v2 gives it its own record kind, so it is never in
// either side to begin with.
//
// THREE SPAWNS, NOT SEVEN, and that is the point of reading status rather than assembling the same answer from
// `branch` + `rev-parse` + two `diff --name-status` + `ls-files`: this runs for every repo on every scan, several
// times a second while an agent writes, and it was the daemon's most contended path.
//
// `--no-optional-locks` because a poller must never take `index.lock` for a refresh it only wants to read,
// agents are running their own git in these same repos continuously, and the loser of that race fails outright.
// `-uall` expands untracked directories into real file paths (per-path actions need them), and info/exclude +
// .gitignore keep the walk off the nested repo dirs, .intentic/ and junk in the root repo. `--find-renames`
// states what git already defaults to, so a repo carrying `status.renames=false` cannot quietly disagree with
// the numstat passes, which ask for it explicitly.
export const changedFiles = async (
    dir: string,
    git: GitRunner = defaultGit,
): Promise<{
    branch?: string;
    head?: string;
    conflicted: GitChange[];
    staged: GitChange[];
    unstaged: GitChange[];
    // What each side's blob is called, for the caller that counts these files' code (git.routes' scan, through
    // code-counts.ts). Free here, a spawn per file anywhere else.
    blobs: Map<string, { head?: string; index?: string }>;
}> => {
    const { stdout } = await git(dir, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "-uall", "--find-renames"]);
    const { branch, head, conflicted, staged: stagedNames, unstaged: unstagedNames, untracked, blobs } = parseStatusV2(stdout);
    // On an unborn HEAD there is no commit to diff the index against, the empty tree stands in, so a repo
    // whose first commit is still being composed reports its staged files instead of nothing.
    const base = head ?? EMPTY_TREE;
    // Untracked files are unstaged by definition (nothing about them is in the index yet), and they go on the end
    // so the tracked rows keep git's own ordering.
    for (const path of untracked) {
        unstagedNames.push({ path, status: "added" });
    }
    // No numstat for a conflict: "how many lines changed" has no answer across three stages, and the row shows
    // no diffstat rather than an invented one.
    const [staged, unstaged] = await Promise.all([
        withLineStats(dir, ["--cached", base], stagedNames, git),
        withLineStats(dir, [], unstagedNames, git).then((changes) => withUntrackedLineStats(dir, untracked, changes)),
    ]);
    // `head` rides along because the status read already carries it, and the scan's other readers (the
    // attribution pass above all) each spend a rev-parse to learn the same sha, see git.routes scanRepo.
    return { ...(branch !== undefined ? { branch } : {}), ...(head !== undefined ? { head } : {}), conflicted, staged, unstaged, blobs };
};

// A repo's cumulative delta vs a fixed base sha, committed work since the base PLUS staged and unstaged
// edits (one diff covers all three), merged with untracked files. The agents review reads a conversation
// worktree with this: `base` is the sha the worktree branched from, so the result is exactly what landing
// would bring to the main tree, in the same GitChange shape the Changes panel renders.
export const changesAgainstBase = async (dir: string, base: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    // --find-renames on BOTH passes, or they describe different diffs: withLineStats always asks for it, so a
    // name-status pass without it splits a rename into a delete + an add that the numstat map (one record, keyed
    // on the new path) can only answer half of. Invisible under git's default diff.renames=true, which is
    // exactly what makes it worth pinning rather than leaving to a config this daemon does not own.
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
    // Same numstat pass as the working-tree review, keyed to the worktree's base; the untracked files added
    // above are in no numstat at all, so they are counted from disk, see withUntrackedLineStats for why the
    // totals over this list are wrong without it.
    const counted = await withLineStats(dir, [base], [...changes.values()], git);
    return withUntrackedLineStats(dir, untracked, counted);
};

// The same cumulative delta as changesAgainstBase, read from two REFS instead of a checkout, what an ARCHIVED
// agent's review runs on, since archiving retires the worktree and keeps only the agent/<id> branch. Run
// against the MAIN repo dir: a worktree shares its object store, so every sha the branch names is still
// readable there after the checkout is gone.
//
// No untracked pass, and that is not an omission: archiving commits whatever the worktree still held onto the
// branch first (agents/archive.ts), so `tip` already contains everything a `ls-files --others` walk would have
// found. Nothing on disk is left to consult.
export const changesBetweenRefs = async (dir: string, base: string, tip: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    const { stdout } = await git(dir, ["diff", "--name-status", "-z", "--find-renames", base, tip]);
    return withLineStats(dir, [base, tip], parseNameStatusZ(stdout), git);
};

/* EVERY PATH THE WORKING TREES UNDER `root` HAVE CHANGED, root-relative: the root repo's own and each nested
 * repo's (`repos` as repo-discovery.ts names them), so an edit reads the same whichever repo of the composition it
 * landed in. A rename contributes both of its names. Read-only and total: a repo that cannot answer contributes
 * nothing rather than failing the whole read.
 *
 * The root repo reports a nested repository as ONE untracked entry (`? intentic/`), never its contents; that entry
 * is dropped here because the nested repo answers for itself, and left in it would make `intentic/**` match a
 * turn that touched nothing under it. A gitlink staged for one (root-repo.ts converges those away) is the same
 * entry under another status and is dropped the same way. */
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
