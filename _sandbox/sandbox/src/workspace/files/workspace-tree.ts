import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isLockedWorkspacePath, type WorkspaceChildren, type WorkspaceLink, type WorkspaceTree, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope, NO_IGNORES, toRelPath } from "@intentic/workspace-ignore";
import { type DirReads, type Entry, followEntries, freshDirReads } from "./dir-reads.js";
import { scanBarrenDirs } from "./empty-dirs.js";
import { realPathOf, realWithin, resolveWithin } from "./workspace-files-paths.js";

// WorkspaceTree/WorkspaceTreeEntry is the /workspace/tree wire shape (sandbox-contract); `path` is root-relative with
// forward slashes.
// Ignore rules come from @intentic/workspace-ignore, shared with the content-search walk; ignored dirs list but aren't
// descended (lazy-load via listWorkspaceChildren).
// Symlinks are listed as what they point at.

// The eager walk's budget, spent across the WHOLE workspace and re-spent on every refetch, so it stays tight.
export const MAX_ENTRIES = 5000;

// One folder's own budget, for the lazy listing. Far larger than the walk's: this is one directory, asked for once when
// someone opens it, and the views that draw it window their rows, so the count no longer decides what rendering costs.
// A folder of several thousand artifacts is an ordinary thing to open, and answering "and 1,723 more" to it is not.
const MAX_CHILDREN = 50_000;

// Whether this entry may be descended into: a link that goes nowhere or leaves the workspace has nothing to serve.
// A link whose target is this dir or an ancestor is a cycle; two links to the same subtree are not, both are listed.
export const descendable = (entry: Entry, realDir: string): boolean =>
    entry.link === undefined || (entry.link.state === undefined && realDir !== entry.real && !realDir.startsWith(entry.real + sep));

// Breadth-first, bounded by an entry budget: shallow levels complete; a dir that won't fit defers whole, not
// half-listed.
// Only the root drops entries past budget, counted as `hidden`. Depth is unbounded; symlinks list as their target.
// `reads` is where directories come from: straight from disk unless the caller holds reads a watcher keeps current.
export const walkWorkspaceTree = async (root: string, options?: { maxEntries?: number; reads?: DirReads }): Promise<WorkspaceTree> => {
    const base = resolve(root);
    const reads = options?.reads ?? freshDirReads();
    // Runs alongside the listing; can't be derived from it since budget-cut dirs are unknown, not empty.
    const barren = scanBarrenDirs(base, { reads }).catch((): string[] => []);
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
    let level: Job[] = [{ abs: base, real: realRoot, rel: "", parentScope: createIgnoreScope(reads.matchers) }];

    while (level.length > 0 && budget > 0) {
        const next: Job[] = [];
        for (const job of level) {
            if (budget <= 0) {
                break;
            }
            const listing = await reads.listing(job.abs, job.real, realRoot);
            if (listing === undefined) {
                if (job.owner !== undefined) {
                    job.owner.children = [];
                }
                continue;
            }
            // Defers a dir that won't fit the remaining budget instead of half-listing it.
            if (job.owner !== undefined && listing.size > budget) {
                continue;
            }
            const listable = await listing.entries();
            // Layers this directory's own .gitignore before its entries are tested.
            const scope = job.parentScope.layer(job.rel, listing.gitignore);

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
                    children.push({
                        name: entry.name,
                        path,
                        type: "file",
                        ...(entry.size === undefined ? {} : { size: entry.size }),
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

// Where a listing's ignore state starts. ignoreRules:false admits everything, for a tree that is an archive's contents
// rather than a project.
const startingScope = (options: { ignoreRules?: boolean } | undefined): IgnoreScope =>
    options?.ignoreRules === false ? NO_IGNORES : createIgnoreScope();

// Lazily lists one directory's children (ignored, or past budget); depth 1 by default, as one flat list.
// Ignore state is rebuilt from the root; relPath is checked lexically and on disk (realWithin catches a link escape).
// ignoreRules:false lists everything: inside an unpacked archive a .gitignore is the archive's own content, and must
// not hide its siblings from the person who opened it.
export const listWorkspaceChildren = async (
    root: string,
    relPath: string,
    options?: { maxEntries?: number; depth?: number; ignoreRules?: boolean },
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
    let parentScope = startingScope(options);
    let branchIgnored = false;
    let walked = base;
    let rel = "";
    for (const segment of relPath.split("/").filter((part) => part !== "" && part !== ".")) {
        try {
            parentScope = await parentScope.descend(walked, rel);
        } catch {
            // An ancestor's rules unknown, nothing under it lists, never with what it ignores shown as tracked.
            return { entries: [], hidden: 0 };
        }
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
    let budget = options?.maxEntries ?? MAX_CHILDREN;
    const entries: WorkspaceTreeEntry[] = [];
    let hidden = 0;
    let level: Job[] = [{ abs: dir, real: realDir, rel: relPath, parentScope, branchIgnored, level: 1 }];

    while (level.length > 0 && budget > 0) {
        const next: Job[] = [];
        for (const job of level) {
            if (budget <= 0) {
                break;
            }
            let scope: IgnoreScope;
            try {
                scope = await job.parentScope.descend(job.abs, job.rel);
            } catch {
                // Its rules unknown, the directory is skipped like an unreadable one.
                continue;
            }
            const dirents = await readdir(job.abs, { withFileTypes: true }).catch(() => undefined);
            if (dirents === undefined) {
                continue;
            }
            const listable = await followEntries(job.abs, job.real, realRoot, dirents);
            const included = listable.slice(0, budget);
            hidden += listable.length - included.length;

            for (const entry of included) {
                budget--;
                const abs = join(job.abs, entry.name);
                const path = toRelPath(base, abs);
                const ignored = job.branchIgnored || scope.isIgnored(entry.name, path, entry.isDir);
                const link = entry.link === undefined ? {} : { link: entry.link };
                if (!entry.isDir) {
                    entries.push({
                        name: entry.name,
                        path,
                        type: "file",
                        ...(entry.size === undefined ? {} : { size: entry.size }),
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
