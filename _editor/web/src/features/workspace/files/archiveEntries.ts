import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { archivePrefixOf, archiveRootOf, isBrowsableArchive } from "@intentic/sandbox-contract";

// Which workspace paths are an archive's contents rather than the workspace's own. A zip or tar is entered like a
// folder (the daemon unpacks it out of sight and lists that), so every write verb has to know when it is looking at
// one: nothing repacks an archive, and a move out of one is a copy.

/** Whether this entry opens like a folder even though it is a file. */
export const opensAsFolder = (entry: WorkspaceTreeEntry): boolean => entry.type === `file` && isBrowsableArchive(entry.name);

// A segment named like an archive is only one if the tree says it is a file. A prefix the tree has not listed is taken
// at its name: getting to it at all means something listed it, and erring towards read-only beats offering a write the
// daemon would refuse anyway.
const probe =
    (entryAt: (path: string) => WorkspaceTreeEntry | undefined) =>
    (prefix: string): boolean =>
        entryAt(prefix)?.type !== `dir`;

/** The archive a folder is inside, or is; undefined for the workspace proper. What the desk asks about where it is. */
export const archiveAbove = (dir: string, entryAt: (path: string) => WorkspaceTreeEntry | undefined): string | undefined =>
    archiveRootOf(dir, probe(entryAt))?.archive;

/**
 * Whether an entry may not be written, because it sits inside an archive. The archive FILE itself is ordinary
 * workspace content: it can be renamed, moved and deleted like anything else.
 */
export const isArchiveContent = (path: string, entryAt: (path: string) => WorkspaceTreeEntry | undefined): boolean =>
    archivePrefixOf(path, probe(entryAt)) !== undefined;
