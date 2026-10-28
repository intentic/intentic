import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { formatBytes } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// What a selection of several rows amounts to, said once under the tree, as a file manager's status bar says it: how
// many folders and files, and what the files weigh. A folder's own size is never in a listing (it would take a walk of
// everything inside it), so a total is given only when every selected row is a file that says its size; a total over
// the files alone would read as the size of the folders too. One row needs no line: the row already says what it is.

export interface SelectionCount {
    readonly folders: number;
    readonly files: number;
    // The files' summed size, when every selected row is a file whose size the listing carries.
    readonly bytes: number | undefined;
}

/** Counts a selection by kind; a path no longer listed is left out. */
export const countSelection = (paths: Iterable<string>, entryAt: (path: string) => WorkspaceTreeEntry | undefined): SelectionCount => {
    let folders = 0;
    let files = 0;
    let bytes: number | undefined = 0;
    for (const path of paths) {
        const entry = entryAt(path);
        if (entry === undefined) {
            continue;
        }
        if (entry.type === `dir`) {
            folders += 1;
            bytes = undefined;
            continue;
        }
        files += 1;
        bytes = bytes === undefined || entry.size === undefined ? undefined : bytes + entry.size;
    }
    return { folders, files, bytes };
};

/** The line under the tree for a selection of two or more rows, or undefined for one row or none. */
export const selectionLine = ({ folders, files, bytes }: SelectionCount): string | undefined => {
    if (folders + files < 2) {
        return undefined;
    }
    const what = [
        ...(folders > 0 ? [t(`workspace.workspaceTree.selectionFolders`, { count: folders }, folders)] : []),
        ...(files > 0 ? [t(`workspace.workspaceTree.selectionFiles`, { count: files }, files)] : []),
    ].join(`, `);
    return bytes === undefined
        ? t(`workspace.workspaceTree.selection`, { what })
        : t(`workspace.workspaceTree.selectionWithSize`, { what, size: formatBytes(bytes) });
};
