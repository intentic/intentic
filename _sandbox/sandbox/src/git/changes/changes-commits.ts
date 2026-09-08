import type { GitChange, GitCommit } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { parseNameStatusZ, parseNumstatZ } from "./changes-porcelain.js";
import { identity } from "../git.js";

// Commit graph: the paged log, one commit's file delta, and context-menu actions on a commit.
// Unlike the working-tree verbs (changes.ts, changes-index.ts), most of these move HEAD or rewrite history.
// Same injectable GitRunner as the rest of the review.

// Commit context-menu actions (VSCode "Git Graph" parity); ok/conflict is what sequence and HEAD-moving ops return.
// Non-destructive ref ops (branch/tag/checkout/reset) let git's own errors propagate, wrapped to Ok by the route.
export type ActionResult = { ok: true } | { ok: false; reason: string };
type Author = { readonly name: string; readonly email: string };

// Runs a sequence op that may conflict; on any failure, aborts cleanly so the worktree is never left mid-operation.
// `abort` is the op's own `--abort`, a no-op when nothing actually started.
const runOrAbort = async (dir: string, args: readonly string[], abort: readonly string[], git: GitRunner): Promise<ActionResult> => {
    try {
        await git(dir, args);
        return { ok: true };
    } catch {
        await git(dir, abort).catch(() => undefined);
        return { ok: false, reason: "conflict" };
    }
};

// Creates a branch at a commit; non-destructive (HEAD and the worktree untouched), so no safety checkpoint is needed.
export const createBranchAt = async (dir: string, name: string, sha: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["branch", name, sha]);
};

// Deletes a tag locally, and optionally on the remote it was pushed to.
// Remote deletion is separate and best-effort: an unpushed tag makes `git push --delete` fail, not the local delete.
export const deleteTag = async (dir: string, name: string, remote: string | undefined, git: GitRunner = defaultGit): Promise<void> => {
    if (remote !== undefined) {
        await git(dir, ["push", remote, "--delete", `refs/tags/${name}`]).catch(() => undefined);
    }
    await git(dir, ["tag", "-d", name]);
};

// Pushes one tag by name, not `--tags`, so it never drags every other unpushed tag along; safe as a one-click action.
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

// Checks out a ref/commit (a bare sha detaches HEAD); git's dirty-tree refusal propagates, so nothing is half-applied.
export const checkoutRef = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["checkout", ref]);
};

// Resets the branch to a commit; --hard discards the worktree (the route checkpoints first), --soft/--mixed keep it.
export const resetTo = async (dir: string, sha: string, mode: "soft" | "mixed" | "hard", git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["reset", `--${mode}`, sha]);
};

// Reverts a commit (`git revert`): a new inverse commit, history grows, nothing is rewritten.
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

// Rebases only what's been added since `since` onto `sha`; everything at or before `since` is dropped, not replayed.
// No branch argument: naming one would check it out, and `HEAD` names a commit, not a branch, detaching it instead.
export const rebaseSince = async (dir: string, sha: string, since: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "rebase", "--onto", sha, since], ["rebase", "--abort"], git);

// Drops a commit: replays everything after it onto its parent (`rebase --onto <sha>^ <sha>`).
// Same no-branch-argument reasoning as rebaseSince: naming `HEAD` there is a commit, not a branch, and detaches it.
export const dropCommit = async (dir: string, sha: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> =>
    runOrAbort(dir, [...identity(author), "rebase", "--onto", `${sha}^`, sha], ["rebase", "--abort"], git);

// Paged commit log across all refs (--all), newest first; US/RS-delimited fields so multi-line bodies survive intact.
// Asks for one more commit than the page returns and drops it, so `hasMore` is answered truthfully, not guessed.
const RS = "\x1e";
const US = "\x1f";
export const commitLog = async (
    dir: string,
    limit: number,
    skip = 0,
    git: GitRunner = defaultGit,
): Promise<{ branch?: string; commits: GitCommit[]; hasMore: boolean }> => {
    const format = `${RS}%H${US}%h${US}%P${US}%an${US}%ae${US}%at${US}%D${US}%s${US}%b`;
    // Branch and log run concurrently; an unborn HEAD makes `git log` exit non-zero, an empty graph, not an error.
    // --decorate is required: git only loads ref decorations for a TTY, and the daemon runs git piped (non-TTY).
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
    // Probe row is dropped here, not by the caller: shipping it would make every page one commit too long.
    const hasMore = commits.length > limit;
    return { ...(branch !== "" ? { branch } : {}), commits: hasMore ? commits.slice(0, limit) : commits, hasMore };
};

// Files one commit changed vs its first parent; `--root` renders a root commit's files as additions instead of nothing.
// Merges name-status (status, renames) with numstat (+/- line counts) by path.
export const commitChanges = async (dir: string, sha: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    // Two independent read-only diff-tree spawns on the same commit, run them concurrently.
    const [statusOut, statsOut] = await Promise.all([
        git(dir, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", sha]),
        git(dir, ["diff-tree", "--no-commit-id", "--numstat", "-r", "-z", "--root", sha]),
    ]);
    const status = parseNameStatusZ(statusOut.stdout);
    const stats = parseNumstatZ(statsOut.stdout);
    // In place: nothing else holds `status`, so the merge needs no copy; assigning `undefined` is a no-op.
    return status.map((change) => Object.assign(change, stats.get(change.path)));
};
