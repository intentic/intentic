import type { ChangeStatus } from "@intentic/ui";
import { isScratch, type GitChange, type GitDiffSide, type RepoChanges, type RepoTarget, type ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";
import { inScratchFolder, isFolder, recordableTotal } from "../../../../models/workspace/changes/scratchFolders";

// One changed file as the maker's Changes sidebar reads it: git's three sides flattened to one row a person can
// press. Shared by the panel that lists them (SavePanel.vue) and the whole-tree actions that act on them
// (useSaveActions.ts), so the count in a heading and the count in a "throw it all away" card come from one read.

export interface ChangedFile {
    readonly key: string;
    readonly repo: string;
    readonly path: string;
    // What the row reads: bare inside the workspace's own repository, prefixed by project otherwise.
    readonly label: string;
    readonly status: ChangeStatus;
    // Which half of git's split the diff is read from; see `SIDE_ORDER`.
    readonly side: GitDiffSide;
    // A rename's old path. Undoing one means undoing both legs, or the file stays deleted where it was.
    readonly from?: string;
    // Left out of every save by the daemon (a file the scratch list names), so it is listed but never counted as one.
    readonly scratch: boolean;
}

// One scratch folder as the maker's Changes sidebar reads it: the daemon's entry for a directory, which stands for
// every untracked file under it. It replaces those files' rows, one line for what can be thousands.
export interface ScratchFolderRow {
    readonly key: string;
    readonly repo: string;
    // What the row reads, as `ChangedFile.label` does, with the trailing slash that says it is a folder.
    readonly label: string;
    readonly entry: ScratchPath;
}

// A file can sit on two sides at once with different content. Nothing a maker does stages, so this only decides a
// corner case; the working tree wins, being the half they last changed.
const SIDE_ORDER: readonly GitDiffSide[] = [`conflicted`, `unstaged`, `staged`];

// A repository's scratch folders, one row each, in the order the daemon listed them.
export const folderRows = (repo: RepoChanges): readonly ScratchFolderRow[] =>
    (repo.scratch ?? []).filter(isFolder).map((entry) => ({
        key: JSON.stringify([repo.repo, entry.path]),
        repo: repo.repo,
        label: repo.repo === `root` ? entry.path : `${repo.repo}/${entry.path}`,
        entry,
    }));

// The rows under a scratch folder are not listed, since its own row stands for them.
export const fileRows = (repo: RepoChanges): readonly ChangedFile[] => {
    const seen = new Map<string, ChangedFile>();
    for (const side of SIDE_ORDER) {
        for (const change of repo[side] as readonly GitChange[]) {
            if (seen.has(change.path) || inScratchFolder(repo, change.path)) {
                continue;
            }
            seen.set(change.path, {
                key: JSON.stringify([repo.repo, change.path]),
                repo: repo.repo,
                path: change.path,
                label: repo.repo === `root` ? change.path : `${repo.repo}/${change.path}`,
                status: change.status,
                side,
                ...(change.from === undefined ? {} : { from: change.from }),
                scratch: side === `unstaged` && isScratch(change.path, repo.scratch ?? []),
            });
        }
    }
    return [...seen.values()];
};

// What throwing these files away sends git: one target a repository, naming every leg of each file. A rename has two,
// since an explicit path list is passed to git verbatim and undoing the new name alone would leave the old one deleted.
// Never empty-pathed, which git reads as the whole repository.
export const discardTargets = (files: readonly ChangedFile[]): readonly RepoTarget[] => {
    const byRepo = new Map<string, string[]>();
    for (const file of files) {
        byRepo.set(file.repo, [...(byRepo.get(file.repo) ?? []), ...(file.from === undefined ? [file.path] : [file.path, file.from])]);
    }
    return [...byRepo].map(([repo, paths]) => ({ repo, paths }));
};

// Deleting a folder row names the folder itself: the daemon accepts a directory path, ending in its slash, and
// discards everything under it, so the request stays one path however many files it holds.
export const folderTarget = (folder: ScratchFolderRow): RepoTarget => ({ repo: folder.repo, paths: [folder.entry.path] });

// Every repository with something a save records, whole: a save is never partial, which is what lets the panel have no
// index. A clean repository is listed for its remote alone, and one holding only scratch has nothing the daemon would
// stage, so a commit in either would spend a round trip on nothing.
export const savedRepos = (repos: readonly RepoChanges[]): readonly RepoTarget[] =>
    repos.filter((repo) => recordableTotal(repo) > 0).map((repo) => ({ repo: repo.repo }));

// What "throw it all away" reaches: those repositories, and the ones holding scratch, which only a discard takes.
export const discardedRepos = (repos: readonly RepoChanges[]): readonly RepoTarget[] =>
    repos.filter((repo) => recordableTotal(repo) > 0 || fileRows(repo).length > 0 || folderRows(repo).length > 0).map((repo) => ({ repo: repo.repo }));
