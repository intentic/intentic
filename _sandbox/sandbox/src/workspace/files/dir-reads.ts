import type { Dirent } from "node:fs";
import { realpathSync } from "node:fs";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mapPool } from "@intentic/base/async";
import { isMissing } from "@intentic/base/errors";
import type { WorkspaceLink } from "@intentic/sandbox-contract";
import { isUnder, realPathOf } from "./workspace-files-paths.js";

// What the workspace walks read of one directory, fresh or held between walks. The tree walk wants each entry followed
// (kind, size, link); the empty-folder scan wants only which entries are plain subdirectories. Both want the folder's
// own .gitignore, read only when the listing shows one.

// One directory entry with its symlink followed; isDir is the TARGET's kind, so a folder link expands like one.
// real is where the entry's bytes actually live; used for containment (link outside workspace) and the cycle guard.
// size is the file's, which the listing carries; a directory has none.
export interface Entry {
    readonly name: string;
    readonly isDir: boolean;
    readonly real: string;
    readonly size?: number;
    readonly link?: WorkspaceLink;
}

// A directory's size and .gitignore text (when it has one), and its entries followed on first ask, dirs before files
// then alphabetical: a walk that defers the folder for its size never pays a stat for it.
export interface DirListing {
    readonly size: number;
    readonly gitignore: string | undefined;
    readonly entries: () => Promise<readonly Entry[]>;
}

// A directory's plain subdirectories (a symlink is never one), how many entries are anything else, and its .gitignore.
export interface DirNames {
    readonly dirs: readonly string[];
    readonly others: number;
    readonly gitignore: string | undefined;
}

// undefined from either read means the directory could not be read, which is unknown, not empty.
export interface DirReads {
    readonly listing: (abs: string, real: string, realRoot: string) => Promise<DirListing | undefined>;
    readonly names: (abs: string) => Promise<DirNames | undefined>;
}

// Stats in flight at once while resolving one directory. Node's filesystem thread pool is four threads wide, so this is
// about queue depth, not parallelism: a folder of ten thousand files used to enqueue ten thousand stats in one go and
// every other read on the daemon — the file being opened, the diff being drawn — waited behind all of them.
const STAT_POOL = 64;

// Directory reads in flight at once for the empty-folder scan, whose recursion otherwise opens every branch together.
const NAMES_POOL = 16;

// Resolves one directory entry; a plain directory costs no syscall (dirent alone), a plain file one stat for its size.
// A symlink costs stat (kind and size; failure marks it dangling, still listed), readlink (display text), realpath
// (cycle guard).
const followEntry = async (dirent: Dirent, dirAbs: string, realDir: string, realRoot: string): Promise<Entry> => {
    const name = dirent.name;
    const abs = join(dirAbs, name);
    if (!dirent.isSymbolicLink()) {
        if (dirent.isDirectory()) {
            return { name, isDir: true, real: join(realDir, name) };
        }
        const stats = await stat(abs).catch(() => undefined);
        return { name, isDir: false, real: join(realDir, name), ...(stats === undefined ? {} : { size: stats.size }) };
    }
    const [target, to, real] = await Promise.all([stat(abs).catch(() => undefined), readlink(abs).catch(() => abs), realPathOf(abs)]);
    if (target === undefined) {
        return { name, isDir: false, real, link: { to, state: "broken" } };
    }
    const inside = isUnder(realRoot, real) !== undefined;
    return {
        name,
        isDir: target.isDirectory(),
        real,
        ...(target.isDirectory() ? {} : { size: target.size }),
        link: inside ? { to } : { to, state: "outside" },
    };
};

// Dirs before files, then alphabetical, on the followed kind.
export const byKind = (a: Entry, b: Entry): number => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);

// The size comes back with the entry rather than being stat'd again one at a time by the callers: on a workspace of a
// few thousand files that is the difference between a listing the browser waits a second for and one it waits a moment
// for. Pooled, and written back by index, then sorted by kind.
export const followEntries = async (dirAbs: string, realDir: string, realRoot: string, dirents: readonly Dirent[]): Promise<Entry[]> => {
    const out: Entry[] = Array.from({ length: dirents.length });
    await mapPool(
        dirents.map((dirent, index) => ({ dirent, index })),
        STAT_POOL,
        async ({ dirent, index }) => {
            out[index] = await followEntry(dirent, dirAbs, realDir, realRoot);
        },
    );
    return out.sort(byKind);
};

// A .gitignore that is there but cannot be read leaves the folder's rules unknown, so the whole read is unknown: listed
// without them, what it ignores would show as tracked and be offered for deletion.
const UNREADABLE = Symbol(`unreadable .gitignore`);
const gitignoreOf = (abs: string, dirents: readonly Dirent[]): Promise<string | undefined | typeof UNREADABLE> =>
    dirents.some((dirent) => dirent.name === ".gitignore" && !dirent.isDirectory())
        ? readFile(join(abs, ".gitignore"), "utf8").then(
              (text) => text,
              (error: unknown) => (isMissing(error) ? undefined : UNREADABLE),
          )
        : Promise.resolve(undefined);

const readListing = async (abs: string, real: string, realRoot: string): Promise<DirListing | undefined> => {
    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => undefined);
    if (dirents === undefined) {
        return undefined;
    }
    const gitignore = await gitignoreOf(abs, dirents);
    if (gitignore === UNREADABLE) {
        return undefined;
    }
    let followed: Promise<Entry[]> | undefined;
    return {
        size: dirents.length,
        gitignore,
        entries: () => {
            followed ??= followEntries(abs, real, realRoot, dirents);
            return followed;
        },
    };
};

const readNames = async (abs: string): Promise<DirNames | undefined> => {
    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => undefined);
    if (dirents === undefined) {
        return undefined;
    }
    const gitignore = await gitignoreOf(abs, dirents);
    if (gitignore === UNREADABLE) {
        return undefined;
    }
    const dirs = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
    return { dirs, others: dirents.length - dirs.length, gitignore };
};

// Runs at most `size` tasks at once, the rest queued in arrival order; a finishing task hands its slot to the next.
const pool = (size: number): (<T>(task: () => Promise<T>) => Promise<T>) => {
    let running = 0;
    const waiting: (() => void)[] = [];
    return async (task) => {
        if (running >= size) {
            await new Promise<void>((admit) => waiting.push(admit));
        } else {
            running += 1;
        }
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            if (next === undefined) {
                running -= 1;
            } else {
                next();
            }
        }
    };
};

// Every read straight from disk: for a root no watcher reports on, where nothing held could be known to be current.
export const freshDirReads = (): DirReads => {
    const limit = pool(NAMES_POOL);
    return { listing: readListing, names: (abs) => limit(() => readNames(abs)) };
};

// Milliseconds a held read stands with no watcher event about it: a folder made under a name the watcher ignores
// (node_modules, dist) sends none, so this is how late such a folder may show.
const HELD_MS = 10_000;

export interface HeldDirReads extends DirReads {
    // Root-relative paths the watcher saw change; empty means an unnamed change, which drops everything held.
    readonly changed: (relPaths: readonly string[]) => void;
}

// Reads held between walks of one watched root; a changed path drops the folder holding it and its own listing.
export const heldDirReads = (root: string, now: () => number = Date.now): HeldDirReads => {
    const base = resolve(root);
    let realBase = base;
    try {
        realBase = realpathSync(base);
    } catch {
        // An unresolvable root still walks by its own name; the watcher's paths then land on that name too.
    }
    type Held = { readonly at: number; listing?: Promise<DirListing | undefined>; names?: Promise<DirNames | undefined> };
    const held = new Map<string, Held>();
    const limit = pool(NAMES_POOL);
    let swept = now();
    const slot = (key: string): Held => {
        const current = held.get(key);
        if (current !== undefined && now() - current.at <= HELD_MS) {
            return current;
        }
        const fresh: Held = { at: now() };
        held.set(key, fresh);
        return fresh;
    };
    const drop = (abs: string): void => {
        held.delete(abs);
        held.delete(dirname(abs));
    };
    return {
        listing: (abs, real, realRoot) => {
            const at = slot(real);
            at.listing ??= readListing(abs, real, realRoot);
            return at.listing;
        },
        names: (abs) => {
            const at = slot(abs);
            at.names ??= limit(() => readNames(abs));
            return at.names;
        },
        changed: (relPaths) => {
            if (relPaths.length === 0) {
                held.clear();
                return;
            }
            for (const rel of relPaths) {
                drop(join(base, rel));
                drop(join(realBase, rel));
            }
            // A folder that vanished is never asked for again; its read would otherwise sit here for good.
            if (now() - swept > HELD_MS) {
                swept = now();
                for (const [key, entry] of held) {
                    if (swept - entry.at > HELD_MS) {
                        held.delete(key);
                    }
                }
            }
        },
    };
};
