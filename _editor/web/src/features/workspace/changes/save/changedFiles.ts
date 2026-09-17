import type { ChangeStatus } from "@intentic/ui";
import type { GitChange, GitDiffSide, RepoChanges } from "@intentic/api-contract";

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
}

// A file can sit on two sides at once with different content. Nothing a maker does stages, so this only decides a
// corner case; the working tree wins, being the half they last changed.
const SIDE_ORDER: readonly GitDiffSide[] = [`conflicted`, `unstaged`, `staged`];

export const fileRows = (repo: RepoChanges): readonly ChangedFile[] => {
    const seen = new Map<string, ChangedFile>();
    for (const side of SIDE_ORDER) {
        for (const change of repo[side] as readonly GitChange[]) {
            if (seen.has(change.path)) {
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
            });
        }
    }
    return [...seen.values()];
};
