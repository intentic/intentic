import { join } from "node:path";
import type { FileDiff } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { EMPTY_TREE } from "../../history/history.js";
import { readWorkspaceFile, readWorkspaceFileWindow, statWorkspaceFileSize } from "../../workspace/files/workspace-files.js";
import { additionPatch, MAX_FILE_DIFF_BYTES, MAX_PATCH_BYTES, partialDiff } from "./diff-partial.js";

/* ONE FILE'S DIFF, for every pairing the panel lists a row under: index vs HEAD (staged), worktree vs index
 * (unstaged), HEAD vs worktree (conflicted), a base ref vs the worktree (an agent's review), two refs (an
 * archived agent's), and the two sides of a commit (the graph). All six compose the same way: the two sides
 * read concurrently, then either the whole text or, past diff-partial's cap, a bounded patch. Each pairing is
 * the SAME one the row's line counts came from (changes.ts, code-counts.ts), so a row and the diff it opens
 * never disagree about what is being compared. */

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
