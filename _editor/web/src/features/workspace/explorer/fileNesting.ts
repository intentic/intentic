import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { joinPath } from "./entryNames";

/* Opinionated file nesting (VSCode's feature, minus the configuration): in any directory that contains a package.json file. */

export interface NestedEntry {
    readonly entry: WorkspaceTreeEntry;
    // The sibling files folded under this entry, set only on the nest parent (the directory's package.json).
    readonly nested?: readonly WorkspaceTreeEntry[];
}

// One directory level → the same entries with the fold applied. Directories keep their order; the nest
// parent takes the files' place as a single trailing block. A lone package.json (nothing to fold) and a
// DIRECTORY named package.json both pass through unchanged.
export const nestSiblings = (entries: readonly WorkspaceTreeEntry[]): readonly NestedEntry[] => {
    const parent = entries.find((node) => node.type === `file` && node.name === `package.json`);
    const nested = parent === undefined ? [] : entries.filter((node) => node.type === `file` && node !== parent);
    if (parent === undefined || nested.length === 0) {
        return entries.map((entry) => ({ entry }));
    }
    return [...entries.filter((node) => node.type === `dir`).map((entry) => ({ entry })), { entry: parent, nested }];
};

// Something the user just put in a directory (a create, paste, move, rename or extract), by the kind of entry it is.
export interface LandedEntry {
    readonly path: string;
    readonly type: "file" | "dir";
}

// The nest a landing in `dir` must open so what landed is not folded out of sight: the directory's package.json, once
// a landed file joins its fold or a landed package.json starts folding files already there. `landed` is undefined when
// what is coming is not known yet (an upload still being read), which opens an existing fold rather than guess.
export const landingNest = (dir: string, listing: readonly WorkspaceTreeEntry[], landed?: readonly LandedEntry[]): string | undefined => {
    const nest = joinPath(dir, `package.json`);
    const landedFiles = landed?.filter((entry) => entry.type === `file`).map((entry) => entry.path);
    const files = new Set([...listing.filter((node) => node.type === `file`).map((node) => node.path), ...(landedFiles ?? [])]);
    if (!files.has(nest)) {
        return undefined;
    }
    if (landedFiles === undefined) {
        return nest;
    }
    return landedFiles.length > 0 && files.size > 1 ? nest : undefined;
};
