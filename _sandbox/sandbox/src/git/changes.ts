import { join } from "node:path";
import type { FileDiff, GitChange, GitCommit } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../history/history.js";
import { readWorkspaceFile, readWorkspaceFileWindow, statWorkspaceFileSize } from "../workspace/workspace-files.js";
import { additionPatch, MAX_FILE_DIFF_BYTES, MAX_PATCH_BYTES, partialDiff } from "./diff-partial.js";

// Working-tree review over a real repo: uncommitted changes (status vs HEAD), per-path commit, per-path
// discard, and a HEAD↔worktree file diff. Everything runs against the repo's real git dir, unlike the shadow
// history, these are the user's own branches, so commit here IS the review's "approve". All functions take the
// injectable GitRunner (defaultGit shells out) so command sequences are unit-testable without a real repo.

// `U` is git's unmerged marker, a path the merge could not resolve, which is neither staged nor unstaged but
// its own third state (there is no stage 0 for it at all; the index holds stages 1/2/3 instead).
const STATUS_OF: Record<string, GitChange["status"]> = { A: "added", M: "modified", D: "deleted", T: "type-changed", U: "conflicted" };

/* The paths in one `-z` git listing, each COPIED OUT of the string it arrived in, for callers that CACHE
 * what this returns.
 *
 * `split` answers with V8 sliced strings: views into the parent, which therefore pin the ENTIRE stdout, a
 * fleet-wide `--name-only` span runs to megabytes, for as long as ONE cached path lives. That was most of the
 * daemon's heap: the attribution caches (agents/origins.ts, agents/landed-presence.ts) held path lists whose
 * every element secretly retained a quarter-megabyte diff listing, ~180 MB per pass over the fleet's landings,
 * repinned at every new HEAD, never released. The Buffer round-trip allocates each path as its own flat string,
 * so the parent dies with this call frame. Callers that consume paths transiently can keep plain split(). */
export const materializedPaths = (stdout: string): string[] =>
    stdout
        .split("\0")
        .filter((path) => path !== "")
        .map((path) => Buffer.from(path, "utf8").toString("utf8"));

// Parse `--name-status -z` output (from `git diff` or `git diff-tree`) into GitChanges. NUL-separated records
// are `STATUS\0path\0`, except renames/copies which span three fields (`R<score>\0old\0new\0`), a cursor walk,
// not a fixed stride. Keyed by the (new) path so a later record for the same path wins. EXCEPT that
// "conflicted" is sticky: `git diff` emits an unmerged path twice (`U` then `M`), and letting the second record
// win is what used to make a conflict render as an ordinary modification.
//
// Exported because land.ts classifies a delta by CHANGE rather than by path, and `status` + `from` is what says
// a change spans two of them (agents/land.ts DeltaChange). Reading the delta with `--name-only` instead is what
// made renames land half-applied: that output names a rename's destination and nothing else.
export const parseNameStatusZ = (stdout: string): GitChange[] => {
    const parts = stdout.split("\0");
    const changes = new Map<string, GitChange>();
    let cursor = 0;
    while (cursor + 1 < parts.length) {
        const status = parts[cursor] ?? "";
        const path = parts[cursor + 1] ?? "";
        if (status === "" || path === "") {
            break;
        }
        if (status.startsWith("R") || status.startsWith("C")) {
            const to = parts[cursor + 2] ?? "";
            cursor += 3;
            if (to === "") {
                break;
            }
            changes.set(to, status.startsWith("R") ? { path: to, status: "renamed", from: path } : { path: to, status: "added" });
            continue;
        }
        cursor += 2;
        if (changes.get(path)?.status === "conflicted") {
            continue;
        }
        changes.set(path, { path, status: STATUS_OF[status[0] ?? ""] ?? "modified" });
    }
    return [...changes.values()];
};

// Parse `--numstat -z` into a path → {additions, deletions} map, keyed by the (new) path so it merges onto the
// name-status list. NUL-separated: a normal record is `add\tdel\tpath\0`; a rename is `add\tdel\t\0old\0new\0`
// (the counts, an empty path, then the two names). Binary files report `-\t-`, left undefined here.
export const parseNumstatZ = (stdout: string): Map<string, { additions?: number; deletions?: number }> => {
    const parts = stdout.split("\0");
    const stats = new Map<string, { additions?: number; deletions?: number }>();
    let cursor = 0;
    while (cursor < parts.length) {
        const segment = parts[cursor];
        if (segment === undefined || segment === "") {
            cursor += 1;
            continue;
        }
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(segment);
        if (match === null) {
            cursor += 1;
            continue;
        }
        // Omit (not set to undefined) a binary file's counts, the schema's optional fields are exact.
        const stat: { additions?: number; deletions?: number } = {};
        if (match[1] !== "-") {
            stat.additions = Number(match[1]);
        }
        if (match[2] !== "-") {
            stat.deletions = Number(match[2]);
        }
        const rest = match[3] ?? "";
        if (rest === "") {
            // Rename: the old + new paths are the next two NUL fields; key on the new path.
            stats.set(parts[cursor + 2] ?? "", stat);
            cursor += 3;
        } else {
            stats.set(rest, stat);
            cursor += 1;
        }
    }
    return stats;
};

/* THE ONE READ THE WHOLE REVIEW IS BUILT FROM, `git status --porcelain=v2 -z --branch`, parsed into the three
 * lists the panel renders plus the two header facts (the checked-out branch, and HEAD's sha).
 *
 * v2 is what lets ONE spawn answer what five used to (the branch, HEAD, both `--name-status` passes and the
 * untracked walk): every record carries BOTH staging columns, so `XY` splits into an index-vs-HEAD change and a
 * worktree-vs-index change independently. That is not the collapse changedFiles' note warns about, collapsing
 * is picking ONE status per path, which loses the `MM` case; reading two columns as two changes is what the two
 * diffs did, said once. Line counts still come from the real per-side diffs, so a row's stat still describes the
 * diff it is displayed under.
 *
 * Records are NUL-terminated: `1` an ordinary change, `2` a rename/copy (whose ORIGIN PATH is the next NUL field,
 * not part of the record), `u` an unmerged path, `?` untracked, `!` ignored. Their leading fields are fixed in
 * COUNT but not in width, and a path may contain spaces, so the path is taken as the whole remainder after
 * skipping that many spaces, never by splitting the record. */
const LEADING_FIELDS: Record<string, number> = { "1": 8, "2": 9, u: 10 };

const recordPath = (record: string, fields: number): string => {
    let cursor = 0;
    for (let field = 0; field < fields; field += 1) {
        const next = record.indexOf(" ", cursor);
        if (next === -1) {
            return "";
        }
        cursor = next + 1;
    }
    return record.slice(cursor);
};

// One side's letter, in the vocabulary parseNameStatusZ already established: `R` carries its origin, `C` (a copy)
// reads as a plain addition, and anything unrecognised degrades to "modified" rather than dropping the row.
const changeAt = (letter: string, path: string, from: string | undefined): GitChange =>
    letter === "R" && from !== undefined
        ? { path, status: "renamed", from }
        : { path, status: letter === "C" ? "added" : (STATUS_OF[letter] ?? "modified") };

export interface StatusV2 {
    branch?: string;
    head?: string;
    conflicted: GitChange[];
    staged: GitChange[];
    unstaged: GitChange[];
    untracked: string[];
    /* THE OBJECT NAMES THE STATUS RECORD ALREADY CARRIES, per path: HEAD's blob and the index's. Read out
     * because they are free here and expensive anywhere else, and because they are what the code-only counts are
     * cached on (code-counts.ts): the same object name means the same bytes, so a scan whose files have not
     * moved re-reads none of them. A rename keys on the NEW path, like every other reading in this file. */
    blobs: Map<string, { head?: string; index?: string }>;
}

// One space-separated field of a porcelain-v2 record, by position. The path is never read this way (it may hold
// spaces, see recordPath); the fixed-width leading fields are.
const recordField = (record: string, index: number): string | undefined => {
    let cursor = 0;
    for (let field = 0; field < index; field += 1) {
        const next = record.indexOf(" ", cursor);
        if (next === -1) {
            return undefined;
        }
        cursor = next + 1;
    }
    const end = record.indexOf(" ", cursor);
    return end === -1 ? undefined : record.slice(cursor, end);
};

// `1`/`2` records are `<kind> <XY> <sub> <mH> <mI> <mW> <hH> <hI> …`, so the two object names sit at 6 and 7
// whichever of the two kinds this is. All-zero means "no blob on that side" (an addition has no HEAD blob).
const ZERO_OID = /^0+$/;
const blobsOf = (record: string): { head?: string; index?: string } => {
    const head = recordField(record, 6);
    const index = recordField(record, 7);
    return {
        ...(head !== undefined && !ZERO_OID.test(head) ? { head } : {}),
        ...(index !== undefined && !ZERO_OID.test(index) ? { index } : {}),
    };
};

const parseStatusV2 = (stdout: string): StatusV2 => {
    const records = stdout.split("\0");
    const conflicted: GitChange[] = [];
    const staged: GitChange[] = [];
    const unstaged: GitChange[] = [];
    const untracked: string[] = [];
    const blobs = new Map<string, { head?: string; index?: string }>();
    let branch: string | undefined;
    let head: string | undefined;
    let cursor = 0;
    while (cursor < records.length) {
        const record = records[cursor] ?? "";
        cursor += 1;
        const kind = record[0] ?? "";
        if (kind === "#") {
            const [, key, value] = record.split(" ");
            // `(initial)` on an unborn HEAD and `(detached)` off a branch both mean "no answer", the same thing
            // the empty output of the two commands this replaces meant.
            if (key === "branch.oid" && value !== undefined && value !== "(initial)") {
                head = value;
            }
            if (key === "branch.head" && value !== undefined && value !== "(detached)") {
                branch = value;
            }
            continue;
        }
        if (kind === "?") {
            const path = record.slice(2);
            if (path !== "") {
                untracked.push(path);
            }
            continue;
        }
        const fields = LEADING_FIELDS[kind];
        if (fields === undefined) {
            // `!` (ignored, never requested here) and the empty trailing record after the final NUL.
            continue;
        }
        const path = recordPath(record, fields);
        // A rename's origin is its own NUL field, so it must be consumed whether or not the record parsed,
        // leaving it would be read as the next record.
        const from = kind === "2" ? (records[cursor] ?? "") : undefined;
        if (kind === "2") {
            cursor += 1;
        }
        if (path === "") {
            continue;
        }
        if (kind === "u") {
            // An unmerged path has no stage 0, so it is neither side's, see changedFiles' note. v2 gives it its
            // own record kind, so it never has to be filtered back out of the two lists.
            conflicted.push({ path, status: "conflicted" });
            continue;
        }
        blobs.set(path, blobsOf(record));
        const index = record[2] ?? ".";
        const worktree = record[3] ?? ".";
        if (index !== ".") {
            staged.push(changeAt(index, path, from));
        }
        if (worktree !== ".") {
            unstaged.push(changeAt(worktree, path, from));
        }
    }
    return { ...(branch !== undefined ? { branch } : {}), ...(head !== undefined ? { head } : {}), conflicted, staged, unstaged, untracked, blobs };
};

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
 * cap and the NUL test for binary are the ones worktreeSide already applies to the diff BODY, so a row's badge
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

// One side of a file diff: its text, its size, or nothing at all. An absent side is the empty object, that is
// how an added or deleted file reports the leg it doesn't have; `bytes` without `text` is a side too big to
// ship, which the patch below stands in for. `abs` marks the side that is a FILE ON DISK rather than a git
// object, the one thing git may not be able to diff at all (see the untracked case in composeDiff).
interface DiffSide {
    readonly text?: string;
    readonly binary?: boolean;
    readonly bytes?: number;
    readonly abs?: string;
}

// Present but too big to send whole, the condition that turns a diff into a patch.
const oversize = (side: DiffSide): boolean => side.text === undefined && side.binary !== true && side.bytes !== undefined;

// A blob at a git rev-spec, `HEAD:path` for the commit, `:0:path` for the index (stage 0, the unambiguous
// spelling; a conflicted path has no stage 0 and reads as absent). Same size/NUL guards as the history diff.
const blobSide = async (dir: string, spec: string, git: GitRunner): Promise<DiffSide> => {
    try {
        const bytes = Number((await git(dir, ["cat-file", "-s", spec])).stdout.trim());
        if (bytes > MAX_FILE_DIFF_BYTES) {
            return { bytes };
        }
        const content = (await git(dir, ["cat-file", "-p", spec])).stdout;
        return content.includes("\0") ? { binary: true, bytes } : { text: content, bytes };
    } catch {
        // Absent at that spec (an added file, an unborn ref, a path not in the index), no side.
    }
    return {};
};

// The file as it sits on disk. The route has already validated that `path` stays inside `dir` (resolveWithin).
const worktreeSide = async (abs: string): Promise<DiffSide> => {
    const bytes = await statWorkspaceFileSize(abs);
    if (bytes === undefined) {
        return {};
    }
    if (bytes > MAX_FILE_DIFF_BYTES) {
        return { bytes, abs };
    }
    const content = await readWorkspaceFile(abs);
    if (content === undefined) {
        return {};
    }
    return content.includes("\0") ? { binary: true, bytes, abs } : { text: content, bytes, abs };
};

/* Either side being binary makes the whole diff so, there is no half-renderable diff; either side being
 * OVERSIZED turns the whole thing into a patch, for the reasons diff-partial.ts gives.
 *
 * The two sides are read CONCURRENTLY, and taking promises rather than values is what holds that: written as
 * `composeDiff(dir, await left, await right, …)` JavaScript evaluates the arguments in order, so every file
 * diff in the product read its before side to completion before it started on its after side. Nothing needs
 * that order, the sides are independent, and a git read costs the daemon a whole event-loop turn each, so the
 * serial spelling doubled the wait on exactly the surface a user is sitting in front of waiting for it.
 *
 * Inside a side the size check still gates the content read (blobSide), which is a real dependency: `-s` is
 * what stops a 16 MB blob being read into memory to be discarded.
 *
 * `patchTail` is a THUNK over the settled sides rather than an array, because which comparison to ask git for
 * can depend on what the sides turned out to be: a commit whose file has no before side may have no parent to
 * name either (commitFileDiff). It is only ever called on the oversized path, so the four sources that always
 * know their pairing pay nothing for the shape. */
const composeDiff = async (
    dir: string,
    beforeSide: Promise<DiffSide>,
    afterSide: Promise<DiffSide>,
    patchTail: (before: DiffSide, after: DiffSide) => readonly string[],
    git: GitRunner,
): Promise<FileDiff> => {
    const [before, after] = await Promise.all([beforeSide, afterSide]);
    if (oversize(before) || oversize(after)) {
        /* No before side and a file on disk after it: the path exists nowhere in git, which is what an
         * UNTRACKED file is, and `git diff` compares the index against the tree so it can see nothing here at
         * all. Nothing needs diffing either, the file IS the change, so a bounded head of it is written out as
         * the additions it is (additionPatch) rather than asked for and got back empty. */
        const head = before.bytes === undefined && after.abs !== undefined ? await readWorkspaceFileWindow(after.abs, 0, MAX_PATCH_BYTES) : undefined;
        if (head !== undefined) {
            // The NUL test the sides themselves get, applied to the head, because an oversized file is sized
            // and never read: without it a dropped archive with an extension nothing recognises would be
            // decoded as utf8 and shipped as a page of replacement characters "added" to the workspace. This
            // is the only read of those bytes there will be, so it is the only chance to ask.
            if (head.content.includes("\0")) {
                return { binary: true, partial: { afterBytes: after.bytes } };
            }
            const { patch, more } = additionPatch(head.content, head.offset + head.bytes >= head.size);
            return { partial: { afterBytes: after.bytes, patch, ...(more ? { more: true } : {}) } };
        }
        const { binary, partial } = await partialDiff(async (args) => (await git(dir, args)).stdout, patchTail(before, after), {
            before: before.bytes,
            after: after.bytes,
        });
        return { ...(binary || before.binary === true || after.binary === true ? { binary: true } : {}), partial };
    }
    return {
        ...(before.text !== undefined ? { before: before.text } : {}),
        ...(after.text !== undefined ? { after: after.text } : {}),
        ...(before.binary === true || after.binary === true ? { binary: true } : {}),
    };
};

// The `ref` blob (a conversation's base sha for the agents review) vs the working tree, the cumulative diff,
// which is the only one a worktree the user never checks out can offer.
export const workingFileDiff = (dir: string, path: string, ref: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `${ref}:${path}`, git), worktreeSide(join(dir, path)), () => [ref, "--", path], git);

// Two blobs, no disk, workingFileDiff's counterpart for an ARCHIVED agent, whose checkout is gone and whose
// after-side therefore lives on the agent/<id> branch. Same pairing as changesBetweenRefs, so a row and the
// diff it opens always describe the same comparison.
export const refFileDiff = (dir: string, path: string, base: string, tip: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `${base}:${path}`, git), blobSide(dir, `${tip}:${path}`, git), () => [base, tip, "--", path], git);

// Index vs HEAD, exactly the diff a Staged row is listed under, and exactly what a bare `git commit` would
// record. NOT HEAD↔worktree: for a partially staged file those are different diffs, which is the whole reason
// the panel lists the two sides separately.
export const stagedFileDiff = (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `HEAD:${path}`, git), blobSide(dir, `:0:${path}`, git), () => ["--cached", "--", path], git);

// Worktree vs index, the diff an unstaged row is listed under. An untracked file has no index entry, so it
// reports no before side and renders as the addition it is.
export const unstagedFileDiff = (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `:0:${path}`, git), worktreeSide(join(dir, path)), () => ["--", path], git);

// An unmerged path, HEAD vs the worktree, which is to say: what you had, against what the merge left you,
// conflict markers and all. `:0:` is deliberately NOT used: there is no stage 0 for an unmerged path (the index
// holds "ours" and "theirs" at stages 2 and 3 instead), so asking for it returns nothing and the row renders a
// blank diff. HEAD is the honest before side, it is the state resolving the conflict is moving away from.
export const conflictedFileDiff = (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `HEAD:${path}`, git), worktreeSide(join(dir, path)), () => ["HEAD", "--", path], git);

// The commit context-menu actions (VSCode "Git Graph" parity). GitActionResult ok/conflict is the shape the
// sequence + HEAD-moving ops return; the non-destructive ref ops (branch/tag/checkout/reset) let git's own
// errors propagate and are wrapped to Ok by the route.
export type ActionResult = { ok: true } | { ok: false; reason: string };
type Author = { readonly name: string; readonly email: string };

// Committer identity for the commits a sequence op creates/replays (git preserves original authorship). One
// source, matching every route commit.
const identity = (author: Author): string[] => ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];

// A sequence op that may conflict (or be blocked by a dirty tree): run it, and on ANY failure abort cleanly so
// the worktree is never left mid-operation. `abort` is the op's own `--abort` (a harmless no-op when nothing
// actually started).
const runOrAbort = async (dir: string, args: readonly string[], abort: readonly string[], git: GitRunner): Promise<ActionResult> => {
    try {
        await git(dir, args);
        return { ok: true };
    } catch {
        await git(dir, abort).catch(() => undefined);
        return { ok: false, reason: "conflict" };
    }
};

// Create a branch at a commit (`git branch <name> <sha>`). Non-destructive: a new ref, HEAD and the worktree
// untouched, so it needs no safety checkpoint. Git rejects a duplicate name (that error propagates).
export const createBranchAt = async (dir: string, name: string, sha: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["branch", name, sha]);
};

/* Delete a tag locally, and optionally on the remote it was pushed to.
 *
 * The remote deletion is a SEPARATE call rather than part of the local one, and is best-effort: a tag that was
 * never pushed makes `git push --delete` fail, which must not make deleting the local tag look like it failed.
 * The local side is the one the caller asked for; the remote side is a courtesy that either works or does not.
 */
export const deleteTag = async (dir: string, name: string, remote: string | undefined, git: GitRunner = defaultGit): Promise<void> => {
    if (remote !== undefined) {
        await git(dir, ["push", remote, "--delete", `refs/tags/${name}`]).catch(() => undefined);
    }
    await git(dir, ["tag", "-d", name]);
};

// Publish one tag. Named explicitly rather than `--tags`, so pushing a tag never drags every other unpushed tag
// in the repo along with it, which is what makes this safe to offer as a one-click action on a pill.
export const pushTag = async (dir: string, name: string, remote: string, git: GitRunner = defaultGit): Promise<ActionResult> => {
    try {
        await git(dir, ["push", remote, `refs/tags/${name}`]);
        return { ok: true };
    } catch {
        return { ok: false, reason: "push failed" };
    }
};

// Tag a commit (`git tag <name> <sha>`). Non-destructive, like a branch; a duplicate name is git's error.
export const createTagAt = async (dir: string, name: string, sha: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["tag", name, sha]);
};

// Check out a ref/commit (a bare sha detaches HEAD). Git refuses on a dirty tree, that error propagates so the
// caller surfaces it; nothing is half-applied.
export const checkoutRef = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["checkout", ref]);
};

// Reset the current branch to a commit. --hard discards the worktree (the route checkpoints first); --soft /
// --mixed keep it. Atomic, no abort needed.
export const resetTo = async (dir: string, sha: string, mode: "soft" | "mixed" | "hard", git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["reset", `--${mode}`, sha]);
};

// Revert a commit (`git revert`): a NEW inverse commit, history grows, nothing rewritten.
export const revertCommit = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "revert", "--no-edit", sha], ["revert", "--abort"], git);

// Cherry-pick a commit onto the current branch (a new copy of its change).
export const cherryPick = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "cherry-pick", sha], ["cherry-pick", "--abort"], git);

// Merge a commit into the current branch.
export const mergeCommit = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "merge", "--no-edit", sha], ["merge", "--abort"], git);

// Rebase the current branch onto a commit (replays HEAD's commits on top of it, rewrites history).
export const rebaseOnto = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "rebase", sha], ["rebase", "--abort"], git);

/* Rebase only what the branch has taken SINCE `since` onto `sha` (`rebase --onto <sha> <since>`): everything at
 * or before `since` is DROPPED from the branch rather than replayed. `since` must be an ancestor of HEAD, and it
 * degenerates to a plain move when it IS HEAD, the branch is reset onto `sha` and nothing is replayed at all.
 *
 * No branch argument, deliberately. Naming one makes git check it out first, and `HEAD` names a commit rather
 * than a branch, so passing it detaches the head and the rewrite lands on nothing. Omitted, the rebase moves
 * the branch that is checked out, which is the only branch any caller here means. */
export const rebaseSince = async (dir: string, sha: string, since: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "rebase", "--onto", sha, since], ["rebase", "--abort"], git);

/* Drop a commit: replay everything after it onto its parent (`rebase --onto <sha>^ <sha>`), removing it. The
 * same shape as rebaseSince, and with the same reason for naming no branch: `HEAD` there is a commit, not a
 * branch, so git checked it out and left the drop on a DETACHED head with the branch ref still on the old
 * history. The panel then showed the commit gone, and it came back the moment anything looked at the branch. */
export const dropCommit = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "rebase", "--onto", `${sha}^`, sha], ["rebase", "--abort"], git);

/* The graph/log view: commits ACROSS ALL REFS (--all, so branch topology is visible), newest first, one page at
 * a time. Fields are delimited with US (\x1f) and records with RS (\x1e) so subjects and multi-line bodies
 * survive intact (a plain -z / newline split can't). `%D` carries the ref decorations; the bare "HEAD" marker is
 * lifted into `head` so `refs` holds only branch/tag names. Author time (%at, seconds) → ms.
 *
 * PAGED, and it asks for one commit MORE than the page it will return. That extra row is never sent, it exists
 * only so the answer can say `hasMore` truthfully. Without it the caller cannot distinguish "this repo has
 * exactly `limit` commits" from "there are thousands and you are seeing the newest few", and the graph read the
 * second case as the first: the oldest commits in the window have parents outside it, so the layout ended their
 * lanes and drew them as ROOT commits. A history that silently claims to begin where the page happens to stop.
 */
const RS = "\x1e";
const US = "\x1f";
export const commitLog = async (
    dir: string,
    limit: number,
    skip = 0,
    git: GitRunner = defaultGit,
): Promise<{ branch?: string; commits: GitCommit[]; hasMore: boolean }> => {
    const format = `${RS}%H${US}%h${US}%P${US}%an${US}%ae${US}%at${US}%D${US}%s${US}%b`;
    // Branch and log are independent read-only spawns, run them concurrently. A repo with no commits yet (an
    // unborn HEAD across every ref) makes `git log` exit non-zero, that's an empty graph, not an error, so
    // degrade to no commits (the panel renders its "no commits yet" state).
    // --decorate forces %D to populate: git only loads ref decorations for a TTY by default, and the daemon
    // runs git piped (non-TTY), so without it the HEAD marker and branch/tag names would silently vanish.
    const [branchOut, logOut] = await Promise.all([
        git(dir, ["branch", "--show-current"]),
        git(dir, ["log", "--all", "--decorate", "--topo-order", `--max-count=${limit + 1}`, `--skip=${skip}`, `--pretty=format:${format}`]).catch(
            () => undefined,
        ),
    ]);
    const branch = branchOut.stdout.trim();
    if (logOut === undefined) {
        return { ...(branch !== "" ? { branch } : {}), commits: [], hasMore: false };
    }
    const { stdout } = logOut;
    const commits: GitCommit[] = [];
    for (const record of stdout.split(RS)) {
        if (record === "") {
            continue;
        }
        const fields = record.split(US);
        if (fields.length < 9) {
            continue;
        }
        const [sha, short, parents, author, email, at, decor, subject] = fields;
        // %b (the body) is last; join any trailing US it might have contained back together.
        const body = fields.slice(8).join(US).trim();
        const decorations = (decor ?? "")
            .split(", ")
            .map((ref) => ref.trim())
            .filter((ref) => ref !== "");
        const head = decorations.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> "));
        const refs = decorations.map((ref) => (ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length) : ref)).filter((ref) => ref !== "HEAD");
        commits.push({
            sha: sha ?? "",
            short: short ?? "",
            parents: (parents ?? "").split(" ").filter((parent) => parent !== ""),
            subject: subject ?? "",
            body,
            author: author ?? "",
            email: email ?? "",
            at: Number(at ?? "0") * 1000,
            refs,
            head,
        });
    }
    // The probe row is dropped here rather than by the caller: it is an implementation detail of knowing whether
    // there is another page, and shipping it would make every page one commit longer than it claims to be.
    const hasMore = commits.length > limit;
    return { ...(branch !== "" ? { branch } : {}), commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
};

// The files one commit changed vs its first parent, `--root` renders a root commit's files as additions
// (vs the empty tree) instead of nothing. Merges name-status (status + renames) with numstat (per-file
// +/- line counts) by path, so the graph's detail tree can show both.
export const commitChanges = async (dir: string, sha: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    // Two independent read-only diff-tree spawns on the same commit, run them concurrently.
    const [statusOut, statsOut] = await Promise.all([
        git(dir, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", sha]),
        git(dir, ["diff-tree", "--no-commit-id", "--numstat", "-r", "-z", "--root", sha]),
    ]);
    const status = parseNameStatusZ(statusOut.stdout);
    const stats = parseNumstatZ(statsOut.stdout);
    // In place: `status` was just parsed here and nothing else holds it, so the merge needs no copy. Assigning
    // `undefined` (a path numstat had nothing for, a binary file, a pure rename) is a no-op.
    return status.map((change) => Object.assign(change, stats.get(change.path)));
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

/* Both sides of a file AT a commit: the blob at the first parent (`<sha>^`) vs the blob at `<sha>`. A root
 * commit (no parent) or a freshly-added file has no before; a deletion has no after. The route has validated
 * `path` stays inside `dir` (resolveWithin).
 *
 * The one source whose PATCH pairing is not fixed. `<sha>^` is a rev-spec that does not resolve at a root
 * commit, so an oversized file in a repo's first commit would ask git to diff against nothing. No before side
 * means exactly that case, or an added file, and the empty tree is the pairing both of them want: the whole
 * file as additions, which is what the reader gets a clipped head of. */
export const commitFileDiff = (dir: string, sha: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(
        dir,
        blobSide(dir, `${sha}^:${path}`, git),
        blobSide(dir, `${sha}:${path}`, git),
        (before) => [before.bytes === undefined ? EMPTY_TREE : `${sha}^`, sha, "--", path],
        git,
    );
