import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mapPool } from "@intentic/base/async";
import { exitCodeOf, stdoutOf, undefinedIfMissing } from "@intentic/base/errors";
import { plural, sizeLabel } from "@intentic/base/format";
import type { GitRunner } from "@intentic/base/git";
import { chunkPaths, pruneEmptiedDirs } from "../../../git/changes/changes-index.js";
import { materializedPaths } from "../../../git/changes/changes-porcelain.js";
import { keepHidden, literalPattern } from "../../../store/git/kept-hidden-excludes.js";
import { destinationsOf, type FolderMove, folderMoves } from "./renames.js";

// WHAT A LAND'S NEW IGNORE RULES WOULD PUT ON SHOW (2026-11-21). Git tracks no ignored file, so a land that moves a
// folder and its .gitignore lines moves the source and leaves the build output the old lines hid where it was, hidden by
// nothing. Twice on one sandbox a web client's move put thousands of build files (4.1 GB once) in the owner's Changes as
// their own edits, one Save from being committed; and the restore point the land's write set off hashed all 4,992 of them
// for 263 s, which a discard then queued behind. The agent could not have cleaned up: its checkout, cut from HEAD, never
// held an ignored file. The land is the first moment that knows both what moved and what the main tree had hidden.
//
// So, under the land's repo lock: before the write, what main ignores under each folder whose ignore file the delta
// changes; after it, which of those are on show now. Each is moved after the folder the land renamed when a rename
// carries it to a place the new rules ignore and nothing stands there yet (build caches stay warm, saves and databases
// follow their code); everything else is hidden where it is, as the old rules hid it, by the same paths in the
// repository's own exclude file (store/git/kept-hidden-excludes.ts). Nothing is deleted: an ignored file is not always
// rebuildable (a game server's accounts database, its world saves).

// What the main tree ignored before the write, as `ls-files --directory` lists it: a folder git did not enter ends in a
// slash and stands for everything inside it, and every other ignored file is its own row.
export interface IgnoredBefore {
    readonly rows: readonly string[];
    // Every path the delta writes: the land's own work, never a leftover, though a rule it dropped once hid its place.
    readonly written: ReadonlySet<string>;
}

export interface UnhiddenEntry {
    readonly path: string;
    readonly files: number;
    readonly bytes: number;
}

export interface Unhidden {
    readonly repo: string;
    // One entry per folder move that carried files, `path` its old place and `to` its new one.
    readonly moved: readonly (UnhiddenEntry & { readonly to: string })[];
    // Hidden in place, one entry per folder (or top-level file) holding them.
    readonly kept: readonly UnhiddenEntry[];
}

// Destinations tried per group of files, most voted move first.
const MOVES_TRIED = 3;
// Exact paths the exclude block takes at most: git tests every untracked path against every pattern, so past this the
// rest stay on show, where the Changes view lists them as one bulk folder each (scratch.ts).
const MAX_KEPT_PATTERNS = 2_000;
// Files moved or sized at once.
const FS_CONCURRENCY = 32;

const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

const isIgnoreFile = (path: string): boolean => path === ".gitignore" || path.endsWith("/.gitignore");

// Every folder above `path`, with its trailing slash, outermost first.
const foldersAbove = (path: string): string[] => {
    const parts = path.replace(/\/$/u, "").split("/");
    return parts.slice(0, -1).map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
};

/**
 * Before the write, under the repo lock: what `main` ignores under the folders whose ignore files the delta from..tip
 * changes. Undefined when it changes none, which is almost every land and costs one name-only diff.
 */
export const ignoredBeforeLand = async (main: string, from: string, tip: string, git: GitRunner): Promise<IgnoredBefore | undefined> => {
    const written = materializedPaths((await git(main, ["diff", "--name-only", "--no-renames", "-z", from, tip])).stdout);
    const changed = written.filter(isIgnoreFile);
    if (changed.length === 0) {
        return undefined;
    }
    const folders = [...new Set(changed.map(folderOf))];
    const scope = folders.includes("") ? [] : ["--", ...folders];
    const rows = materializedPaths((await git(main, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", ...scope])).stdout);
    return rows.length === 0 ? undefined : { rows, written: new Set(written) };
};

// The fewest paths whose listing reaches every row: a folder row itself, a file row's folder (a top-level file itself),
// any one inside another dropped.
const coverOf = (rows: readonly string[]): string[] => {
    const cover = new Set<string>();
    const wanted = rows.map((row) => (row.endsWith("/") ? row.slice(0, -1) : folderOf(row) === "" ? row : folderOf(row)));
    for (const path of [...new Set(wanted)].toSorted((a, b) => a.length - b.length)) {
        if (!cover.has(path) && !foldersAbove(path).some((folder) => cover.has(folder.slice(0, -1)))) {
            cover.add(path);
        }
    }
    return [...cover];
};

// The untracked files nothing ignores under `cover`, one listing per argument-sized chunk.
const onShow = async (main: string, cover: readonly string[], git: GitRunner): Promise<string[]> => {
    const listed: string[] = [];
    for (const chunk of chunkPaths(cover)) {
        listed.push(...materializedPaths((await git(main, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...chunk])).stdout));
    }
    return listed;
};

// The row of `rows` that hid `path` before the write, if one did.
const rowHiding = (path: string, files: ReadonlySet<string>, folders: ReadonlySet<string>): string | undefined =>
    files.has(path) ? path : foldersAbove(path).find((folder) => folders.has(folder));

// The files on show now that a row hid before, grouped by that row.
const unhiddenByRow = (rows: readonly string[], shown: readonly string[]): Map<string, string[]> => {
    const files = new Set(rows.filter((row) => !row.endsWith("/")));
    const folders = new Set(rows.filter((row) => row.endsWith("/")));
    const byRow = new Map<string, string[]>();
    for (const path of shown) {
        const row = rowHiding(path, files, folders);
        if (row !== undefined) {
            byRow.set(row, [...(byRow.get(row) ?? []), path]);
        }
    }
    return byRow;
};

// `check-ignore -v -n` answers each path on its own line, in order: `source:line:pattern<TAB>path`, or `::<TAB>path`
// when nothing matched. A matched `!pattern` re-includes. Read by position, so a quoted name needs no unquoting.
const ignoredLine = (line: string): boolean => {
    const pattern = /^.*?:\d+:(.*)\t/u.exec(line)?.[1];
    return pattern !== undefined && !pattern.startsWith("!");
};

// Which of `paths` the rules as they stand now ignore; a path need not exist.
const ignoredNow = async (main: string, paths: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> => {
    const ignored = new Set<string>();
    for (const chunk of chunkPaths(paths)) {
        let stdout: string;
        try {
            stdout = (await git(main, ["check-ignore", "--verbose", "--non-matching", "--", ...chunk])).stdout;
        } catch (error) {
            // Exit 1 is check-ignore's "none of these is ignored", its answer still on stdout.
            if (exitCodeOf(error) !== 1) {
                throw error;
            }
            stdout = stdoutOf(error) ?? "";
        }
        const lines = stdout.split("\n").filter((line) => line !== "");
        // Unreadable line for line: none of the chunk counts as ignored, so its files stay hidden in place instead.
        if (lines.length === chunk.length) {
            lines.forEach((line, index) => ignoredLine(line) && ignored.add(chunk[index] ?? ""));
        }
    }
    return ignored;
};

interface Placed {
    readonly to: string;
    readonly move: FolderMove;
}

// For each row, the most voted move that carries every one of its files somewhere the rules ignore again; tried in
// rounds, so each round costs one check-ignore over every row still unplaced.
const placeRows = async (main: string, byRow: ReadonlyMap<string, string[]>, moves: readonly FolderMove[], git: GitRunner): Promise<Map<string, Placed>> => {
    const placed = new Map<string, Placed>();
    for (let round = 0; round < MOVES_TRIED && moves.length > 0; round += 1) {
        const trying = [...byRow].flatMap(([row, files]) => {
            const candidate = placed.has(row) ? undefined : destinationsOf(row, moves)[round];
            return candidate === undefined ? [] : [{ row, files, candidate }];
        });
        if (trying.length === 0) {
            break;
        }
        const ignored = await ignoredNow(main, trying.flatMap(({ row, files, candidate }) => files.map((file) => `${candidate.to}${file.slice(row.length)}`)), git);
        for (const { row, files, candidate } of trying) {
            if (files.every((file) => ignored.has(`${candidate.to}${file.slice(row.length)}`))) {
                placed.set(row, candidate);
            }
        }
    }
    return placed;
};

const absent = async (path: string): Promise<boolean> => (await lstat(path).catch(undefinedIfMissing)) === undefined;

// Moves one row's files to their place, the folder whole when nothing stands there yet, else file by file where nothing
// stands; answers the files it moved. A file that will not move (a mount boundary) stays, and is hidden where it is.
const moveRow = async (main: string, row: string, files: readonly string[], to: string): Promise<string[]> => {
    if (row.endsWith("/") && (await absent(join(main, to)))) {
        try {
            await mkdir(dirname(join(main, to)), { recursive: true });
            await rename(join(main, row), join(main, to));
            return [...files];
            // allow(silent-catch): a folder that will not move is moved file by file below, or kept hidden in place.
        } catch {}
    }
    const moved: string[] = [];
    for (const file of files) {
        const target = join(main, `${to}${file.slice(row.length)}`);
        try {
            if (await absent(target)) {
                await mkdir(dirname(target), { recursive: true });
                await rename(join(main, file), target);
                moved.push(file);
            }
            // allow(silent-catch): a file that will not move stays where it is, hidden there as the old rules hid it.
        } catch {}
    }
    return moved;
};

const sizesOf = async (main: string, paths: readonly string[]): Promise<Map<string, number>> => {
    const sizes = new Map<string, number>();
    await mapPool(paths, FS_CONCURRENCY, async (path) => {
        sizes.set(path, (await lstat(join(main, path)).catch(undefinedIfMissing))?.size ?? 0);
    });
    return sizes;
};

// Entries summed per key, sorted by path.
const summed = <T extends UnhiddenEntry>(entries: Iterable<[string, T]>): T[] => [...new Map(entries).values()].toSorted((a, b) => (a.path < b.path ? -1 : 1));

/**
 * After the write, still under the repo lock: moves or hides what the write put on show that `before` had hidden.
 * Undefined when nothing came on show. Never throws for a file it could not move: that one is hidden where it is.
 */
export const settleUnhidden = async (repo: string, main: string, before: IgnoredBefore, from: string, tip: string, git: GitRunner): Promise<Unhidden | undefined> => {
    const byRow = unhiddenByRow(before.rows, (await onShow(main, coverOf(before.rows), git)).filter((path) => !before.written.has(path)));
    if (byRow.size === 0) {
        return undefined;
    }
    const sizes = await sizesOf(main, [...byRow.values()].flat());
    const placed = await placeRows(main, byRow, await folderMoves(main, from, tip, git), git);
    const moved = new Map<string, UnhiddenEntry & { readonly to: string }>();
    const keptByRow = new Map<string, string[]>();
    await mapPool([...byRow], FS_CONCURRENCY, async ([row, files]) => {
        const place = placed.get(row);
        const went = place === undefined ? [] : await moveRow(main, row, files, place.to);
        if (place !== undefined && went.length > 0) {
            const key = `${place.move.from}\0${place.move.to}`;
            const was = moved.get(key) ?? { path: place.move.from, to: place.move.to, files: 0, bytes: 0 };
            moved.set(key, { ...was, files: was.files + went.length, bytes: was.bytes + went.reduce((sum, file) => sum + (sizes.get(file) ?? 0), 0) });
        }
        const stayed = files.filter((file) => !went.includes(file));
        if (stayed.length > 0) {
            keptByRow.set(row, stayed);
        }
    });
    await pruneEmptiedDirs(main, [...byRow.keys()].filter((row) => !keptByRow.has(row)).map((row) => row.replace(/\/$/u, "")));
    const kept = await hideInPlace(main, byRow, keptByRow, sizes, before.written);
    return moved.size === 0 && kept.length === 0 ? undefined : { repo, moved: summed(moved), kept };
};

// Hides what stayed by the rows that hid it before: a folder row whose every file stayed by the row itself (what the old
// rule hid, no wider) unless the land wrote into it, else file by file, so no pattern hides the land's own work. Answers
// what it hid, one entry per folder.
const hideInPlace = async (
    main: string,
    byRow: ReadonlyMap<string, string[]>,
    keptByRow: ReadonlyMap<string, string[]>,
    sizes: ReadonlyMap<string, number>,
    written: ReadonlySet<string>,
): Promise<UnhiddenEntry[]> => {
    const writtenInto = new Set([...written].flatMap(foldersAbove));
    const whole = (row: string, stayed: readonly string[]): boolean => row.endsWith("/") && !writtenInto.has(row) && stayed.length === byRow.get(row)?.length;
    const hidden = [...keptByRow].flatMap(([row, stayed]) => (whole(row, stayed) ? [row] : stayed));
    const patterns = hidden.slice(0, MAX_KEPT_PATTERNS).flatMap((path) => literalPattern(path) ?? []);
    await keepHidden(main, patterns);
    const entries = new Map<string, UnhiddenEntry>();
    for (const [row, stayed] of keptByRow) {
        const path = row.endsWith("/") ? row : `${folderOf(row)}/`;
        const was = entries.get(path) ?? { path, files: 0, bytes: 0 };
        entries.set(path, { path, files: was.files + stayed.length, bytes: was.bytes + stayed.reduce((sum, file) => sum + (sizes.get(file) ?? 0), 0) });
    }
    return summed(entries);
};

// What each planned write into a main tree had hidden, keyed by repo, read before any write; a write the delta of which
// changes no ignore file costs one name-only diff.
export interface UnhiddenWrite {
    readonly repo: string;
    readonly main: string;
    readonly from: string;
    readonly tip: string;
}

export const hiddenBeforeWrites = async (
    writes: readonly (UnhiddenWrite | undefined)[],
    git: GitRunner,
): Promise<readonly (UnhiddenWrite & { readonly before: IgnoredBefore })[]> => {
    const read: (UnhiddenWrite & { readonly before: IgnoredBefore })[] = [];
    for (const write of writes) {
        const before = write === undefined ? undefined : await ignoredBeforeLand(write.main, write.from, write.tip, git);
        if (write !== undefined && before !== undefined) {
            read.push({ ...write, before });
        }
    }
    return read;
};

// Each written repo's settling, in order; undefined when none put anything on show. A repo whose write the tree refused
// is unchanged and skipped.
export const settleWrites = async (
    read: readonly (UnhiddenWrite & { readonly before: IgnoredBefore })[],
    refused: ReadonlySet<string>,
    git: GitRunner,
): Promise<readonly Unhidden[] | undefined> => {
    const settled: Unhidden[] = [];
    for (const write of read.filter(({ repo }) => !refused.has(repo))) {
        const done = await settleUnhidden(write.repo, write.main, write.before, write.from, write.tip, git);
        if (done !== undefined) {
            settled.push(done);
        }
    }
    return settled.length === 0 ? undefined : settled;
};

// The land's own account of it, for the activity feed and the log: plain words, a path per folder.
export const unhiddenSentences = (unhidden: Unhidden): string[] => {
    const where = (path: string): string => (unhidden.repo === "root" ? path : `${unhidden.repo}/${path}`) || "the top";
    return [
        ...unhidden.moved.map(
            (entry) =>
                `Moved ${plural(entry.files, "ignored file")} (${sizeLabel(entry.bytes)}) along with ${where(entry.path)} to ${where(entry.to)}, where the new ignore rules hide them.`,
        ),
        ...unhidden.kept.map(
            (entry) =>
                `Kept ${plural(entry.files, "ignored file")} (${sizeLabel(entry.bytes)}) in ${where(entry.path)} hidden, as the ignore rules this land replaced hid them.`,
        ),
    ];
};
