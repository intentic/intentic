import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isLockedWorkspacePath, type WorkspaceChildren, type WorkspaceTree, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope, toRelPath } from "@intentic/workspace-ignore";
import { resolveWithin } from "./workspace-files.js";

// WorkspaceTree / WorkspaceTreeEntry (the full /work tree the agent sees — untracked files, generated
// artifacts, and .intentic/ included, distinct from the git-tracked listing) are the /workspace/tree wire
// shape, so they live in @intentic/sandbox-contract. `path` is root-relative with forward slashes so it feeds
// straight back to the file route. What's "ignored" (junk dirs, .gitignore, browser profiles) lives in
// @intentic/workspace-ignore, shared with the content-search walk so both views agree. Ignored entries are still
// listed (`ignored: true` → the client grays them); ignored DIRECTORIES aren't descended into — their children
// lazy-load via listWorkspaceChildren so a giant node_modules can't blow the entry cap.

const MAX_ENTRIES = 5000;

// Walk the real working tree under `root`, bounded by a total-entry budget so a pathological tree can't blow up
// the response. The walk is LEVEL-ORDER (breadth-first), which is what makes the budget honest: a single deep
// branch can no longer eat it and leave the user's top-level folders missing. Shallow levels — the ones the
// collapsed explorer actually shows — always complete; the budget runs out at depth, and a directory the walk
// never reached is returned WITHOUT `children`, exactly like an ignored dir, so the client lazy-loads it via
// listWorkspaceChildren on expand — and a dir that doesn't fit what's left of the budget is deferred whole
// rather than half-listed, so every listing the client receives is COMPLETE. That leaves exactly one way for
// entries to go missing — a single directory holding more than the entire cap — and the response reports that
// as a count (`hidden`), so the UI can name the number instead of vaguely hinting at one.
// Depth is unbounded, symlinks are skipped (not followed, not listed), dirs sort before files alphabetically.
export const walkWorkspaceTree = async (root: string, options?: { maxEntries?: number }): Promise<WorkspaceTree> => {
    const base = resolve(root);
    let budget = options?.maxEntries ?? MAX_ENTRIES;

    // Built mutably (`children` is filled in when the level below is listed), returned as the readonly shape.
    type Draft = {
        name: string;
        path: string;
        type: "file" | "dir";
        size?: number;
        ignored?: boolean;
        children?: Draft[];
    };
    // One directory still to list. `parentScope` is the ignore state of the dir CONTAINING it; `owner` is the
    // entry whose `children` this listing fills (absent for the root itself).
    type Job = {
        abs: string;
        rel: string;
        parentScope: IgnoreScope;
        owner?: Draft;
    };

    const tree: Draft[] = [];
    let rootHidden = 0;
    let level: Job[] = [{ abs: base, rel: "", parentScope: createIgnoreScope() }];

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
            const listable = dirents.filter((dirent) => !dirent.isSymbolicLink());
            listable.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
            // A dir that doesn't fit what's left is left UNLISTED rather than half-listed: every listing the
            // client gets is then complete, and this one arrives whole on expand. (The root has no such out —
            // it has nowhere to lazy-load from — so it lists what fits and reports the rest as `hidden`.)
            if (job.owner !== undefined && listable.length > budget) {
                continue;
            }

            const children: Draft[] = [];
            for (const dirent of listable) {
                if (budget <= 0) {
                    break;
                }
                budget--;
                const isDir = dirent.isDirectory();
                const abs = join(job.abs, dirent.name);
                const path = toRelPath(base, abs);
                const ignored = scope.isIgnored(dirent.name, path, isDir);
                if (isDir) {
                    const entry: Draft = { name: dirent.name, path, type: "dir", ...(ignored ? { ignored: true } : {}) };
                    children.push(entry);
                    // Ignored dirs are never descended; neither are the daemon's own (auth/, sessions/, browser/,
                    // the root .git — isLockedWorkspacePath), whose every file the file API refuses anyway: the
                    // explorer draws them as one locked row, so listing what is inside would spend the walk's
                    // budget — thousands of entries, in the browser-profile case — on rows nobody can open. The
                    // rest queue for the next level and stay unlisted (no `children`) if the budget runs out
                    // first — either way the client lazy-loads them.
                    if (!ignored && !isLockedWorkspacePath(path)) {
                        next.push({ abs, rel: path, parentScope: scope, owner: entry });
                    }
                    continue;
                }
                let size: number | undefined;
                try {
                    size = (await stat(abs)).size;
                } catch {
                    size = undefined;
                }
                children.push({
                    name: dirent.name,
                    path,
                    type: "file",
                    ...(size !== undefined ? { size } : {}),
                    ...(ignored ? { ignored: true } : {}),
                });
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

// Lazy-load one directory's children — a dir the tree walk listed but didn't descend into (ignored, or beyond
// the walk's entry budget). Child DIRS again carry no `children` (they lazy-load on their own expand). Ignore
// state is rebuilt by descending from the root so a lazily-listed dir agrees with the eager walk: entries under
// an ignored subtree stay ignored, entries under a normal one are graded by the real .gitignore layers.
// Bounded by the same entry cap → `hidden`. Symlinks skipped, dirs first. `relPath` is contained via
// resolveWithin — a path climbing out of /work yields no children.
export const listWorkspaceChildren = async (root: string, relPath: string, options?: { maxEntries?: number }): Promise<WorkspaceChildren> => {
    const base = resolve(root);
    const dir = resolveWithin(base, relPath);
    if (dir === undefined) {
        return { entries: [], hidden: 0 };
    }
    // The eager walk stops at a locked dir and the explorer never offers to expand one, so an ask for its
    // contents is either a stale client or a probe. Empty, like the walk's own answer — the file API refuses
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

    const listable = dirents.filter((dirent) => !dirent.isSymbolicLink());
    listable.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

    const entries: WorkspaceTreeEntry[] = [];
    for (const dirent of listable.slice(0, options?.maxEntries ?? MAX_ENTRIES)) {
        const isDir = dirent.isDirectory();
        const abs = join(dir, dirent.name);
        const path = toRelPath(base, abs);
        const ignored = branchIgnored || scope.isIgnored(dirent.name, path, isDir);
        if (isDir) {
            entries.push({ name: dirent.name, path, type: "dir", ...(ignored ? { ignored: true } : {}) });
            continue;
        }
        let size: number | undefined;
        try {
            size = (await stat(abs)).size;
        } catch {
            size = undefined;
        }
        entries.push({ name: dirent.name, path, type: "file", ...(size !== undefined ? { size } : {}), ...(ignored ? { ignored: true } : {}) });
    }
    return { entries, hidden: listable.length - entries.length };
};
