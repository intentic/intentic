import { MEMORY_FILE, MEMORY_MAX_CHARS } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { memoryFolderOf } from "./memorySide";

// THE AGENT'S MEMORY AS IT IS ON DISK: every `AGENTS.md` in the workspace, read off the tree the editor already holds
// rather than searched for, so a file made or deleted anywhere appears and goes on the next delta. The daemon reads the
// root's into every turn and each folder's into the turns that start inside it (agent/prompt/workspace-memory.ts), root
// first, while they fit under one ceiling; this works out, the same way, which of them a turn would leave out.

export interface MemoryFile {
    /** Root-relative, as the daemon names it in a turn's instructions. */
    readonly path: string;
    /** The folder whose turns read it, root-relative; empty for the workspace root's, which every turn reads. */
    readonly folder: string;
    /** Bytes on disk, drawn against the ceiling as characters: the same count for the plain text rules are written in. */
    readonly size: number;
    readonly mtime?: number | undefined;
    /** How much of the ceiling it takes on its own, as a percentage (past 100 when it alone is over). */
    readonly share: number;
    /** Left out of the turns that start in its folder: with the files above it, it crosses the ceiling. */
    readonly dropped: boolean;
}

// Whether a turn starting in `folder` reads the file kept for `above` (the root's, or a folder on the way down).
const reads = (folder: string, above: string): boolean => above === `` || folder === above || folder.startsWith(`${above}/`);

// Only what the walk listed: a folder it left unread (installed packages, past its budget) is not looked into.
const collect = (entries: readonly WorkspaceTreeEntry[], into: Pick<MemoryFile, `path` | `size` | `mtime`>[]): void => {
    for (const entry of entries) {
        if (entry.type === `file` && entry.name === MEMORY_FILE) {
            into.push({ path: entry.path, size: entry.size ?? 0, mtime: entry.mtime });
        } else if (entry.type === `dir` && entry.children !== undefined) {
            collect(entry.children, into);
        }
    }
};

/** Every memory file in the tree, the workspace's own first and then by folder, each with what it costs a turn. */
export const memoryFilesIn = (tree: readonly WorkspaceTreeEntry[]): readonly MemoryFile[] => {
    const found: Pick<MemoryFile, `path` | `size` | `mtime`>[] = [];
    collect(tree, found);
    // The root's sorts first on its own: an empty folder name is before every other.
    const placed = found.map((file) => ({ ...file, folder: memoryFolderOf(file.path) })).toSorted((a, b) => a.folder.localeCompare(b.folder));
    return placed.map((file) => {
        // The files a turn starting here reads, root first, each taken while the running total stays under the ceiling.
        const path = placed.filter((other) => reads(file.folder, other.folder)).toSorted((a, b) => a.folder.length - b.folder.length);
        const kept = new Set<string>();
        let spent = 0;
        for (const above of path) {
            if (spent + above.size <= MEMORY_MAX_CHARS) {
                spent += above.size;
                kept.add(above.path);
            }
        }
        return { ...file, share: (file.size / MEMORY_MAX_CHARS) * 100, dropped: !kept.has(file.path) };
    });
};

// Past this share of the ceiling a file is drawn as near it, the way the composer's context ring warns.
const NEAR_CEILING = 80;

/** The gauge's ink: the context ring's accent, its warning near the ceiling, and danger once a turn leaves the file out. */
export const memoryTone = (file: Pick<MemoryFile, `share` | `dropped`>): `text-accent` | `text-warning` | `text-danger` =>
    file.dropped ? `text-danger` : file.share >= NEAR_CEILING ? `text-warning` : `text-accent`;
