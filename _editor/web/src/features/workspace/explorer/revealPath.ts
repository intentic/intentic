import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { nestSiblings } from "./fileNesting";

// Arithmetic behind revealing the file the user is looking at (WorkspaceTree's reveal watch): what must be open for a
// path to have its own row. A path can arrive with no folder-open state attached (reload, quick-open, search, chat), so
// revealing means expanding the way down first.

// Every folder on the way down to a path: "src/api/routes.ts" → ["src", "src/api"]. A root-level entry has none.
export const ancestorDirs = (path: string): string[] => {
    const parts = path.split(`/`);
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join(`/`));
};

// Paths to expand for a path's own directory. With nesting on, a folded file's row exists only once its nesting sibling
// (e.g. package.json) expands, so that sibling counts as an ancestor too.
export const revealTargets = (path: string, siblings: readonly WorkspaceTreeEntry[], nesting: boolean): string[] => {
    const dirs = ancestorDirs(path);
    if (!nesting) {
        return dirs;
    }
    const nestParent = nestSiblings(siblings).find(({ nested }) => nested?.some((child) => child.path === path));
    return nestParent === undefined ? dirs : [...dirs, nestParent.entry.path];
};
