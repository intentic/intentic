import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceChildren, WorkspaceTree, WorkspaceTreeEntry } from "@intentic/sandbox-contract";
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

// Walk the real working tree under `root`, bounded by a total-entry cap so a pathological tree can't blow up the
// response. Depth is unbounded — payload size is bounded by node count, not depth, and symlinks are skipped (not
// followed, not listed) so the walk can't loop or escape the workspace. Directories sort before files,
// alphabetically within each. Nothing is dropped: ignored entries carry `ignored: true`, and ignored dirs are
// listed but NOT descended (their children lazy-load via listWorkspaceChildren). When the cap cuts a directory's
// child list short, that dir entry carries `truncated: true`; the returned top-level flag means the root's own
// entries were cut (no parent dir to flag).
export const walkWorkspaceTree = async (root: string, options?: { maxEntries?: number }): Promise<WorkspaceTree> => {
    const base = resolve(root);
    const maxEntries = options?.maxEntries ?? MAX_ENTRIES;
    let count = 0;

    const walk = async (dir: string, scope: IgnoreScope): Promise<{ children: WorkspaceTreeEntry[]; cut: boolean }> => {
        // Pick up this directory's own .gitignore before testing its entries.
        const here = await scope.descend(dir, toRelPath(base, dir));
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
        if (dirents === undefined) {
            return { children: [], cut: false };
        }
        dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

        const entries: WorkspaceTreeEntry[] = [];
        let cut = false;
        for (const dirent of dirents) {
            if (count >= maxEntries) {
                cut = true;
                break;
            }
            if (dirent.isSymbolicLink()) {
                continue;
            }
            const isDir = dirent.isDirectory();
            const abs = join(dir, dirent.name);
            const path = toRelPath(base, abs);
            const ignored = here.isIgnored(dirent.name, path, isDir);
            count++;
            if (isDir) {
                // Ignored dirs are listed but not descended — the client lazy-loads their children on expand.
                if (ignored) {
                    entries.push({ name: dirent.name, path, type: "dir", ignored: true });
                    continue;
                }
                const sub = await walk(abs, here);
                entries.push({ name: dirent.name, path, type: "dir", children: sub.children, ...(sub.cut ? { truncated: true } : {}) });
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
        return { children: entries, cut };
    };

    const { children, cut } = await walk(base, createIgnoreScope());
    return { root: base, tree: children, truncated: cut };
};

// Lazy-load one directory's children — an ignored dir the walk above listed but didn't descend into. Everything
// here lives under an ignored subtree, so every entry is `ignored: true` and child DIRS again carry no `children`
// (they lazy-load on their own expand). Bounded by the same entry cap → `truncated`. Symlinks skipped, dirs first.
// `relPath` is contained via resolveWithin — a path climbing out of /work yields no children.
export const listWorkspaceChildren = async (root: string, relPath: string): Promise<WorkspaceChildren> => {
    const base = resolve(root);
    const dir = resolveWithin(base, relPath);
    if (dir === undefined) {
        return { entries: [], truncated: false };
    }
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (dirents === undefined) {
        return { entries: [], truncated: false };
    }
    dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

    const entries: WorkspaceTreeEntry[] = [];
    let truncated = false;
    for (const dirent of dirents) {
        if (entries.length >= MAX_ENTRIES) {
            truncated = true;
            break;
        }
        if (dirent.isSymbolicLink()) {
            continue;
        }
        const abs = join(dir, dirent.name);
        const path = toRelPath(base, abs);
        if (dirent.isDirectory()) {
            entries.push({ name: dirent.name, path, type: "dir", ignored: true });
            continue;
        }
        let size: number | undefined;
        try {
            size = (await stat(abs)).size;
        } catch {
            size = undefined;
        }
        entries.push({ name: dirent.name, path, type: "file", ignored: true, ...(size !== undefined ? { size } : {}) });
    }
    return { entries, truncated };
};
