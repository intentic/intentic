import type { RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { offMainLine, repoNameOf } from "./mainLine";

const repo = (name: string, at: Pick<RepoChanges, `branch` | `mainBranch`>): RepoChanges => ({
    repo: name,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...at,
});

describe(`offMainLine`, () => {
    // `mainBranch` is the daemon's word that a repository stands somewhere else; on its main line the field is absent.
    it(`names only the repositories the daemon says stand off their main line`, () => {
        const rows = [repo(`root`, { branch: `main` }), repo(`site`, { branch: `feature/x`, mainBranch: `main` }), repo(`api`, { branch: `trunk` })];
        expect(offMainLine(rows)).toEqual([{ repo: `site`, branch: `feature/x`, main: `main` }]);
    });

    it(`keeps a repository that is on no branch at all, with nothing to name where it is`, () => {
        expect(offMainLine([repo(`root`, { mainBranch: `master` })])).toEqual([{ repo: `root`, branch: undefined, main: `master` }]);
    });

    it(`reads nothing off a workspace that is home`, () => {
        expect(offMainLine([])).toEqual([]);
        expect(offMainLine([repo(`root`, { branch: `main` })])).toEqual([]);
    });
});

describe(`repoNameOf`, () => {
    it(`calls the workspace's own repository by the caller's word, and any other by its folder`, () => {
        expect(repoNameOf(`root`, `The workspace`)).toBe(`The workspace`);
        expect(repoNameOf(`apps/web`, `The workspace`)).toBe(`apps/web`);
    });
});
