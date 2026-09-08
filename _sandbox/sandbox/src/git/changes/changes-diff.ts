import { join } from "node:path";
import type { FileDiff } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../../history/history.js";
import { readWorkspaceFile, readWorkspaceFileWindow, statWorkspaceFileSize } from "../../workspace/files/workspace-files.js";
import { additionPatch, MAX_FILE_DIFF_BYTES, MAX_PATCH_BYTES, partialDiff } from "./diff-partial.js";

// One file's diff, across every pairing the panel lists a row under (staged, unstaged, conflicted, review, commit).
// All compose the same way: both sides read concurrently, then whole text or a bounded patch past diff-partial's cap.
// Each pairing matches the one the row's line counts came from (changes.ts, code-counts.ts); a row and its diff agree.

// One side of a file diff: text, size, or nothing; absent is the empty object (the leg a file doesn't have).
// `bytes` without `text` is too big to ship (patch stands in); `abs` marks a side that's a file, not a git object.
interface DiffSide {
    readonly text?: string;
    readonly binary?: boolean;
    readonly bytes?: number;
    readonly abs?: string;
}

// Present but too big to send whole, the condition that turns a diff into a patch.
const oversize = (side: DiffSide): boolean => side.text === undefined && side.binary !== true && side.bytes !== undefined;

// Blob at a git rev-spec: `HEAD:path` for the commit, `:0:path` for the index (absent for a conflicted path).
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

// Either side binary makes the whole diff binary; either side oversized turns it into a patch (diff-partial.ts).
// Sides are promises, not values, so they read concurrently; `patchTail` is a thunk since the ask can depend on them.
const composeDiff = async (
    dir: string,
    beforeSide: Promise<DiffSide>,
    afterSide: Promise<DiffSide>,
    patchTail: (before: DiffSide, after: DiffSide) => readonly string[],
    git: GitRunner,
): Promise<FileDiff> => {
    const [before, after] = await Promise.all([beforeSide, afterSide]);
    if (oversize(before) || oversize(after)) {
        // No before side plus a file on disk is untracked: git compares index against tree and sees nothing.
        // Nothing to diff; the file is the change, so a bounded head of it is written out as additions (additionPatch).
        const head = before.bytes === undefined && after.abs !== undefined ? await readWorkspaceFileWindow(after.abs, 0, MAX_PATCH_BYTES) : undefined;
        if (head !== undefined) {
            // Same NUL test the sides get, applied here since an oversized file is never otherwise read.
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

// The `ref` blob (a review's base sha) vs the working tree; the only diff a never-checked-out worktree offers.
export const workingFileDiff = (dir: string, path: string, ref: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `${ref}:${path}`, git), worktreeSide(join(dir, path)), () => [ref, "--", path], git);

// Two blobs, no disk: workingFileDiff's counterpart for an archived agent, whose after-side is on agent/<id>.
export const refFileDiff = (dir: string, path: string, base: string, tip: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `${base}:${path}`, git), blobSide(dir, `${tip}:${path}`, git), () => [base, tip, "--", path], git);

// Index vs HEAD: what a Staged row lists, and what a bare `git commit` would record.
// Not HEAD↔worktree: a partially staged file's two diffs differ, why the panel lists both sides.
export const stagedFileDiff = (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `HEAD:${path}`, git), blobSide(dir, `:0:${path}`, git), () => ["--cached", "--", path], git);

// Worktree vs index, the diff an Unstaged row lists; an untracked file has no index entry, so it's an addition.
export const unstagedFileDiff = (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `:0:${path}`, git), worktreeSide(join(dir, path)), () => ["--", path], git);

// Unmerged path: HEAD vs the worktree (what you had against what the merge left, conflict markers and all).
// `:0:` isn't used: an unmerged path has no stage 0 (ours/theirs sit at stages 2/3), so it would read as absent.
export const conflictedFileDiff = (dir: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(dir, blobSide(dir, `HEAD:${path}`, git), worktreeSide(join(dir, path)), () => ["HEAD", "--", path], git);

// Both sides of a file at a commit: blob at the first parent vs at `<sha>`; root/added has no before, deleted no after.
// The one pairing that isn't fixed: `<sha>^` fails at a root commit, so it diffs against the empty tree instead.
export const commitFileDiff = (dir: string, sha: string, path: string, git: GitRunner = defaultGit): Promise<FileDiff> =>
    composeDiff(
        dir,
        blobSide(dir, `${sha}^:${path}`, git),
        blobSide(dir, `${sha}:${path}`, git),
        (before) => [before.bytes === undefined ? EMPTY_TREE : `${sha}^`, sha, "--", path],
        git,
    );
