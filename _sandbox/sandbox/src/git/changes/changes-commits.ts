import type { GitChange, GitCommit } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { parseNameStatusZ, parseNumstatZ } from "./changes-porcelain.js";
import { identity } from "../git.js";

/* THE COMMIT GRAPH: the paged log the history view draws, one commit's file delta, and the context-menu actions
 * on a commit. Unlike the working-tree verbs (changes.ts, changes-index.ts) most of these MOVE HEAD or rewrite
 * history, and the sequence ops among them abort themselves on a conflict so the worktree is never left
 * mid-operation. Same injectable GitRunner as the rest of the review. */

// The commit context-menu actions (VSCode "Git Graph" parity). GitActionResult ok/conflict is the shape the
// sequence + HEAD-moving ops return; the non-destructive ref ops (branch/tag/checkout/reset) let git's own
// errors propagate and are wrapped to Ok by the route.
export type ActionResult = { ok: true } | { ok: false; reason: string };
type Author = { readonly name: string; readonly email: string };

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
