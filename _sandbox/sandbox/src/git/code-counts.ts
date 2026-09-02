import { join } from "node:path";
import { codeLineStat, type LineStat } from "@intentic/code-read";
import { analyze } from "@intentic/code-read/grammars";
import type { GitChange } from "@intentic/sandbox-contract";
import { gitBytes } from "@intentic/scaffold";
import { readWorkspaceFile, statWorkspaceSizeMtime } from "../workspace/workspace-files.js";
import { MAX_FILE_DIFF_BYTES } from "./diff-partial.js";

/* THE CODE-ONLY +/− A REVIEW SHOWS, COMPUTED WHERE THE FILES ARE.
 *
 * A review's diffs open on code alone (the reader asks for comments back, they are not there by default), so the
 * numbers beside them have to be the code's: a row reading +26 that opens onto an empty pane is a number sitting
 * next to something it does not count. Working that out needs both whole sides of the file and a TextMate walk
 * over each of them, and for a long time the APP did it: per file, as the files happened to be read, in the
 * background and on the click that opened one.
 *
 * That is what this module exists to end. A number that arrives after the row is drawn is a number that CHANGES
 * under the reader — the badge redraws, a comments-only file suddenly reads "comments" instead of a count, and a
 * list ordered by size re-sorts around it, on the click that just selected a row. The daemon has the files, so
 * the daemon counts them, and the list arrives with the answer already in it. What the reader first sees is
 * final.
 *
 * IT IS THE SAME READING THE PANE WILL SHOW, to the line, because it is the same code: @intentic/code-read holds
 * the walk, the comment strip and the grammar table, and the app renders its diff through the very same pass.
 * Two implementations of "what is a comment" that agree today would not agree for long.
 *
 * WHAT IT COSTS, AND WHY THAT IS AFFORDABLE. A miss reads both sides (one `cat-file` per blob side; the worktree
 * side is an ordinary file read) and tokenizes them. A hit costs a map lookup. Scans are frequent — several a
 * second while an agent writes — so everything here is built around the hit: each side is identified by
 * something git already told the scan (a blob's object name, a file's size and mtime), never by its content, so
 * a scan that changed nothing reads nothing. The bounds below keep the miss path from being pathological. */

/** How the two sides of one comparison are addressed, and what identifies each without reading it. */
export type Side =
    // A blob, by rev-spec (`HEAD:src/a.ts`). `id` is the object name when the scan already knows it, else the
    // ref that names it: either way, the same id means the same bytes.
    | { readonly kind: "blob"; readonly spec: string; readonly id: string }
    // The file on disk. Identified by size + mtime, which is what a scan can ask for without reading it.
    | { readonly kind: "file"; readonly abs: string }
    // An addition has no before side and a deletion no after side. Counts as the empty text, exactly as git's own
    // numbers treat it.
    | { readonly kind: "absent" };

export interface Sides {
    readonly before: Side;
    readonly after: Side;
}

/** Per path, the object names `git status` already reported (changes.ts' StatusV2). */
export type BlobNames = ReadonlyMap<string, { head?: string; index?: string }>;

const ABSENT: Side = { kind: "absent" };

// A blob side, identified by its object name where the scan knows it and by the rev-spec itself where it does
// not: `<sha>:<path>` names the same bytes for as long as that commit exists, so it is an identity too, just a
// coarser one (every path in a repo re-counts when HEAD moves).
const blobSide = (spec: string, name: string | undefined): Side => ({ kind: "blob", spec, id: name ?? spec });

/* WHICH TWO THINGS A ROW COMPARES, one pairing per surface, and each is the SAME pairing the diff body uses
 * (changes.ts' stagedFileDiff / unstagedFileDiff / conflictedFileDiff / workingFileDiff / refFileDiff). They have
 * to be: the count on a row and the diff it opens are two readings of one comparison, and a row whose badge
 * describes index-vs-HEAD over a pane showing HEAD-vs-worktree is worse than no badge at all.
 *
 * A rename compares the OLD path's blob with the new path's content, which is what git's own numbers for it
 * describe. An addition has no before side and a deletion no after side, and `absent` is how each says so. */

/** A staged row: HEAD's blob against the index's, exactly what a bare commit would record. */
export const stagedSides =
    (head: string | undefined, blobs: BlobNames) =>
    (change: GitChange): Sides => ({
        before:
            change.status === "added" || head === undefined
                ? ABSENT
                : blobSide(`${head}:${change.from ?? change.path}`, blobs.get(change.path)?.head),
        after: change.status === "deleted" ? ABSENT : blobSide(`:0:${change.path}`, blobs.get(change.path)?.index),
    });

/** An unstaged row: the index's blob against the file on disk. An untracked file has no index entry at all, so
 *  it is the addition it looks like. */
export const unstagedSides =
    (dir: string, blobs: BlobNames) =>
    (change: GitChange): Sides => ({
        before: change.status === "added" ? ABSENT : blobSide(`:0:${change.from ?? change.path}`, blobs.get(change.path)?.index),
        after: change.status === "deleted" ? ABSENT : { kind: "file", abs: join(dir, change.path) },
    });

/** An unmerged row: HEAD against the file the merge left behind, markers and all. There is no stage 0 to
 *  compare with, which is why this pairing is its own. */
export const conflictedSides =
    (dir: string, head: string | undefined) =>
    (change: GitChange): Sides => ({
        before: head === undefined ? ABSENT : blobSide(`${head}:${change.path}`, undefined),
        after: { kind: "file", abs: join(dir, change.path) },
    });

/** An agent's row while its checkout is attached: the blob at the ref its work is measured from, against the
 *  file in the worktree. */
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

/* HOW MANY FILES ONE LIST WILL COUNT. Past this the rows carry git's numbers alone, which is a stable, honest
 * reading and the one the panel already falls back to for a binary file. A 500-file mass rename must not turn a
 * scan into a minute of tokenizing, and nobody reads the code-only count of the four-hundredth row of one. */
const MAX_COUNTED = 400;

// How many files are read and walked at once. The walk is CPU on the daemon's own loop, so this is deliberately
// modest: it is the same shape as the untracked line-count pool next door, for the same reason.
const LANES = 4;

/* WHAT IS REMEMBERED, keyed by the pair of side identities, so the same file version is counted once however
 * many scans see it — and a file the agent rewrites is a new key rather than a stale answer.
 *
 * Bounded and FIFO-evicted. A review is a few hundred rows and a session touches a few thousand; past that the
 * oldest entries are the ones no open panel is asking about. The value is the reading itself, `undefined` for a
 * file there is no code reading OF (binary, oversize, no grammar), which is an answer worth caching too: without
 * it every scan would re-read a vendored bundle to rediscover that it cannot be counted. */
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

/** Dropped when the workspace this daemon serves is replaced, the same moment every other repo-shaped cache is. */
export const resetCodeCounts = (): void => void counted.clear();

// A side's identity, or undefined when it has none to give (a file that vanished between the scan and this
// read): no identity, no cache entry, and the count is taken fresh.
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

/* One side as text, or undefined for anything there is no code reading of.
 *
 * The size cap is the one the diff body already uses (MAX_FILE_DIFF_BYTES), so a file whose diff the panel would
 * refuse to render whole is also one this refuses to count: a row's badge and the diff it opens never describe
 * different files. A blob is read with a bounded buffer rather than sized first, which is one spawn instead of
 * two on the path that runs per changed file; over the cap the read throws and the answer is "no reading". */
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
    // Tested for NUL as BYTES and only then decoded: utf8 decoding an image first replaces every invalid
    // sequence with U+FFFD, including the very NULs the test is looking for, and the picture comes back as a
    // page of replacement characters to be tokenized as if it were source.
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
    // `codeLineStat` answers undefined for a path whose grammar this build ships none of, which is the same
    // "no code reading" as an unreadable side and is cached the same way.
    const stat = await codeLineStat(beforeText, afterText, path, analyze).catch(() => undefined);
    return key === undefined ? stat : remember(key, stat);
};

/** The changes, each carrying its code-only reading where there is one to carry. Everything else is left exactly
 *  as the scan built it, so a caller that cannot be counted (a binary row, an oversized diff) is unchanged. */
export const withCodeCounts = async (dir: string, changes: readonly GitChange[], sidesOf: (change: GitChange) => Sides): Promise<GitChange[]> => {
    const rows = [...changes];
    // A row git could not count either (a binary file, a conflict) has no code reading to give: the pair of
    // numbers it would be compared against does not exist.
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
