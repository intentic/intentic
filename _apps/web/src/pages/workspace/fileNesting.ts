import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";

/* Opinionated file nesting (VSCode's feature, minus the configuration): in any directory that contains a
 * package.json file, every OTHER file in that directory folds under package.json as a collapsible nest;
 * subdirectories stay ordinary siblings. One binary preference (useFileNesting) turns it on or off —
 * there are no per-pattern rules. */

export interface NestedEntry {
    readonly entry: WorkspaceTreeEntry;
    // The sibling files folded under this entry — set only on the nest parent (the directory's package.json).
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
