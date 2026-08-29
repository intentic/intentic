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
import { isUnder, realPathOf, realWithin, resolveWithin } from "./workspace-files.js";

// WorkspaceTree / WorkspaceTreeEntry (the full /work tree the agent sees, untracked files, generated
// artifacts, and .intentic/ included, distinct from the git-tracked listing) are the /workspace/tree wire
// shape, so they live in @intentic/sandbox-contract. `path` is root-relative with forward slashes so it feeds
// straight back to the file route. What's "ignored" (junk dirs, .gitignore, browser profiles) lives in
// @intentic/workspace-ignore, shared with the content-search walk so both views agree. Ignored entries are still
// listed (`ignored: true` → the client grays them); ignored DIRECTORIES aren't descended into, their children
// lazy-load via listWorkspaceChildren so a giant node_modules can't blow the entry cap.
//
// SYMLINKS are listed, as what they point AT (see Entry below). They used to be filtered out of every listing,
// which meant a folder holding only links drew as an empty folder, `/work/.claude/skills`, thirty of them,
// looked like nothing was there.

const MAX_ENTRIES = 5000;

/* ONE DIRECTORY ENTRY, WITH ITS SYMLINKS ALREADY FOLLOWED.
 *
 * A symlink used to be dropped from every listing, which is why `/work/.claude/skills`, thirty links and
 * nothing else, drew as an empty folder. It is listed now, and it is listed AS WHAT IT POINTS AT: `isDir` is
 * the TARGET's kind, so a link to a folder expands and a link to a file opens, with `link` carried alongside as
 * decoration. That is VSCode's model exactly (FileType.SymbolicLink is a bit ORed onto File/Directory, so every
 * consumer can keep asking the same "file or folder?" question), and it is why nothing downstream of here, the
 * ignore rules, the nesting, the viewer, the tabs, needed to learn a third kind of entry.
 *
 * `real` is where the entry's bytes actually are, and it exists for two jobs neither of which the link's own
 * path can do: containment (a link out of the workspace is listed but never followed) and the cycle guard. */
interface Entry {
    readonly name: string;
    readonly isDir: boolean;
    readonly real: string;
    readonly link?: WorkspaceLink;
}

/* Follow one directory's entries. A plain entry answers from the dirent alone, no syscall, which is what keeps
 * an ordinary tree exactly as cheap to walk as before. A LINK costs three: stat for the target's kind (failure
 * ⇒ dangling, and dangling is listed rather than hidden, a broken link is a fact about the workspace worth
 * seeing), readlink for the text to show on hover, and realpath for containment and the cycle guard.
 * `realDir` is the containing directory's own real path, so a plain child's real path is free. */
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

// Dirs before files, then alphabetical, on the FOLLOWED kind, so a link to a folder sorts with the folders.
const byKind = (a: Entry, b: Entry): number => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);

/* Is this entry one the walk may descend into? A link is where the two new answers live:
 *   - it goes nowhere, or it goes outside the workspace ⇒ there is nothing here the daemon will serve;
 *   - its target IS this directory or one above it ⇒ descending would walk the same tree forever.
 * The ancestor test is the whole cycle guard, and it costs nothing: every job already carries its real path,
 * so `a/link -> a` is caught before the first bogus level rather than after it. (Two links to the same subtree
 * are NOT a cycle, they are two real places to look, and both are listed, exactly as VSCode does.) */
const descendable = (entry: Entry, realDir: string): boolean =>
    entry.link === undefined || (entry.link.state === undefined && realDir !== entry.real && !realDir.startsWith(entry.real + sep));

// Walk the real working tree under `root`, bounded by a total-entry budget so a pathological tree can't blow up
// the response. The walk is LEVEL-ORDER (breadth-first), which is what makes the budget honest: a single deep
// branch can no longer eat it and leave the user's top-level folders missing. Shallow levels, the ones the
// collapsed explorer actually shows, always complete; the budget runs out at depth, and a directory the walk
// never reached is returned WITHOUT `children`, exactly like an ignored dir, so the client lazy-loads it via
// listWorkspaceChildren on expand, and a dir that doesn't fit what's left of the budget is deferred whole
// rather than half-listed, so every listing the client receives is COMPLETE. That leaves exactly one way for
// entries to go missing, a single directory holding more than the entire cap, and the response reports that
// as a count (`hidden`), so the UI can name the number instead of vaguely hinting at one.
// Depth is unbounded, symlinks are listed as what they point at (see Entry above), dirs sort before files
// alphabetically.
export const walkWorkspaceTree = async (root: string, options?: { maxEntries?: number }): Promise<WorkspaceTree> => {
    const base = resolve(root);
    // The root resolved ONCE, on the hosted VM /work is itself a link onto the persistent volume, so every
    // containment test below has to be made against where the workspace really is.
    const realRoot = await realPathOf(base);
    let budget = options?.maxEntries ?? MAX_ENTRIES;

    // Built mutably (`children` is filled in when the level below is listed), returned as the readonly shape.
    type Draft = {
        name: string;
        path: string;
        type: "file" | "dir";
        size?: number;
        ignored?: boolean;
        link?: WorkspaceLink;
        children?: Draft[];
    };
    // One directory still to list. `parentScope` is the ignore state of the dir CONTAINING it; `owner` is the
    // entry whose `children` this listing fills (absent for the root itself); `real` is where this directory
    // actually is, which is what the cycle guard compares a link's target against.
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
            // Pick up this directory's own .gitignore before testing its entries.
            const scope = await job.parentScope.descend(job.abs, job.rel);
            const dirents = await readdir(job.abs, { withFileTypes: true }).catch(() => undefined);
            if (dirents === undefined) {
                if (job.owner !== undefined) {
                    job.owner.children = [];
                }
                continue;
            }
            // A dir that doesn't fit what's left is left UNLISTED rather than half-listed: every listing the
            // client gets is then complete, and this one arrives whole on expand. (The root has no such out,
            // it has nowhere to lazy-load from, so it lists what fits and reports the rest as `hidden`.)
            // Asked of the raw count, BEFORE following anything: a directory the walk is about to defer should
            // not first pay a stat for each of its links.
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
                // Ignored dirs are never descended; neither are the daemon's own (auth/, sessions/, browser/,
                // the root .git, isLockedWorkspacePath), whose every file the file API refuses anyway: the
                // explorer draws them as one locked row, so listing what is inside would spend the walk's
                // budget, thousands of entries, in the browser-profile case, on rows nobody can open. Nor
                // is a link that leaves the workspace or loops back on itself (descendable). The rest queue
                // for the next level and stay unlisted (no `children`) if the budget runs out first, either
                // way the client lazy-loads them.
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

    return { root: base, tree, hidden: rootHidden };
};

// Lazy-load one directory's children, a dir the tree walk listed but didn't descend into (ignored, or beyond
// the walk's entry budget). Child DIRS again carry no `children` (they lazy-load on their own expand). Ignore
// state is rebuilt by descending from the root so a lazily-listed dir agrees with the eager walk: entries under
// an ignored subtree stay ignored, entries under a normal one are graded by the real .gitignore layers.
// Bounded by the same entry cap → `hidden`. Symlinks are listed as what they point at, dirs first. One level
// only, so a cycle is bounded by the clicking rather than by a guard, the same thing that makes VSCode's
// lazily-resolved explorer safe against one.
//
// `relPath` is contained twice: lexically (resolveWithin, a path climbing out of /work) and on disk
// (realWithin, a path that gets out through a LINK), the second is what stops an expand on a link pointing
// outside the workspace from listing what is behind it.
export const listWorkspaceChildren = async (root: string, relPath: string, options?: { maxEntries?: number }): Promise<WorkspaceChildren> => {
    const base = resolve(root);
    const dir = resolveWithin(base, relPath);
    if (dir === undefined) {
        return { entries: [], hidden: 0 };
    }
    const realDir = await realWithin(base, dir);
    if (realDir === undefined) {
        return { entries: [], hidden: 0 };
    }
    // The eager walk stops at a locked dir and the explorer never offers to expand one, so an ask for its
    // contents is either a stale client or a probe. Empty, like the walk's own answer, the file API refuses
    // every path inside it regardless, so a listing would only be an index of what cannot be opened.
    if (isLockedWorkspacePath(relPath)) {
        return { entries: [], hidden: 0 };
    }
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (dirents === undefined) {
        return { entries: [], hidden: 0 };
    }

    // Replay the ancestor chain: each descend() layers that directory's .gitignore, and an ancestor that is
    // itself ignored makes the whole branch ignored no matter what the local rules say.
    let scope = createIgnoreScope();
    let branchIgnored = false;
    let walked = base;
    let rel = "";
    for (const segment of relPath.split("/").filter((part) => part !== "" && part !== ".")) {
        scope = await scope.descend(walked, rel);
        walked = join(walked, segment);
        rel = rel === "" ? segment : `${rel}/${segment}`;
        branchIgnored = branchIgnored || scope.isIgnored(segment, rel, true);
    }
    scope = await scope.descend(walked, rel);

    const listable = await followEntries(dir, realDir, await realPathOf(base), dirents);
    listable.sort(byKind);

    const entries: WorkspaceTreeEntry[] = [];
    for (const entry of listable.slice(0, options?.maxEntries ?? MAX_ENTRIES)) {
        const { name, isDir } = entry;
        const abs = join(dir, name);
        const path = toRelPath(base, abs);
        const ignored = branchIgnored || scope.isIgnored(name, path, isDir);
        const link = entry.link === undefined ? {} : { link: entry.link };
        if (isDir) {
            entries.push({ name, path, type: "dir", ...(ignored ? { ignored: true } : {}), ...link });
            continue;
        }
        let size: number | undefined;
        try {
            size = (await stat(abs)).size;
        } catch {
            size = undefined;
        }
        entries.push({ name, path, type: "file", ...(size !== undefined ? { size } : {}), ...(ignored ? { ignored: true } : {}), ...link });
    }
    return { entries, hidden: listable.length - entries.length };
};
