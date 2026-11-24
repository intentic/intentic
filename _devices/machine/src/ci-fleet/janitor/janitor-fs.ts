import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat, statfs, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";

/* WHAT THE JANITOR AND THE HOST PRUNE ASK OF THE DISK, with node:fs on real paths (so a test points them at a temp folder)
   where the scripts asked du, find and df: a tree's size as `du -sxb` counts it, its files older than `find -mtime +N`
   says, whether anything in it is newer than `-newermt`, and the removal through the trash. Every walk stays on the
   filesystem it starts on and never follows a link, as du -x and find do. */

export const GIB = 1024 ** 3;
export const DAY_MS = 86_400_000;
// Entries one walk stats at once: a pnpm store's folder holds tens of thousands.
const STAT_BATCH = 256;

// Gigabytes with one decimal, as the scripts' `gb` printed them.
export const gb = (bytes: number): string => (bytes / GIB).toFixed(1);

// An entry's stats, or undefined where it is gone (or never was); a walk meets entries a job removes under it.
export const lstatOf = async (path: string): Promise<Stats | undefined> => await lstat(path).catch(undefinedIfMissing);

export const isDir = async (path: string): Promise<boolean> => (await stat(path).catch(undefinedIfMissing))?.isDirectory() === true;

export const namesIn = async (path: string): Promise<string[]> => ((await readdir(path).catch(undefinedIfMissing)) ?? []).toSorted();

// What a walk is told of each entry: its path, its stats and how deep it is (the root is 0). Answering "stop" ends it.
export type Visit = (path: string, stats: Stats, depth: number) => "stop" | undefined;

interface WalkOptions {
    readonly maxDepth?: number;
}

// A folder that vanished or cannot be read holds nothing for this walk, as `find 2>/dev/null` reads it.
const childrenOf = async (path: string): Promise<string[]> => {
    const names = await readdir(path).catch((_error: Error): string[] => []);
    return names.map((name) => join(path, name));
};

interface Folder {
    readonly path: string;
    readonly depth: number;
}

// One folder's entries told to `visit`, a batch of stats at a time; answers the subfolders to walk next, or "stop".
const visitChildren = async (folder: Folder, visit: Visit, dev: number): Promise<Folder[] | "stop"> => {
    const children = await childrenOf(folder.path);
    const deeper: Folder[] = [];
    for (let at = 0; at < children.length; at += STAT_BATCH) {
        const batch = children.slice(at, at + STAT_BATCH);
        const stats = await Promise.all(batch.map(async (path) => ({ path, stats: await lstatOf(path) })));
        for (const { path, stats: entry } of stats) {
            if (entry !== undefined && visit(path, entry, folder.depth + 1) === "stop") {
                return "stop";
            }
            if (entry?.isDirectory() === true && entry.dev === dev) {
                deeper.push({ path, depth: folder.depth + 1 });
            }
        }
    }
    return deeper;
};

// Each entry under `root`, `root` itself first; never across a mount, never through a link.
const walk = async (root: string, visit: Visit, options: WalkOptions = {}): Promise<void> => {
    const top = await lstatOf(root);
    if (top === undefined || visit(root, top, 0) === "stop" || !top.isDirectory()) {
        return;
    }
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const stack: Folder[] = [{ path: root, depth: 0 }];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
        if (next.depth >= maxDepth) {
            continue;
        }
        // one folder at a time keeps the walk's memory to one folder's names
        const deeper = await visitChildren(next, visit, top.dev);
        if (deeper === "stop") {
            return;
        }
        stack.push(...deeper);
    }
};

/** A tree's apparent size as `du -sxb` gives it: every entry's bytes, a hard-linked file once; 0 for one not there. */
export const bytesOf = async (root: string): Promise<number> => {
    let total = 0;
    const seen = new Set<number>();
    let dev: number | undefined;
    await walk(root, (_path, stats) => {
        dev ??= stats.dev;
        if (stats.dev !== dev) {
            return undefined;
        }
        if (stats.nlink > 1 && !stats.isDirectory()) {
            if (seen.has(stats.ino)) {
                return undefined;
            }
            seen.add(stats.ino);
        }
        total += stats.size;
        return undefined;
    });
    return total;
};

// `find -mtime +N`: a file whose age, in whole days, is more than N.
const olderThanDays = (stats: Stats, days: number, now: number): boolean => Math.floor((now - stats.mtimeMs) / DAY_MS) > days;

/** The files under `root` older than `days` (`find -type f -mtime +days`), with their sizes; `match` narrows by name. */
export const oldFiles = async (root: string, days: number, now: number, match: (name: string) => boolean = () => true): Promise<{ path: string; bytes: number }[]> => {
    const found: { path: string; bytes: number }[] = [];
    await walk(root, (path, stats) => {
        if (stats.isFile() && match(basename(path)) && olderThanDays(stats, days, now)) {
            found.push({ path, bytes: stats.size });
        }
        return undefined;
    });
    return found;
};

/** Whether anything at most `maxDepth` deep under `root`, `root` included, was written since `since` (`-newermt`). */
export const anyNewer = async (root: string, maxDepth: number, since: number): Promise<boolean> => {
    let found = false;
    await walk(
        root,
        (_path, stats) => {
            found = stats.mtimeMs > since;
            return found ? "stop" : undefined;
        },
        { maxDepth },
    );
    return found;
};

/** The newest mtime, in whole seconds, of anything at most `maxDepth` deep under `root` (0 for nothing). */
export const newestSeconds = async (root: string, maxDepth: number): Promise<number> => {
    let newest = 0;
    await walk(
        root,
        (_path, stats) => {
            newest = Math.max(newest, Math.floor(stats.mtimeMs / 1000));
            return undefined;
        },
        { maxDepth },
    );
    return newest;
};

/** Deletes the files named, then every empty folder under `root` deepest first (`find -mindepth 1 -type d -empty -delete`). */
/** Deletes the files named (`find … -delete`). */
export const deleteFiles = async (files: readonly string[]): Promise<void> => {
    for (const path of files) {
        // one unlink at a time: a runner's logs are hundreds of files, not a load worth spreading
        await unlink(path).catch(undefinedIfMissing);
    }
};

export const deleteFilesAndEmptyDirs = async (root: string, files: readonly string[]): Promise<void> => {
    await deleteFiles(files);
    const dirs: { path: string; depth: number }[] = [];
    await walk(root, (path, stats, depth) => {
        if (depth > 0 && stats.isDirectory()) {
            dirs.push({ path, depth });
        }
        return undefined;
    });
    for (const dir of dirs.toSorted((a, b) => b.depth - a.depth)) {
        // ENOTEMPTY is the answer for a folder that still holds something, so any failure leaves it
        await rmdir(dir.path).catch((_error: Error): undefined => undefined);
    }
};

// Whether two paths sit on one filesystem (`stat -c %d`).
export const sameFilesystem = async (a: string, b: string): Promise<boolean> => (await stat(a)).dev === ((await stat(b).catch(undefinedIfMissing)) ?? (await stat("/"))).dev;

// The link's target with every link on the way resolved (`readlink -f`), or undefined where it does not resolve.
export const resolved = async (path: string): Promise<string | undefined> => await realpath(path).catch((_error: Error): undefined => undefined);

/** How full a filesystem is, as `df` reads it: the percent used rounded up, and bytes used and free. */
export const diskUse = async (path: string): Promise<{ percent: number; used: number; free: number }> => {
    const fs = await statfs(path);
    const used = (fs.blocks - fs.bfree) * fs.bsize;
    const free = fs.bavail * fs.bsize;
    return { percent: used + free === 0 ? 0 : Math.ceil((used * 100) / (used + free)), used, free };
};

export const diskLine = async (path: string): Promise<string> => {
    const use = await diskUse(path);
    return `${gb(use.used)} GB used, ${gb(use.free)} GB free on ${path}`;
};

/* THE TRASH: a removal renames the tree into `<state>/trash` first, so its path disappears at once and a job that starts
   meanwhile never sees half of it; the trash is emptied at the start and the end of a pass (a pass killed midway left
   it behind, and it is garbage by definition). On another filesystem than the tree, the rename fails and the tree is
   removed in place. */
export interface Trash {
    readonly dir: string;
    readonly dryRun: boolean;
    // A rename's name in the trash must not repeat within a pass.
    serial: number;
}

export const emptyTrash = async (trash: Trash): Promise<void> => {
    await mkdir(trash.dir, { recursive: true });
    for (const name of await namesIn(trash.dir)) {
        // one tree at a time, as `rm -rf trash/*` takes them
        await rm(join(trash.dir, name), { recursive: true, force: true });
    }
};

export type Removal = { readonly removed: true; readonly bytes: number } | { readonly removed: false; readonly bytes: 0; readonly problem?: string };

/** Removes `path` through the trash (or, in a dry run, only measures it); a path not there removes nothing. */
export const removeTree = async (trash: Trash, path: string, now: number): Promise<Removal> => {
    if ((await lstatOf(path)) === undefined) {
        return { removed: false, bytes: 0 };
    }
    const bytes = await bytesOf(path);
    if (trash.dryRun) {
        return { removed: true, bytes };
    }
    trash.serial += 1;
    const into = join(trash.dir, `${now}${String(trash.serial).padStart(6, "0")}-${basename(path)}`);
    // A rename the trash cannot take (another filesystem) falls back to removing in place.
    const renamed = await rename(path, into).then(
        () => true,
        (_error: Error) => false,
    );
    const problem = renamed ? undefined : await rm(path, { recursive: true, force: true }).then(
        () => undefined,
        (error: Error) => errorMessage(error),
    );
    return problem === undefined ? { removed: true, bytes } : { removed: false, bytes: 0, problem };
};
