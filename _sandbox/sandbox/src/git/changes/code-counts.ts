import { join } from "node:path";
import { codeLineStat, type LineStat } from "@intentic/code-read";
import { analyze } from "@intentic/code-read/grammars";
import type { GitChange } from "@intentic/sandbox-contract";
import { gitBytes } from "@intentic/scaffold";
import { readWorkspaceFile, statWorkspaceSizeMtime } from "../../workspace/files/workspace-files.js";
import { MAX_FILE_DIFF_BYTES } from "./diff-partial.js";

// The code-only +/- a diff row shows, computed here (not per-render) so counts never change after they're drawn; uses
// @intentic/code-read's own walk, keyed by side identity and cached for cheap repeat scans.

/** What identifies each side of a diff comparison, without reading it. */
export type Side =
    // A blob by rev-spec (`HEAD:src/a.ts`); `id` is the object name if known, else the rev-spec itself.
    | { readonly kind: "blob"; readonly spec: string; readonly id: string }
    // The file on disk, identified by size + mtime (no read required).
    | { readonly kind: "file"; readonly abs: string }
    // Addition: no before side. Deletion: no after side. Treated as empty text, as git counts it.
    | { readonly kind: "absent" };

export interface Sides {
    readonly before: Side;
    readonly after: Side;
}

/** Per path, the object names `git status` already reported (StatusV2 in changes-porcelain.ts). */
export type BlobNames = ReadonlyMap<string, { head?: string; index?: string }>;

const ABSENT: Side = { kind: "absent" };

// Identifies a blob by object name when known, else by rev-spec: `<sha>:<path>` names the same bytes as long as that
// commit exists, just coarser (every path recounts when HEAD moves).
const blobSide = (spec: string, name: string | undefined): Side => ({ kind: "blob", spec, id: name ?? spec });

// Mirrors the pairing each diff view in changes-diff.ts uses; a rename compares the old path's blob against the new
// path's content.

/** A staged row: HEAD's blob against the index's, as a bare commit would record. */
export const stagedSides =
    (head: string | undefined, blobs: BlobNames) =>
    (change: GitChange): Sides => ({
        before:
            change.status === "added" || head === undefined
                ? ABSENT
                : blobSide(`${head}:${change.from ?? change.path}`, blobs.get(change.path)?.head),
        after: change.status === "deleted" ? ABSENT : blobSide(`:0:${change.path}`, blobs.get(change.path)?.index),
    });

/**
 * An unstaged row: the index's blob against the file on disk; an untracked file has no index entry, so it's treated as
 * an addition.
 */
export const unstagedSides =
    (dir: string, blobs: BlobNames) =>
    (change: GitChange): Sides => ({
        before: change.status === "added" ? ABSENT : blobSide(`:0:${change.from ?? change.path}`, blobs.get(change.path)?.index),
        after: change.status === "deleted" ? ABSENT : { kind: "file", abs: join(dir, change.path) },
    });

/**
 * An unmerged row: HEAD against the file the merge left behind (conflict markers and all); there is no stage 0 to
 * compare with.
 */
export const conflictedSides =
    (dir: string, head: string | undefined) =>
    (change: GitChange): Sides => ({
        before: head === undefined ? ABSENT : blobSide(`${head}:${change.path}`, undefined),
        after: { kind: "file", abs: join(dir, change.path) },
    });

/** An agent's row while its checkout is attached: the blob at its baseline ref, against the file in the worktree. */
export const worktreeAgainstRef =
    (dir: string, ref: string) =>
    (change: GitChange): Sides => ({
        before: change.status === "added" ? ABSENT : blobSide(`${ref}:${change.from ?? change.path}`, undefined),
        after: change.status === "deleted" ? ABSENT : { kind: "file", abs: join(dir, change.path) },
    });

/** The same row once the checkout is gone (an archived agent): two blobs, no disk. */
export const refAgainstRef =
    (base: string, tip: string) =>
    (change: GitChange): Sides => ({
        before: change.status === "added" ? ABSENT : blobSide(`${base}:${change.from ?? change.path}`, undefined),
        after: change.status === "deleted" ? ABSENT : blobSide(`${tip}:${change.path}`, undefined),
    });

// Past this many files, rows keep git's raw numbers only (same fallback as a binary file).
const MAX_COUNTED = 400;

// Concurrent file walks; kept modest since the walk runs on the daemon's own CPU loop.
const LANES = 4;

// Counts cached by side-identity pair, FIFO-evicted past the limit; `undefined` is a cached answer too.
const CACHE_LIMIT = 4_000;
const counted = new Map<string, LineStat | undefined>();

const remember = (key: string, stat: LineStat | undefined): LineStat | undefined => {
    counted.set(key, stat);
    if (counted.size > CACHE_LIMIT) {
        const oldest = counted.keys().next();
        if (!oldest.done) {
            counted.delete(oldest.value);
        }
    }
    return stat;
};

/** Cleared when the workspace this daemon serves is replaced. */
export const resetCodeCounts = (): void => void counted.clear();

// A side's identity, or undefined if it vanished between scan and read; no identity means no cache entry, so the count
// is taken fresh.
const identify = async (side: Side): Promise<string | undefined> => {
    if (side.kind === "absent") {
        return "-";
    }
    if (side.kind === "blob") {
        return `b:${side.id}`;
    }
    const stat = await statWorkspaceSizeMtime(side.abs);
    return stat === undefined ? undefined : `f:${stat.size}:${stat.mtimeMs}`;
};

// One side as text, or undefined if unreadable. Shares the diff body's size cap (MAX_FILE_DIFF_BYTES); a blob read is
// bounded to one spawn, and treated as unreadable past the cap.
const textOf = async (dir: string, side: Side): Promise<string | undefined> => {
    if (side.kind === "absent") {
        return "";
    }
    if (side.kind === "file") {
        const stat = await statWorkspaceSizeMtime(side.abs);
        if (stat === undefined || stat.size > MAX_FILE_DIFF_BYTES) {
            return undefined;
        }
        const content = await readWorkspaceFile(side.abs);
        return content === undefined || content.includes("\0") ? undefined : content;
    }
    const bytes = await gitBytes(dir, ["cat-file", "-p", side.spec], MAX_FILE_DIFF_BYTES).catch(() => undefined);
    if (bytes === undefined || bytes.includes(0)) {
        return undefined;
    }
    // Checked for NUL as bytes before utf8 decode: decoding first would replace NULs with U+FFFD, hiding them.
    return bytes.toString("utf8");
};

const countOne = async (dir: string, path: string, sides: Sides): Promise<LineStat | undefined> => {
    const [before, after] = await Promise.all([identify(sides.before), identify(sides.after)]);
    const key = before === undefined || after === undefined ? undefined : `${dir}\u0000${path}\u0000${before}\u0000${after}`;
    if (key !== undefined && counted.has(key)) {
        return counted.get(key);
    }
    const [beforeText, afterText] = await Promise.all([textOf(dir, sides.before), textOf(dir, sides.after)]);
    if (beforeText === undefined || afterText === undefined) {
        return key === undefined ? undefined : remember(key, undefined);
    }
    // `codeLineStat` returns undefined when no grammar ships for the path; cached like an unreadable side.
    const stat = await codeLineStat(beforeText, afterText, path, analyze).catch(() => undefined);
    return key === undefined ? stat : remember(key, stat);
};

/**
 * Returns changes with a code-only reading attached where available; anything uncountable (binary, oversized) is left
 * as the scan built it.
 */
export const withCodeCounts = async (dir: string, changes: readonly GitChange[], sidesOf: (change: GitChange) => Sides): Promise<GitChange[]> => {
    const rows = [...changes];
    // Skips rows git itself couldn't count (binary, conflict); there's no pair of numbers to compare against.
    const countable = rows.filter((change) => change.additions !== undefined || change.deletions !== undefined).slice(0, MAX_COUNTED);
    const stats = new Map<GitChange, LineStat | undefined>();
    let cursor = 0;
    const lane = async (): Promise<void> => {
        while (cursor < countable.length) {
            const change = countable[cursor++];
            if (change === undefined) {
                return;
            }
            stats.set(change, await countOne(dir, change.path, sidesOf(change)));
        }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, countable.length) }, lane));
    return rows.map((change) => {
        const stat = stats.get(change);
        return stat === undefined ? change : { ...change, code: stat };
    });
};
