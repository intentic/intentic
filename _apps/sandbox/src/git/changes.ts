import { join } from "node:path";
import type { FileDiff, GitChange, GitCommit } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE, MAX_FILE_DIFF_BYTES } from "../history/history.js";
import { readWorkspaceFile, statWorkspaceFileSize } from "../workspace/workspace-files.js";

// Working-tree review over a real repo: uncommitted changes (status vs HEAD), per-path commit, per-path
// discard, and a HEAD↔worktree file diff. Everything runs against the repo's real git dir — unlike the shadow
// history, these are the user's own branches, so commit here IS the review's "approve". All functions take the
// injectable GitRunner (defaultGit shells out) so command sequences are unit-testable without a real repo.

// `U` is git's unmerged marker — a path the merge could not resolve, which is neither staged nor unstaged but
// its own third state (there is no stage 0 for it at all; the index holds stages 1/2/3 instead).
const STATUS_OF: Record<string, GitChange["status"]> = { A: "added", M: "modified", D: "deleted", T: "type-changed", U: "conflicted" };

// Parse `--name-status -z` output (from `git diff` or `git diff-tree`) into GitChanges. NUL-separated records
// are `STATUS\0path\0`, except renames/copies which span three fields (`R<score>\0old\0new\0`) — a cursor walk,
// not a fixed stride. Keyed by the (new) path so a later record for the same path wins — EXCEPT that
// "conflicted" is sticky: `git diff` emits an unmerged path twice (`U` then `M`), and letting the second record
// win is what used to make a conflict render as an ordinary modification.
const parseNameStatusZ = (stdout: string): GitChange[] => {
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
const parseNumstatZ = (stdout: string): Map<string, { additions?: number; deletions?: number }> => {
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
        // Omit (not set to undefined) a binary file's counts — the schema's optional fields are exact.
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

// HEAD's sha; undefined on an unborn HEAD (a repo initialized but never committed) — everything is "added"
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
// on, so a rename's counts key on the new path — the shape parseNumstatZ handles). `scope` is the diff's own
// arguments, so the counts always come from the SAME comparison the name-status list did: index-vs-HEAD for the
// staged side, worktree-vs-index for the unstaged side. A change with no numstat entry (an untracked file with
// no blob on either side, or a binary file) keeps undefined counts, which the UI omits.
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

// One repo's uncommitted work, split the way git actually models it — and the way VSCode's SCM view renders it:
//
//   conflicted = unmerged paths        (`U` on either side) — a merge git could not finish
//   staged     = index vs HEAD         (`git diff --cached`) — what `git commit` would record right now
//   unstaged   = worktree vs index     (`git diff`) + untracked files
//
// The two clean sides are read as two real diffs rather than by collapsing `git status`'s two porcelain columns,
// because a path can legitimately appear on BOTH with DIFFERENT statuses (a staged rename whose new file was
// then edited, the classic `MM`). Collapsing them, as this used to, made a partially-staged file report one
// status and one pair of line counts that matched neither side. Each side gets its own name-status pass and its
// own numstat pass, so every count describes the diff it is displayed under.
//
// Conflicts come OUT of both sides and into their own list. They are not a third opinion about staging: an
// unmerged path has no stage 0 at all, so "what would a commit record" has no answer for it — git refuses to
// commit while one exists. Listing it as staged (which the `U` letter, read as a fallback "modified", used to
// do) claimed it was ready to commit and offered an index-vs-HEAD diff that cannot be computed.
//
// -z gives exact NUL-delimited paths; untracked come from `ls-files --others --exclude-standard -z`, which
// expands directories into real file paths (per-path actions need them). info/exclude + .gitignore keep the scan
// off the nested repo dirs, .intentic/ and junk in the root repo.
export const changedFiles = async (
    dir: string,
    git: GitRunner = defaultGit,
): Promise<{ branch?: string; conflicted: GitChange[]; staged: GitChange[]; unstaged: GitChange[] }> => {
    const [branchOut, head] = await Promise.all([git(dir, ["branch", "--show-current"]), headSha(dir, git)]);
    const branch = branchOut.stdout.trim();
    // On an unborn HEAD there is no commit to diff the index against — the empty tree stands in, so a repo
    // whose first commit is still being composed reports its staged files instead of nothing.
    const base = head ?? EMPTY_TREE;
    // Three independent read-only spawns — the two name-status passes and the untracked walk don't touch the
    // index, so they run concurrently.
    const [stagedOut, unstagedOut, untrackedOut] = await Promise.all([
        git(dir, ["diff", "--cached", "--name-status", "-z", "--find-renames", base]),
        git(dir, ["diff", "--name-status", "-z", "--find-renames"]),
        git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    // An unmerged path shows up as `U` on whichever pass sees it (usually both) — one entry per path, and it
    // wins over any clean status the same path also reported.
    const conflicted = new Map<string, GitChange>();
    const clean = (changes: readonly GitChange[]): GitChange[] =>
        changes.filter((change) => {
            if (change.status !== "conflicted") {
                return true;
            }
            conflicted.set(change.path, change);
            return false;
        });
    const stagedNames = clean(parseNameStatusZ(stagedOut.stdout));
    const unstagedNames = clean(parseNameStatusZ(unstagedOut.stdout));
    // Untracked files are unstaged by definition (nothing about them is in the index yet). Guarded against a
    // path either tracked list already reported, which can't normally happen but would double a row if it did.
    const seen = new Set([...unstagedNames.map((change) => change.path), ...conflicted.keys()]);
    for (const path of untrackedOut.stdout.split("\0")) {
        if (path !== "" && !seen.has(path)) {
            unstagedNames.push({ path, status: "added" });
        }
    }
    // No numstat for a conflict: "how many lines changed" has no answer across three stages, and the row shows
    // no diffstat rather than an invented one.
    const [staged, unstaged] = await Promise.all([
        withLineStats(dir, ["--cached", base], stagedNames, git),
        withLineStats(dir, [], unstagedNames, git),
    ]);
    return { ...(branch !== "" ? { branch } : {}), conflicted: [...conflicted.values()], staged, unstaged };
};

// A repo's cumulative delta vs a fixed base sha — committed work since the base PLUS staged and unstaged
// edits (one diff covers all three) — merged with untracked files. The agents review reads a conversation
// worktree with this: `base` is the sha the worktree branched from, so the result is exactly what landing
// would bring to the main tree, in the same GitChange shape the Changes panel renders.
export const changesAgainstBase = async (dir: string, base: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    const { stdout } = await git(dir, ["diff", "--name-status", "-z", base]);
    const changes = new Map(parseNameStatusZ(stdout).map((change) => [change.path, change]));
    const untracked = (await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0");
    for (const path of untracked) {
        if (path !== "" && !changes.has(path)) {
            changes.set(path, { path, status: "added" });
        }
    }
    // Same numstat pass as the working-tree review, keyed to the worktree's base — untracked files (added above)
    // carry no counts, matching the Changes panel.
    return withLineStats(dir, [base], [...changes.values()], git);
};

// Stage exactly `paths` — adds, edits AND deletions (`-A` covers a removed file, which a bare `add` skips).
export const stagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    if (paths.length === 0) {
        return;
    }
    await git(dir, ["add", "-A", "--", ...paths]);
};

// Unstage exactly `paths`, leaving the worktree untouched. On an unborn HEAD there is nothing to reset TO, so
// the index entry is dropped instead (`rm --cached`) — the file returns to untracked rather than erroring.
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

// Commit whatever is currently staged, touching neither the worktree nor any unstaged change — plain `git
// commit`. This is the ONLY way the panel records a commit (commitAll stages everything first, then lands
// here in spirit): the index is git's own answer to "what goes in", so nothing else needs to name paths.
// False ⇒ the index is clean, so there was nothing to do.
//
// Being a whole-index commit is also what makes it work mid-merge. The `commit --only` this replaces could
// not: git refuses a partial commit while MERGE_HEAD exists, and it refused only AFTER the paths had been
// staged — a commit that never happened, leaving the index moved.
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
        // The index differs from HEAD — fall through to commit.
    }
    await git(dir, [...identity(author), "commit", "-q", "-m", message]);
    return true;
};

// Discard uncommitted work: everything (no paths) or exactly `paths`. Tracked content returns to HEAD;
// untracked files are deleted. Ignored files (secrets, node_modules, nested repo dirs) always survive —
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
    // A staged rename spans two paths — discarding either leg must undo both. Renames only ever appear on the
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

// One side of a file diff: its text, or the flag that stands in for text we won't ship (oversized, binary).
// An absent side is the empty object — that is how an added or deleted file reports the leg it doesn't have.
interface DiffSide {
    readonly text?: string;
    readonly binary?: boolean;
    readonly truncated?: boolean;
}

// A blob at a git rev-spec — `HEAD:path` for the commit, `:0:path` for the index (stage 0, the unambiguous
// spelling; a conflicted path has no stage 0 and reads as absent). Same size/NUL guards as the history diff.
const blobSide = async (dir: string, spec: string, git: GitRunner): Promise<DiffSide> => {
    try {
        const size = Number((await git(dir, ["cat-file", "-s", spec])).stdout.trim());
        if (size > MAX_FILE_DIFF_BYTES) {
            return { truncated: true };
        }
        const content = (await git(dir, ["cat-file", "-p", spec])).stdout;
        return content.includes("\0") ? { binary: true } : { text: content };
    } catch {
        // Absent at that spec (an added file, an unborn ref, a path not in the index) — no side.
    }
    return {};
};

// The file as it sits on disk. The route has already validated that `path` stays inside `dir` (resolveWithin).
const worktreeSide = async (abs: string): Promise<DiffSide> => {
    const size = await statWorkspaceFileSize(abs);
    if (size === undefined) {
        return {};
    }
    if (size > MAX_FILE_DIFF_BYTES) {
        return { truncated: true };
    }
    const content = await readWorkspaceFile(abs);
    if (content === undefined) {
        return {};
    }
    return content.includes("\0") ? { binary: true } : { text: content };
};

// Either side being binary or truncated makes the whole diff so — there is no half-renderable diff.
const bothSides = (before: DiffSide, after: DiffSide): FileDiff => ({
    ...(before.text !== undefined ? { before: before.text } : {}),
    ...(after.text !== undefined ? { after: after.text } : {}),
    ...(before.binary === true || after.binary === true ? { binary: true } : {}),
    ...(before.truncated === true || after.truncated === true ? { truncated: true } : {}),
});

// The `ref` blob (a conversation's base sha for the agents review) vs the working tree — the cumulative diff,
// which is the only one a worktree the user never checks out can offer.
export const workingFileDiff = async (dir: string, path: string, ref: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    bothSides(await blobSide(dir, `${ref}:${path}`, git), await worktreeSide(join(dir, path)));

// Index vs HEAD — exactly the diff a Staged row is listed under, and exactly what a bare `git commit` would
// record. NOT HEAD↔worktree: for a partially staged file those are different diffs, which is the whole reason
// the panel lists the two sides separately.
export const stagedFileDiff = async (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    bothSides(await blobSide(dir, `HEAD:${path}`, git), await blobSide(dir, `:0:${path}`, git));

// Worktree vs index — the diff an unstaged row is listed under. An untracked file has no index entry, so it
// reports no before side and renders as the addition it is.
export const unstagedFileDiff = async (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    bothSides(await blobSide(dir, `:0:${path}`, git), await worktreeSide(join(dir, path)));

// An unmerged path, HEAD vs the worktree — which is to say: what you had, against what the merge left you,
// conflict markers and all. `:0:` is deliberately NOT used: there is no stage 0 for an unmerged path (the index
// holds "ours" and "theirs" at stages 2 and 3 instead), so asking for it returns nothing and the row renders a
// blank diff. HEAD is the honest before side — it is the state resolving the conflict is moving away from.
export const conflictedFileDiff = async (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    bothSides(await blobSide(dir, `HEAD:${path}`, git), await worktreeSide(join(dir, path)));

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
// untouched — so it needs no safety checkpoint. Git rejects a duplicate name (that error propagates).
export const createBranchAt = async (dir: string, name: string, sha: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["branch", name, sha]);
};

// Tag a commit (`git tag <name> <sha>`). Non-destructive, like a branch; a duplicate name is git's error.
export const createTagAt = async (dir: string, name: string, sha: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["tag", name, sha]);
};

// Check out a ref/commit (a bare sha detaches HEAD). Git refuses on a dirty tree — that error propagates so the
// caller surfaces it; nothing is half-applied.
export const checkoutRef = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["checkout", ref]);
};

// Reset the current branch to a commit. --hard discards the worktree (the route checkpoints first); --soft /
// --mixed keep it. Atomic — no abort needed.
export const resetTo = async (dir: string, sha: string, mode: "soft" | "mixed" | "hard", git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["reset", `--${mode}`, sha]);
};

// Revert a commit (`git revert`): a NEW inverse commit — history grows, nothing rewritten.
export const revertCommit = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "revert", "--no-edit", sha], ["revert", "--abort"], git);

// Cherry-pick a commit onto the current branch (a new copy of its change).
export const cherryPick = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "cherry-pick", sha], ["cherry-pick", "--abort"], git);

// Merge a commit into the current branch.
export const mergeCommit = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "merge", "--no-edit", sha], ["merge", "--abort"], git);

// Rebase the current branch onto a commit (replays HEAD's commits on top of it — rewrites history).
export const rebaseOnto = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "rebase", sha], ["rebase", "--abort"], git);

// Drop a commit: replay everything after it onto its parent (`rebase --onto <sha>^ <sha> HEAD`), removing it.
export const dropCommit = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "rebase", "--onto", `${sha}^`, sha, "HEAD"], ["rebase", "--abort"], git);

// The graph/log view: recent commits ACROSS ALL REFS (--all, so branch topology is visible), newest first,
// capped at `limit`. Fields are delimited with US (\x1f) and records with RS (\x1e) so subjects and multi-line
// bodies survive intact (a plain -z / newline split can't). `%D` carries the ref decorations; the bare "HEAD"
// marker is lifted into `head` so `refs` holds only branch/tag names. Author time (%at, seconds) → ms.
const RS = "\x1e";
const US = "\x1f";
export const commitLog = async (dir: string, limit: number, git: GitRunner = defaultGit): Promise<{ branch?: string; commits: GitCommit[] }> => {
    const format = `${RS}%H${US}%h${US}%P${US}%an${US}%ae${US}%at${US}%D${US}%s${US}%b`;
    // Branch and log are independent read-only spawns — run them concurrently. A repo with no commits yet (an
    // unborn HEAD across every ref) makes `git log` exit non-zero — that's an empty graph, not an error, so
    // degrade to no commits (the panel renders its "no commits yet" state).
    // --decorate forces %D to populate: git only loads ref decorations for a TTY by default, and the daemon
    // runs git piped (non-TTY), so without it the HEAD marker and branch/tag names would silently vanish.
    const [branchOut, logOut] = await Promise.all([
        git(dir, ["branch", "--show-current"]),
        git(dir, ["log", "--all", "--decorate", "--topo-order", `--max-count=${limit}`, `--pretty=format:${format}`]).catch(() => undefined),
    ]);
    const branch = branchOut.stdout.trim();
    if (logOut === undefined) {
        return { ...(branch !== "" ? { branch } : {}), commits: [] };
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
    return { ...(branch !== "" ? { branch } : {}), commits };
};

// The files one commit changed vs its first parent — `--root` renders a root commit's files as additions
// (vs the empty tree) instead of nothing. Merges name-status (status + renames) with numstat (per-file
// +/- line counts) by path, so the graph's detail tree can show both.
export const commitChanges = async (dir: string, sha: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    // Two independent read-only diff-tree spawns on the same commit — run them concurrently.
    const [statusOut, statsOut] = await Promise.all([
        git(dir, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", sha]),
        git(dir, ["diff-tree", "--no-commit-id", "--numstat", "-r", "-z", "--root", sha]),
    ]);
    const status = parseNameStatusZ(statusOut.stdout);
    const stats = parseNumstatZ(statsOut.stdout);
    return status.map((change) => ({ ...change, ...(stats.get(change.path) ?? {}) }));
};

// Both sides of a file AT a commit: the blob at the first parent (`<sha>^`) vs the blob at `<sha>`. A root
// commit (no parent) or a freshly-added file has no before; a deletion has no after. Same size/binary guards
// as workingFileDiff. The route has validated `path` stays inside `dir` (resolveWithin).
export const commitFileDiff = async (dir: string, sha: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> => {
    const side = async (ref: string): Promise<{ content?: string; binary: boolean; truncated: boolean }> => {
        try {
            const size = Number((await git(dir, ["cat-file", "-s", `${ref}:${path}`])).stdout.trim());
            if (size > MAX_FILE_DIFF_BYTES) {
                return { binary: false, truncated: true };
            }
            const content = (await git(dir, ["cat-file", "-p", `${ref}:${path}`])).stdout;
            return content.includes("\0") ? { binary: true, truncated: false } : { content, binary: false, truncated: false };
        } catch {
            return { binary: false, truncated: false }; // absent at this ref (added / deleted / root commit)
        }
    };
    // The two sides read different refs, entirely read-only — resolve them concurrently.
    const [before, after] = await Promise.all([side(`${sha}^`), side(sha)]);
    const binary = before.binary || after.binary;
    const truncated = before.truncated || after.truncated;
    return {
        ...(before.content !== undefined ? { before: before.content } : {}),
        ...(after.content !== undefined ? { after: after.content } : {}),
        ...(binary ? { binary: true } : {}),
        ...(truncated ? { truncated: true } : {}),
    };
};
