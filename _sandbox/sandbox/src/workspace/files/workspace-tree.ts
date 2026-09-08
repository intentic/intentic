import type { Dirent } from "node:fs";
import { readdir, readlink, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
    isLockedWorkspacePath,
    type WorkspaceChildren,
    type WorkspaceLink,
    type WorkspaceTree,
    type WorkspaceTreeEntry,
} from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope, toRelPath } from "@intentic/workspace-ignore";
import { scanBarrenDirs } from "./empty-dirs.js";
import { isUnder, realPathOf, realWithin, resolveWithin } from "./workspace-files-paths.js";

// WorkspaceTree/WorkspaceTreeEntry is the /workspace/tree wire shape (sandbox-contract); `path` is root-relative with
// forward slashes.
// Ignore rules come from @intentic/workspace-ignore, shared with the content-search walk; ignored dirs list but aren't
// descended (lazy-load via listWorkspaceChildren).
// Symlinks are listed as what they point at.

const MAX_ENTRIES = 5000;

// One directory entry with its symlink followed; isDir is the TARGET's kind, so a folder link expands like one.
// real is where the entry's bytes actually live; used for containment (link outside workspace) and the cycle guard.
interface Entry {
    readonly name: string;
    readonly isDir: boolean;
    readonly real: string;
    readonly link?: WorkspaceLink;
}

// Resolves one directory's entries; a plain entry costs no syscall (dirent alone).
// A symlink costs stat (kind; failure marks it dangling, still listed), readlink (display text), realpath (cycle
// guard).
const followEntries = async (dirAbs: string, realDir: string, realRoot: string, dirents: readonly Dirent[]): Promise<Entry[]> =>
    Promise.all(
        dirents.map(async (dirent): Promise<Entry> => {
            const name = dirent.name;
            if (!dirent.isSymbolicLink()) {
                return { name, isDir: dirent.isDirectory(), real: join(realDir, name) };
            }
            const abs = join(dirAbs, name);
            const [target, to, real] = await Promise.all([stat(abs).catch(() => undefined), readlink(abs).catch(() => abs), realPathOf(abs)]);
            if (target === undefined) {
                return { name, isDir: false, real, link: { to, state: "broken" } };
            }
            const inside = isUnder(realRoot, real) !== undefined;
            return { name, isDir: target.isDirectory(), real, link: inside ? { to } : { to, state: "outside" } };
        }),
    );

// Dirs before files, then alphabetical, on the followed kind.
const byKind = (a: Entry, b: Entry): number => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);

// Whether this entry may be descended into: a link that goes nowhere or leaves the workspace has nothing to serve.
// A link whose target is this dir or an ancestor is a cycle; two links to the same subtree are not, both are listed.
const descendable = (entry: Entry, realDir: string): boolean =>
    entry.link === undefined || (entry.link.state === undefined && realDir !== entry.real && !realDir.startsWith(entry.real + sep));

// Breadth-first, bounded by an entry budget: shallow levels complete; a dir that won't fit defers whole, not
// half-listed.
// Only the root drops entries past budget, counted as `hidden`. Depth is unbounded; symlinks list as their target.
export const walkWorkspaceTree = async (root: string, options?: { maxEntries?: number }): Promise<WorkspaceTree> => {
    const base = resolve(root);
    // Runs alongside the listing; can't be derived from it since budget-cut dirs are unknown, not empty.
    const barren = scanBarrenDirs(base).catch((): string[] => []);
    // Resolved once: /work may itself be a symlink, so containment below compares against the real root.
    const realRoot = await realPathOf(base);
    let budget = options?.maxEntries ?? MAX_ENTRIES;

    // Built mutably (children filled in once its level lists); returned as the readonly WorkspaceTree shape.
    type Draft = {
        name: string;
        path: string;
        type: "file" | "dir";
        size?: number;
        ignored?: boolean;
        link?: WorkspaceLink;
        children?: Draft[];
    };
    // One dir still to list; parentScope is the container's ignore state, owner the draft entry this fills (absent for
    // root).
    // real is where this directory actually is, compared against a link's target by the cycle guard.
    type Job = {
        abs: string;
        real: string;
        rel: string;
        parentScope: IgnoreScope;
        owner?: Draft;
    };

    const tree: Draft[] = [];
    let rootHidden = 0;
    let level: Job[] = [{ abs: base, real: realRoot, rel: "", parentScope: createIgnoreScope() }];

    while (level.length > 0 && budget > 0) {
        const next: Job[] = [];
        for (const job of level) {
            if (budget <= 0) {
                break;
            }
            // Layers this directory's own .gitignore before its entries are tested.
            const scope = await job.parentScope.descend(job.abs, job.rel);
            const dirents = await readdir(job.abs, { withFileTypes: true }).catch(() => undefined);
            if (dirents === undefined) {
                if (job.owner !== undefined) {
                    job.owner.children = [];
                }
                continue;
            }
            // Defers a dir that won't fit the remaining budget instead of half-listing it.
            if (job.owner !== undefined && dirents.length > budget) {
                continue;
            }
            const listable = await followEntries(job.abs, job.real, realRoot, dirents);
            listable.sort(byKind);

            const children: Draft[] = [];
            for (const entry of listable) {
                if (budget <= 0) {
                    break;
                }
                budget--;
                const abs = join(job.abs, entry.name);
                const path = toRelPath(base, abs);
                const ignored = scope.isIgnored(entry.name, path, entry.isDir);
                const link = entry.link === undefined ? {} : { link: entry.link };
                if (!entry.isDir) {
                    const stats = await stat(abs).catch(() => undefined);
                    children.push({
                        name: entry.name,
                        path,
                        type: "file",
                        ...(stats !== undefined ? { size: stats.size } : {}),
                        ...(ignored ? { ignored: true } : {}),
                        ...link,
                    });
                    continue;
                }
                const draft: Draft = { name: entry.name, path, type: "dir", ...(ignored ? { ignored: true } : {}), ...link };
                children.push(draft);
                // Not queued for the next level: ignored dirs, locked paths, and non-descendable links (cycle or
                // outside).
                if (!ignored && !isLockedWorkspacePath(path) && descendable(entry, job.real)) {
                    next.push({ abs, real: entry.real, rel: path, parentScope: scope, owner: draft });
                }
            }
            if (job.owner === undefined) {
                tree.push(...children);
                rootHidden = listable.length - children.length;
                continue;
            }
            job.owner.children = children;
        }
        level = next;
    }

    return { root: base, tree, hidden: rootHidden, barren: await barren };
};

// Lazily lists one directory's children (ignored, or past budget); depth 1 by default, as one flat list.
// Ignore state is rebuilt from the root; relPath is checked lexically and on disk (realWithin catches a link escape).
export const listWorkspaceChildren = async (
    root: string,
    relPath: string,
    options?: { maxEntries?: number; depth?: number },
): Promise<WorkspaceChildren> => {
    const base = resolve(root);
    const dir = resolveWithin(base, relPath);
    if (dir === undefined) {
        return { entries: [], hidden: 0 };
    }
    const realDir = await realWithin(base, dir);
    if (realDir === undefined) {
        return { entries: [], hidden: 0 };
    }
    // The explorer never offers to expand a locked dir; an ask here is a stale client or a probe.
    if (isLockedWorkspacePath(relPath)) {
        return { entries: [], hidden: 0 };
    }
    // Replays the ancestor chain: each descend() layers a .gitignore; an ignored ancestor ignores the whole branch.
    let parentScope = createIgnoreScope();
    let branchIgnored = false;
    let walked = base;
    let rel = "";
    for (const segment of relPath.split("/").filter((part) => part !== "" && part !== ".")) {
        parentScope = await parentScope.descend(walked, rel);
        walked = join(walked, segment);
        rel = rel === "" ? segment : `${rel}/${segment}`;
        branchIgnored = branchIgnored || parentScope.isIgnored(segment, rel, true);
    }

    type Job = {
        readonly abs: string;
        readonly real: string;
        readonly rel: string;
        readonly parentScope: IgnoreScope;
        readonly branchIgnored: boolean;
        readonly level: number;
    };

    const realRoot = await realPathOf(base);
    const depth = options?.depth ?? 1;
    let budget = options?.maxEntries ?? MAX_ENTRIES;
    const entries: WorkspaceTreeEntry[] = [];
    let hidden = 0;
    let level: Job[] = [{ abs: dir, real: realDir, rel: relPath, parentScope, branchIgnored, level: 1 }];

    while (level.length > 0 && budget > 0) {
        const next: Job[] = [];
        for (const job of level) {
            if (budget <= 0) {
                break;
            }
            const scope = await job.parentScope.descend(job.abs, job.rel);
            const dirents = await readdir(job.abs, { withFileTypes: true }).catch(() => undefined);
            if (dirents === undefined) {
                continue;
            }
            const listable = await followEntries(job.abs, job.real, realRoot, dirents);
            listable.sort(byKind);
            const included = listable.slice(0, budget);
            hidden += listable.length - included.length;

            for (const entry of included) {
                budget--;
                const abs = join(job.abs, entry.name);
                const path = toRelPath(base, abs);
                const ignored = job.branchIgnored || scope.isIgnored(entry.name, path, entry.isDir);
                const link = entry.link === undefined ? {} : { link: entry.link };
                if (!entry.isDir) {
                    const stats = await stat(abs).catch(() => undefined);
                    entries.push({
                        name: entry.name,
                        path,
                        type: "file",
                        ...(stats !== undefined ? { size: stats.size } : {}),
                        ...(ignored ? { ignored: true } : {}),
                        ...link,
                    });
                    continue;
                }
                entries.push({ name: entry.name, path, type: "dir", ...(ignored ? { ignored: true } : {}), ...link });
                if (job.level < depth && !isLockedWorkspacePath(path) && descendable(entry, job.real)) {
                    next.push({ abs, real: entry.real, rel: path, parentScope: scope, branchIgnored: ignored, level: job.level + 1 });
                }
            }
        }
        level = next;
    }
    return { entries, hidden };
};
