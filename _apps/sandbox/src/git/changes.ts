import { join } from "node:path";
import type { FileDiff, GitChange } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE, MAX_FILE_DIFF_BYTES } from "../history/history.js";
import { readWorkspaceFile, statWorkspaceFileSize } from "../workspace/workspace-files.js";

// Working-tree review over a real repo: uncommitted changes (status vs HEAD), per-path commit, per-path
// discard, and a HEAD↔worktree file diff. Everything runs against the repo's real git dir — unlike the shadow
// history, these are the user's own branches, so commit here IS the review's "approve". All functions take the
// injectable GitRunner (defaultGit shells out) so command sequences are unit-testable without a real repo.

const STATUS_OF: Record<string, GitChange["status"]> = { A: "added", M: "modified", D: "deleted", T: "type-changed" };

// HEAD's sha; undefined on an unborn HEAD (a repo initialized but never committed) — everything is "added"
// there and the index-reset verbs need a different spelling.
const headSha = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    try {
        return (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
    } catch {
        return undefined;
    }
};

// One repo's uncommitted work via `git status --porcelain=v1 -z -uall`: -z gives exact NUL-delimited paths
// (a rename is `R… new\0old`), -uall expands untracked dirs into real file paths (per-path actions need them).
// info/exclude + .gitignore keep the scan off repositories/, .intentic/ and junk in the root repo.
export const changedFiles = async (dir: string, git: GitRunner = defaultGit): Promise<{ branch?: string; changes: GitChange[] }> => {
    const branch = (await git(dir, ["branch", "--show-current"])).stdout.trim();
    const { stdout } = await git(dir, ["status", "--porcelain=v1", "-z", "-uall"]);
    const parts = stdout.split("\0");
    const changes: GitChange[] = [];
    for (let index = 0; index < parts.length; index += 1) {
        const entry = parts[index];
        if (entry === undefined || entry.length < 4) {
            continue;
        }
        const staged = entry[0] ?? " ";
        const worktree = entry[1] ?? " ";
        const path = entry.slice(3);
        // A staged rename/copy consumes a second NUL record: the original path.
        if (staged === "R" || staged === "C") {
            index += 1;
            const from = parts[index];
            changes.push(
                staged === "R" ? { path, status: "renamed", ...(from !== undefined && from !== "" ? { from } : {}) } : { path, status: "added" },
            );
            continue;
        }
        // Prefer the worktree column (the state the user sees); unknown codes (unmerged, gitlinks) degrade to
        // modified rather than vanishing from review.
        const letter = staged === "?" ? "A" : worktree !== " " ? worktree : staged;
        changes.push({ path, status: STATUS_OF[letter] ?? "modified" });
    }
    return { ...(branch !== "" ? { branch } : {}), changes };
};

// A repo's cumulative delta vs a fixed base sha — committed work since the base PLUS staged and unstaged
// edits (one diff covers all three) — merged with untracked files. The agents review reads a conversation
// worktree with this: `base` is the sha the worktree branched from, so the result is exactly what landing
// would bring to the main tree, in the same GitChange shape the Changes panel renders.
export const changesAgainstBase = async (dir: string, base: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    const { stdout } = await git(dir, ["diff", "--name-status", "-z", base]);
    // NUL-separated records: `STATUS\0path\0`, except renames/copies which span three fields
    // (`R<score>\0old\0new\0`). A cursor walk, not a fixed stride.
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
        changes.set(path, { path, status: STATUS_OF[status[0] ?? ""] ?? "modified" });
    }
    const untracked = (await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0");
    for (const path of untracked) {
        if (path !== "" && !changes.has(path)) {
            changes.set(path, { path, status: "added" });
        }
    }
    return [...changes.values()];
};

// Commit exactly `paths` — adds, edits AND deletions — leaving everything else uncommitted. The daemon owns
// the index: reset first so agent-staged leftovers can't ride along. False ⇒ the paths hold nothing to commit.
export const commitPaths = async (
    dir: string,
    message: string,
    paths: readonly string[],
    author: { readonly name: string; readonly email: string },
    git: GitRunner = defaultGit,
): Promise<boolean> => {
    const head = await headSha(dir, git);
    if (head !== undefined) {
        await git(dir, ["reset", "-q"]);
    }
    await git(dir, ["add", "-A", "--", ...paths]);
    try {
        // Explicit tree argument so the check also works on an unborn HEAD. Exit 1 (throw) ⇒ index differs.
        await git(dir, ["diff", "--cached", "--quiet", head ?? EMPTY_TREE]);
        return false;
    } catch {
        // Something is staged — fall through to commit.
    }
    await git(dir, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-q", "-m", message]);
    return true;
};

// Discard uncommitted work: everything (no paths) or exactly `paths`. Tracked content returns to HEAD;
// untracked files are deleted. Ignored files (secrets, node_modules, nested repositories/) always survive —
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
    // A staged rename spans two paths — discarding either leg must undo both.
    const { changes } = await changedFiles(dir, git);
    const targets = new Set<string>(paths);
    for (const change of changes) {
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
    const after = (await changedFiles(dir, git)).changes.filter((change) => targets.has(change.path));
    const tracked = after.filter((change) => change.status !== "added").map((change) => change.path);
    const untracked = after.filter((change) => change.status === "added").map((change) => change.path);
    if (tracked.length > 0) {
        await git(dir, ["checkout", "-q", "-f", "HEAD", "--", ...tracked]);
    }
    if (untracked.length > 0) {
        await git(dir, ["clean", "-q", "-f", "-f", "-d", "--", ...untracked]);
    }
};

// Both sides of one changed file — the `ref` blob (HEAD for the working-tree review, a conversation's base
// sha for the agents review) vs the working tree — with the same size/NUL guards as the history diff. The
// route has already validated that `path` stays inside `dir` (resolveWithin).
export const workingFileDiff = async (dir: string, path: string, ref: string, git: GitRunner = defaultGit): Promise<FileDiff> => {
    let before: string | undefined;
    let after: string | undefined;
    let binary = false;
    let truncated = false;
    try {
        const size = Number((await git(dir, ["cat-file", "-s", `${ref}:${path}`])).stdout.trim());
        if (size > MAX_FILE_DIFF_BYTES) {
            truncated = true;
        } else {
            const content = (await git(dir, ["cat-file", "-p", `${ref}:${path}`])).stdout;
            if (content.includes("\0")) {
                binary = true;
            } else {
                before = content;
            }
        }
    } catch {
        // Absent at `ref` (an added file) or an unborn ref — no before side.
    }
    const abs = join(dir, path);
    const size = await statWorkspaceFileSize(abs);
    if (size !== undefined) {
        if (size > MAX_FILE_DIFF_BYTES) {
            truncated = true;
        } else {
            const content = await readWorkspaceFile(abs);
            if (content !== undefined) {
                if (content.includes("\0")) {
                    binary = true;
                } else {
                    after = content;
                }
            }
        }
    }
    return {
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(binary ? { binary: true } : {}),
        ...(truncated ? { truncated: true } : {}),
    };
};
