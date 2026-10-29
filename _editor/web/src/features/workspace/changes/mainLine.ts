import type { RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";

// THE SHARED CHECKOUT OFF ITS MAIN LINE. The daemon refuses to switch a shared repository away from its main line, but a
// terminal can still do it, and then every agent's work waits rather than land on the wrong branch. `git.changes` says so
// per repository with `mainBranch`, given only then; these read it for the strip that offers the way back.

/** One repository standing off its main line: where it is (undefined when on no branch at all) and where it belongs. */
export interface OffMainLine {
    readonly repo: string;
    readonly branch: string | undefined;
    readonly main: string;
}

/** Every listed repository that stands off its main line, in the list's own order. */
export const offMainLine = (repos: readonly RepoChanges[]): readonly OffMainLine[] =>
    repos.flatMap((row) => (row.mainBranch === undefined ? [] : [{ repo: row.repo, branch: row.branch, main: row.mainBranch }]));

/** What a sentence calls a repository: the workspace's own ("root") by the caller's word for it, any other by its folder. */
export const repoNameOf = (repo: string, workspace: string): string => (repo === `root` ? workspace : repo);
