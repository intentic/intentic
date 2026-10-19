import type { GitChange, GitDiffSide, RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";

// Sides in git's order (conflicts block everything, then staged, then unstaged); an empty section renders
// nothing. The origin filter is applied here once, so every row, verb and count downstream inherits it for free.
// Except on Staged: that side is exactly what Commit records whenever it holds anything, so hiding part of it let a
// filtered commit take files nobody could see.
export interface SideView {
    readonly side: GitDiffSide;
    readonly label: string;
    readonly changes: readonly GitChange[];
}

// `t` is the panel's own, so a language switch relabels the sides with the rest of it.
export const sideViews = (
    repos: readonly RepoChanges[],
    matches: (repo: RepoChanges, change: GitChange) => boolean,
    t: (key: string) => string,
): ReadonlyMap<string, readonly SideView[]> =>
    new Map(
        repos.map((repo) => [
            repo.repo,
            [
                { side: `conflicted` as const, label: t(`workspace.reviewPanel.conflicts`), changes: repo.conflicted },
                { side: `staged` as const, label: t(`workspace.reviewPanel.staged2`), changes: repo.staged },
                { side: `unstaged` as const, label: t(`workspace.reviewPanel.unstaged`), changes: repo.unstaged },
            ].flatMap((section) => {
                const shown = section.side === `staged` ? section.changes : section.changes.filter((change) => matches(repo, change));
                return shown.length === 0 ? [] : [{ side: section.side, label: section.label, changes: shown }];
            }),
        ]),
    );
