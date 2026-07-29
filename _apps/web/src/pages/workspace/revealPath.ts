import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { nestSiblings } from "./fileNesting";

/* What has to be OPEN for a path to have a row of its own in the explorer — the arithmetic behind "reveal the
 * file the user is looking at" (WorkspaceTree's reveal watch).
 *
 * A path arrives from outside the tree: a reload or shared link (the URL carries the open file), the quick-open
 * palette, a content-search hit, a file reference in chat. None of those routes says anything about which
 * folders are open, so without expanding the way down, the file on screen is invisible in the explorer beside
 * it. */

// Every folder on the way down to a path: "src/api/routes.ts" → ["src", "src/api"]. A root-level entry has none.
export const ancestorDirs = (path: string): string[] => {
    const parts = path.split(`/`);
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join(`/`));
};

// The paths to expand, given the entries of the path's OWN directory. With file nesting on, a folded file has
// no row until the sibling that folds it (the directory's package.json) is expanded, so that sibling counts as
// an ancestor too — otherwise revealing a lock file would open every folder above it and still show nothing.
export const revealTargets = (path: string, siblings: readonly WorkspaceTreeEntry[], nesting: boolean): string[] => {
    const dirs = ancestorDirs(path);
    if (!nesting) {
        return dirs;
    }
    const nestParent = nestSiblings(siblings).find(({ nested }) => nested?.some((child) => child.path === path));
    return nestParent === undefined ? dirs : [...dirs, nestParent.entry.path];
};
