import { isScratch, type GitChange, type RepoChanges, type ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";
import { truncatedOn } from "./truncation";

// Scratch the daemon names by directory (a trailing slash) stands for every row under it, which for a build folder
// someone unhid is thousands. The panels draw one row for the folder instead of one per file, and count only what a
// Save or Commit all would actually record: the daemon leaves every scratch entry out of both, so a count that
// included them promised a save the press did not make. One module for the arithmetic, as truncation.ts is, since
// both panels, the badge and the cards must agree.

export const isFolder = (entry: Pick<ScratchPath, "path">): boolean => entry.path.endsWith(`/`);

/** The directory entries of a repository's scratch, each one a row of its own. */
export const scratchFolders = (repo: RepoChanges): readonly ScratchPath[] => (repo.scratch ?? []).filter(isFolder);

/** Whether a path sits under a directory scratch entry, which collapses it into that entry's row. */
export const inScratchFolder = (repo: RepoChanges, path: string): boolean => {
    const folders = scratchFolders(repo);
    return folders.length > 0 && isScratch(path, folders);
};

/** The unstaged rows that get a line of their own: everything except what a scratch directory stands for. */
export const listedUnstaged = (repo: RepoChanges): readonly GitChange[] =>
    repo.unstaged.filter((change) => !inScratchFolder(repo, change.path));

// Rows the daemon cut from the unstaged list that belong to a scratch folder. They cannot be read off a list that is
// not there, but the folder says how many files it holds: whatever of that is not among the rows listed was cut. It is
// capped by the cut itself, since a folder cannot account for more than was missing.
const cutInFolders = (repo: RepoChanges): number => {
    const folders = scratchFolders(repo);
    let cut = 0;
    for (const folder of folders) {
        if (folder.files !== undefined) {
            const listed = repo.unstaged.filter((change) => change.path.startsWith(folder.path)).length;
            cut += Math.max(0, folder.files - listed);
        }
    }
    return Math.min(cut, truncatedOn(repo, `unstaged`));
};

/** Rows not drawn that a Save would record: the daemon's cut, less what the folders account for. */
export const truncatedRecordable = (repo: RepoChanges): number => truncatedOn(repo, `staged`) + truncatedOn(repo, `unstaged`) - cutInFolders(repo);

/**
 * How many changes a Save or Commit all would record in this repository: conflicts, the index, and the unstaged rows
 * that are not scratch of any kind (a file entry is left out as surely as a folder), plus the rows the daemon did not
 * list, less those a folder explains.
 */
export const recordableTotal = (repo: RepoChanges): number =>
    repo.conflicted.length +
    repo.staged.length +
    repo.unstaged.filter((change) => !isScratch(change.path, repo.scratch ?? [])).length +
    truncatedRecordable(repo);

/** A folder's size for a line of text: its files, and their bytes when the daemon weighed them. */
export const folderTotals = (folders: readonly ScratchPath[]) => ({
    files: folders.reduce((total, folder) => total + (folder.files ?? 0), 0),
    bytes: folders.reduce((total, folder) => total + (folder.bytes ?? 0), 0),
});
