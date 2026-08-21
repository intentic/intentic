import type { GitBranch, GitRemoteBranch } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { groupBranches } from "./groupBranches.js";

const local = (name: string, over: Partial<GitBranch> = {}): GitBranch => ({
    name,
    current: false,
    ahead: 0,
    behind: 0,
    at: 1000,
    ...over,
});

const remote = (name: string, at = 1000): GitRemoteBranch => {
    const slash = name.indexOf(`/`);
    return { name, remote: name.slice(0, slash), branch: name.slice(slash + 1), at };
};

describe(`groupBranches`, () => {
    it(`pairs a local branch with the remotes of the same name into one row`, () => {
        const groups = groupBranches([local(`main`)], [remote(`origin/main`), remote(`upstream/main`)]);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.name).toBe(`main`);
        expect(groups[0]?.local?.name).toBe(`main`);
        expect(groups[0]?.remotes.map((entry) => entry.remote)).toEqual([`origin`, `upstream`]);
    });

    /* A branch that exists only on a remote is the row "somebody pushed something you do not have": the one a
     * checkout would be created from. Dropping it would make that state invisible. */
    it(`keeps a remote-only branch as a group with no local`, () => {
        const groups = groupBranches([], [remote(`origin/feature/x`)]);
        expect(groups[0]?.name).toBe(`feature/x`);
        expect(groups[0]?.local).toBeUndefined();
        expect(groups[0]?.remotes).toHaveLength(1);
    });

    it(`keeps a local branch that has never been pushed`, () => {
        const groups = groupBranches([local(`scratch`)], []);
        expect(groups[0]).toMatchObject({ name: `scratch` });
        expect(groups[0]?.remotes).toEqual([]);
    });

    /* PAIRED BY NAME, NOT BY THE CONFIGURED UPSTREAM. A branch whose upstream was deleted (the usual sign a PR
     * merged) still belongs beside the remote branches sharing its name, and grouping by upstream would strand
     * it in a row of its own at exactly the moment the reader is deciding whether to delete it. */
    it(`groups a branch whose upstream is gone with the remote branch of the same name`, () => {
        const groups = groupBranches([local(`main`, { upstream: `origin/main`, gone: true })], [remote(`origin/main`)]);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.local?.gone).toBe(true);
    });

    // A branch name may contain slashes; a remote name may not, so the split is on the FIRST slash only.
    it(`splits a nested branch name from its remote correctly`, () => {
        const groups = groupBranches([], [remote(`origin/release/2024/q1`)]);
        expect(groups[0]?.name).toBe(`release/2024/q1`);
        expect(groups[0]?.remotes[0]?.remote).toBe(`origin`);
    });

    it(`puts the current branch first, then the newest tip`, () => {
        const groups = groupBranches([local(`old`, { at: 1 }), local(`new`, { at: 9 }), local(`checked-out`, { at: 5, current: true })], []);
        expect(groups.map((group) => group.name)).toEqual([`checked-out`, `new`, `old`]);
    });

    // The group's time is the newest tip in it, so a branch someone else pushed to sorts by that push rather
    // than by the older local copy.
    it(`orders a group by its newest tip, local or remote`, () => {
        const groups = groupBranches([local(`a`, { at: 1 }), local(`b`, { at: 5 })], [remote(`origin/a`, 9)]);
        expect(groups.map((group) => group.name)).toEqual([`a`, `b`]);
    });
});
