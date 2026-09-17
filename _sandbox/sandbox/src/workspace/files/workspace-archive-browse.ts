import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { archiveFormat, archivePrefixOf, archiveRootOf, archiveStem, isBrowsableArchive, type WorkspaceChildren } from "@intentic/sandbox-contract";
import { tidyUnpacked, unpack } from "./workspace-extract.js";
import { resolveWithin } from "./workspace-files-paths.js";
import { listWorkspaceChildren } from "./workspace-tree.js";

// Reading a zip or tar as if it were a folder: the archive is unpacked once into a cache outside the workspace, and
// every read of a path THROUGH the archive is served from there.
//
// The cache sits in /tmp, never under /work: it must not reach git, the delta that lands in the owner's tree, the tree
// walk, iq, or the file watcher. It is keyed by the archive's content hash, so a changed archive lands in a different
// directory and a stale listing is impossible rather than merely unlikely.

const CACHE_ROOT = join(tmpdir(), "intentic-archives");

// What one archive may unpack to. Past this it is a bomb or a backup, and a file browser is the wrong tool either way;
// `Extract` is still offered, where the user chose the cost.
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
// Everything the cache may hold before the least recently opened archives are dropped.
const MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024;
// How often the landing bytes are counted while a tool writes. Short enough that a bomb is stopped near the cap, long
// enough that the count costs nothing next to the unpack.
const SIZE_POLL_MS = 750;

/** An archive too big to open as a folder; unpacking it in the workspace is still offered. */
export class ArchiveTooLargeError extends Error {
    constructor(file: string) {
        super(`${file} is too large to open here; extract it instead`);
    }
}

const exec = promisify(execFile);

// Bytes each named tree occupies on disk. One `du` for all of them: walking in node would cost a syscall per entry,
// and one spawn per cached archive would make eviction cost more than the unpack it makes room for.
const treeBytes = async (dirs: readonly string[]): Promise<Map<string, number>> => {
    if (dirs.length === 0) {
        return new Map();
    }
    const { stdout } = await exec("du", ["-s", "-B1", ...dirs]);
    return new Map(
        stdout
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
                const [bytes, ...rest] = line.split("\t");
                return [rest.join("\t"), Number.parseInt(bytes ?? "", 10) || 0] as const;
            }),
    );
};

/** Bytes one tree occupies, for the ceiling a single unpack is watched against. */
const oneTreeBytes = async (dir: string): Promise<number> => (await treeBytes([dir])).get(dir) ?? 0;

// The archive's bytes, hashed. Memoised on identity (where it is, how big, when it changed), so walking around inside
// one doesn't re-read it; a rewritten archive misses the memo and hashes again.
// Bounded: a daemon that has seen thousands of archives must not keep a row for each one forever. Insertion order is
// the eviction order, so the oldest identity goes first.
const MAX_REMEMBERED_HASHES = 500;
const hashes = new Map<string, string>();

const contentHash = async (absArchive: string, size: number, mtimeMs: number): Promise<string> => {
    const identity = `${absArchive}:${size}:${mtimeMs}`;
    const known = hashes.get(identity);
    if (known !== undefined) {
        return known;
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(absArchive)) {
        digest.update(chunk as Buffer);
    }
    const hash = digest.digest("hex");
    const oldest = hashes.size >= MAX_REMEMBERED_HASHES ? hashes.keys().next().value : undefined;
    if (oldest !== undefined) {
        hashes.delete(oldest);
    }
    hashes.set(identity, hash);
    return hash;
};

// Drops the least recently opened archives until the cache is back under its ceiling. Runs before an unpack, so the
// room it makes is for the one about to land; the directory being made is not there yet to be dropped.
const evict = async (): Promise<void> => {
    const names = await readdir(CACHE_ROOT).catch((): string[] => []);
    const dirs = names.map((name) => join(CACHE_ROOT, name));
    const sizes = await treeBytes(dirs).catch(() => new Map<string, number>());
    const held = await Promise.all(
        dirs.map(async (dir) => ({ dir, bytes: sizes.get(dir) ?? 0, opened: (await stat(dir).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    let total = held.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of held.sort((a, b) => a.opened - b.opened)) {
        if (total <= MAX_CACHE_BYTES) {
            return;
        }
        await rm(entry.dir, { recursive: true, force: true });
        total -= entry.bytes;
    }
};

// Kills the tool the moment what it has written passes the ceiling. A declared size can lie; bytes on disk cannot,
// which is why this counts rather than reading the archive's own table of contents.
const watchSize = (dir: string, maxBytes: number, stop: AbortController): (() => void) => {
    const timer = setInterval(() => {
        void oneTreeBytes(dir)
            .then((bytes) => {
                if (bytes > maxBytes) {
                    stop.abort();
                }
            })
            .catch(() => undefined);
    }, SIZE_POLL_MS);
    return () => clearInterval(timer);
};

// Unpacks into `<hash>.partial` and renames it onto `<hash>`: a half-written tree is never mistaken for a complete
// one, whatever kills the daemon mid-unpack.
const unpackInto = async (absArchive: string, target: string, maxBytes: number): Promise<void> => {
    const name = basename(absArchive);
    const format = archiveFormat(name);
    const stem = archiveStem(name);
    if (format === undefined || stem === undefined) {
        throw new Error(`${name} holds no directory to open`);
    }
    const partial = `${target}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    const stop = new AbortController();
    const unwatch = watchSize(partial, maxBytes, stop);
    try {
        await unpack(format, absArchive, partial, "ignore", stop.signal);
        // The tool can finish between two counts; the last word on whether it fits is the tree it left.
        if ((await oneTreeBytes(partial)) > maxBytes) {
            throw new ArchiveTooLargeError(name);
        }
        await tidyUnpacked(partial, stem);
    } catch (failure) {
        await rm(partial, { recursive: true, force: true });
        throw stop.signal.aborted ? new ArchiveTooLargeError(name) : failure;
    } finally {
        unwatch();
    }
    await rename(partial, target);
};

// One unpack per hash, however many readers ask at once: the second caller awaits the first's work instead of racing
// it into the same directory.
const unpacking = new Map<string, Promise<string>>();

/**
 * The directory holding this archive's contents, unpacking it on first ask. Throws ArchiveTooLargeError for an
 * archive past the ceiling, and whatever the tool complained about for one that won't unpack. `maxBytes` overrides
 * the ceiling, which is how the cap is tested without building a two-gigabyte archive.
 */
export const unpackedArchiveDir = async (absArchive: string, options?: { maxBytes?: number }): Promise<string> => {
    const name = basename(absArchive);
    const maxBytes = options?.maxBytes ?? MAX_UNPACKED_BYTES;
    if (!isBrowsableArchive(name)) {
        throw new Error(`${name} holds no directory to open`);
    }
    const stats = await stat(absArchive);
    // A compressed archive over the ceiling cannot unpack to less than it; refused before it is even read.
    if (stats.size > maxBytes) {
        throw new ArchiveTooLargeError(name);
    }
    const hash = await contentHash(absArchive, stats.size, stats.mtimeMs);
    const target = join(CACHE_ROOT, hash);
    const ready = await stat(target).catch(() => undefined);
    if (ready !== undefined) {
        // Being opened is what keeps it: eviction reads this as when the archive was last wanted.
        await utimes(target, new Date(), new Date()).catch(() => undefined);
        return target;
    }
    const started = unpacking.get(hash);
    if (started !== undefined) {
        return started;
    }
    const run = (async (): Promise<string> => {
        await mkdir(CACHE_ROOT, { recursive: true });
        await evict();
        await unpackInto(absArchive, target, maxBytes);
        return target;
    })().finally(() => unpacking.delete(hash));
    unpacking.set(hash, run);
    return run;
};

/** Whether an absolute path is an archive file that can be opened as a folder, rather than a folder named like one. */
export const isBrowsableArchiveFile = (abs: string): boolean =>
    isBrowsableArchive(basename(abs)) && statSync(abs, { throwIfNoEntry: false })?.isFile() === true;

// Whether a browsable archive exists at a path inside `dir`, for splitting a path against an unpacked tree.
const memberProbe =
    (dir: string) =>
    (path: string): boolean => {
        const abs = resolveWithin(dir, path);
        return abs !== undefined && isBrowsableArchiveFile(abs);
    };

/**
 * Where a path INSIDE an archive really points, reading through an archive nested in it: `outer.zip/inner.zip/a.txt`
 * is `a.txt` in inner's own unpacked copy, which is itself a file in outer's. Undefined for a path that climbs out.
 */
export const archiveMemberPath = async (absArchive: string, inside: string): Promise<string | undefined> => {
    const dir = await unpackedArchiveDir(absArchive);
    const nested = archivePrefixOf(inside, memberProbe(dir));
    if (nested === undefined) {
        return resolveWithin(dir, inside);
    }
    const abs = resolveWithin(dir, nested.archive);
    return abs === undefined ? undefined : archiveMemberPath(abs, nested.inside);
};

/**
 * One level of an archive's contents, as if it were the folder `archivePath` names. `inside` is where in the archive,
 * "" for its top level; an archive nested in it opens the same way, out of its own unpacked copy.
 *
 * Listed from the cache root rather than the unpacked directory, since a listing is always OF something: the hash is
 * the first segment, stripped back off each entry so the browser only ever sees paths through the archive.
 */
export const archiveChildrenOf = async (
    absArchive: string,
    archivePath: string,
    inside: string,
    options?: { depth?: number },
): Promise<WorkspaceChildren> => {
    const dir = await unpackedArchiveDir(absArchive);
    const nested = inside === "" ? undefined : archiveRootOf(inside, memberProbe(dir));
    if (nested !== undefined) {
        const abs = resolveWithin(dir, nested.archive);
        if (abs === undefined) {
            return { entries: [], hidden: 0 };
        }
        return archiveChildrenOf(abs, `${archivePath}/${nested.archive}`, nested.inside, options);
    }
    const key = basename(dir);
    const listing = await listWorkspaceChildren(dirname(dir), inside === "" ? key : `${key}/${inside}`, { ...options, ignoreRules: false });
    return {
        hidden: listing.hidden,
        entries: listing.entries.map((entry) => ({ ...entry, path: `${archivePath}/${entry.path.slice(key.length + 1)}` })),
    };
};

/** Forgets every unpacked tree. For tests, which must not see another test's cache. */
export const resetArchiveCache = async (): Promise<void> => {
    hashes.clear();
    unpacking.clear();
    await rm(CACHE_ROOT, { recursive: true, force: true });
};
