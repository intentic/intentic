import type { Dirent } from "node:fs";
import { readdir, readlink, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { mapPool } from "@intentic/base/async";
import {
    isLockedWorkspacePath,
    type WorkspaceChildren,
    type WorkspaceLink,
    type WorkspaceTree,
    type WorkspaceTreeEntry,
} from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope, toRelPath, walkMatchers } from "@intentic/workspace-ignore";
import { segmentsOf, within } from "./paths.js";

// The explorer's two reads over a folder on the user's disk, by the daemon's rules for /work
// (_sandbox/sandbox/src/workspace/files/workspace-tree.ts): breadth first under one entry budget, ignored folders listed
// but not opened, links listed as what they point at and opened only when they stay inside the folder, dirs before files
// then alphabetical. What the daemon adds for a workspace it keeps resident (a watched in-memory tree, the barren-folder
// scan) is left out: a folder here is read when someone looks at it.

// The eager walk's budget, the daemon's own: spent across the whole folder and re-spent on every refetch.
export const MAX_ENTRIES = 5000;

// One folder's own budget for the lazy listing, the daemon's own.
const MAX_CHILDREN = 50_000;

// Stats in flight at once while reading one folder, so a folder of ten thousand files queues rather than floods.
const STAT_POOL = 32;

const NOTHING_LISTED: WorkspaceChildren = { entries: [], hidden: 0 };

interface Entry {
    readonly name: string;
    readonly isDir: boolean;
    readonly real: string;
    readonly size?: number;
    // When the file last changed, epoch ms, off the same stat as its size.
    readonly mtime?: number;
    readonly link?: WorkspaceLink;
}

// allow(silent-catch): each of these reads failing is a fact about the entry (dangling, unreadable), which the entry says.
const quietly = <T>(read: Promise<T>): Promise<T | undefined> => read.catch(() => undefined);

// A link as the explorer shows it: what it points at, and whether that is somewhere this folder cannot open.
const linkOf = async (abs: string, name: string, root: string): Promise<Entry> => {
    const [target, to, real] = await Promise.all([quietly(stat(abs)), quietly(readlink(abs)), quietly(realpath(abs))]);
    if (target === undefined || real === undefined) {
        return { name, isDir: false, real: real ?? abs, link: { to: to ?? name, state: `broken` } };
    }
    const link: WorkspaceLink = within(root, real) ? { to: to ?? name } : { to: to ?? name, state: `outside` };
    return target.isDirectory()
        ? { name, isDir: true, real, link }
        : { name, isDir: false, real, size: target.size, mtime: Math.round(target.mtimeMs), link };
};

// One directory entry resolved: a plain folder costs nothing, a file one stat (its size and when it changed), a link its
// target's stat, text and real path, the last so a link back up the tree is not followed round.
const followEntry = async (dirent: Dirent, dirAbs: string, realDir: string, root: string): Promise<Entry> => {
    const name = dirent.name;
    const abs = join(dirAbs, name);
    if (dirent.isSymbolicLink()) {
        return linkOf(abs, name, root);
    }
    const real = join(realDir, name);
    if (dirent.isDirectory()) {
        return { name, isDir: true, real };
    }
    const found = await quietly(stat(abs));
    return found === undefined ? { name, isDir: false, real } : { name, isDir: false, real, size: found.size, mtime: Math.round(found.mtimeMs) };
};

const byKind = (a: Entry, b: Entry): number => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);

const entriesOf = async (dirAbs: string, realDir: string, root: string): Promise<Entry[] | undefined> => {
    const dirents = await quietly(readdir(dirAbs, { withFileTypes: true }));
    if (dirents === undefined) {
        return undefined;
    }
    const out: Entry[] = Array.from({ length: dirents.length });
    await mapPool(
        dirents.map((dirent, index) => ({ dirent, index })),
        STAT_POOL,
        async ({ dirent, index }) => {
            out[index] = await followEntry(dirent, dirAbs, realDir, root);
        },
    );
    return out.sort(byKind);
};

// A folder the walk may open: not one the sandbox locks, and not a link that goes nowhere, leaves the folder, or leads
// back to where it hangs from.
const opens = (entry: Entry, path: string, realDir: string): boolean =>
    entry.isDir &&
    !isLockedWorkspacePath(path) &&
    (entry.link === undefined || (entry.link.state === undefined && realDir !== entry.real && !realDir.startsWith(entry.real + sep)));

// Built mutably, its children filled in once the next level lists; returned as the readonly wire shape.
type Draft = {
    name: string;
    path: string;
    type: `file` | `dir`;
    size?: number;
    mtime?: number;
    ignored?: boolean;
    link?: WorkspaceLink;
    children?: Draft[];
};

const toEntry = (entry: Entry, path: string, ignored: boolean): Draft => {
    const draft: Draft = { name: entry.name, path, type: entry.isDir ? `dir` : `file` };
    if (entry.size !== undefined) {
        draft.size = entry.size;
    }
    if (entry.mtime !== undefined) {
        draft.mtime = entry.mtime;
    }
    if (ignored) {
        draft.ignored = true;
    }
    if (entry.link !== undefined) {
        draft.link = entry.link;
    }
    return draft;
};

// A folder to list: where it is on disk, what it really is, its path in the tree, and the ignore rules of its parent.
interface Job {
    readonly abs: string;
    readonly real: string;
    readonly rel: string;
    readonly scope: IgnoreScope;
}

// A folder's own ignore rules and its entries, or undefined when either cannot be read.
const listJob = async (job: Job, root: string): Promise<{ readonly scope: IgnoreScope; readonly entries: Entry[] } | undefined> => {
    // allow(silent-catch): a .gitignore that is there but unreadable leaves the folder's rules unknown, so nothing under it
    // lists, never with what it ignores shown as tracked (the daemon's rule, workspace-tree.ts).
    const scope = await job.scope.descend(job.abs, job.rel).catch(() => undefined);
    const entries = scope === undefined ? undefined : await entriesOf(job.abs, job.real, root);
    return scope === undefined || entries === undefined ? undefined : { scope, entries };
};

interface TreeJob extends Job {
    // The entry whose children this listing fills; the root's listing has none.
    readonly owner?: Draft;
}

// One folder of the eager walk listed into drafts, each folder among them it may open queued on `next`.
const draftsOf = (job: TreeJob, scope: IgnoreScope, kept: readonly Entry[], root: string, next: TreeJob[]): Draft[] =>
    kept.map((entry) => {
        const path = toRelPath(root, join(job.abs, entry.name));
        const ignored = scope.isIgnored(entry.name, path, entry.isDir);
        const draft = toEntry(entry, path, ignored);
        if (!ignored && opens(entry, path, job.real)) {
            next.push({ abs: join(job.abs, entry.name), real: entry.real, rel: path, scope, owner: draft });
        }
        return draft;
    });

// The whole folder as far as the budget reaches; a folder that will not fit what is left is deferred whole rather than
// half listed, and only the root's own cut is counted.
export const walkTree = async (root: string, maxEntries = MAX_ENTRIES): Promise<WorkspaceTree> => {
    const tree: Draft[] = [];
    let budget = maxEntries;
    let hidden = 0;
    let level: TreeJob[] = [{ abs: root, real: root, rel: ``, scope: createIgnoreScope(walkMatchers()) }];
    while (level.length > 0 && budget > 0) {
        const next: TreeJob[] = [];
        for (const job of level) {
            // Breadth first by design: a level lists before the next, under one budget.
            const listed = await listJob(job, root);
            if (listed === undefined) {
                if (job.owner !== undefined) {
                    job.owner.children = [];
                }
                continue;
            }
            if (job.owner !== undefined && listed.entries.length > budget) {
                continue;
            }
            const kept = listed.entries.slice(0, budget);
            budget -= kept.length;
            const children = draftsOf(job, listed.scope, kept, root, next);
            if (job.owner === undefined) {
                tree.push(...children);
                hidden = listed.entries.length - kept.length;
            } else {
                job.owner.children = children;
            }
        }
        level = next;
    }
    return { root, tree, hidden, barren: [] };
};

// The ignore rules in force at `segments` below the root, every folder's above it replayed in order, and whether one of
// those folders is itself ignored; undefined when a folder's rules on the way cannot be read.
export const scopeAt = async (
    root: string,
    segments: readonly string[],
): Promise<{ readonly scope: IgnoreScope; readonly ignored: boolean } | undefined> => {
    let scope = createIgnoreScope(walkMatchers());
    let ignored = false;
    let walked = root;
    let rel = ``;
    for (const segment of segments) {
        // allow(silent-catch): an ancestor's rules unknown, nothing under it lists, never with what it ignores shown as tracked.
        const descended = await scope.descend(walked, rel).catch(() => undefined);
        if (descended === undefined) {
            return undefined;
        }
        scope = descended;
        walked = join(walked, segment);
        rel = rel === `` ? segment : `${rel}/${segment}`;
        ignored = ignored || scope.isIgnored(segment, rel, true);
    }
    return { scope, ignored };
};

interface ChildJob extends Job {
    // Inside an ignored folder, so everything listed under it reads as ignored.
    readonly ignored: boolean;
    readonly level: number;
}

// The listing's first folder, `path` below the root, or undefined when it is not one this grant may list: outside the
// folder, locked, gone, or under rules that cannot be read.
const firstJob = async (root: string, path: string): Promise<ChildJob | undefined> => {
    const segments = segmentsOf(path);
    if (segments === undefined || isLockedWorkspacePath(path)) {
        return undefined;
    }
    const dir = join(root, ...segments);
    const realDir = await quietly(realpath(dir));
    const above = realDir === undefined || !within(root, realDir) ? undefined : await scopeAt(root, segments);
    return realDir === undefined || above === undefined
        ? undefined
        : { abs: dir, real: realDir, rel: segments.join(`/`), scope: above.scope, ignored: above.ignored, level: 1 };
};

// One folder's entries, down `depth` levels as one flat list, with the ignore rules of every folder above it replayed
// so an entry inside an ignored folder reads as ignored.
export const listChildren = async (root: string, path: string, depth = 1): Promise<WorkspaceChildren> => {
    const first = await firstJob(root, path);
    if (first === undefined) {
        return NOTHING_LISTED;
    }
    const entries: WorkspaceTreeEntry[] = [];
    let budget = MAX_CHILDREN;
    let hidden = 0;
    let level: ChildJob[] = [first];
    while (level.length > 0 && budget > 0) {
        const next: ChildJob[] = [];
        for (const job of level) {
            // One level at a time under one budget.
            const listed = await listJob(job, root);
            const kept = listed?.entries.slice(0, budget) ?? [];
            hidden += (listed?.entries.length ?? 0) - kept.length;
            budget -= kept.length;
            for (const entry of kept) {
                const entryPath = toRelPath(root, join(job.abs, entry.name));
                const ignored = job.ignored || listed?.scope.isIgnored(entry.name, entryPath, entry.isDir) === true;
                entries.push(toEntry(entry, entryPath, ignored));
                if (listed !== undefined && job.level < depth && opens(entry, entryPath, job.real)) {
                    next.push({
                        abs: join(job.abs, entry.name),
                        real: entry.real,
                        rel: entryPath,
                        scope: listed.scope,
                        ignored,
                        level: job.level + 1,
                    });
                }
            }
        }
        level = next;
    }
    return { entries, hidden };
};
