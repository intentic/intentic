import type { CommitResult, GitChangesResponse, RepoChanges } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { spliceRepoChanges } from "./spliceRepoChanges";

// Pins that a commit's one-repo answer can stand in for a full rescan: it replaces only its own repo, drops it
// on the daemon's say-so, and leaves every other repo's rows and attribution untouched.

const repo = (name: string, unstaged: RepoChanges["unstaged"] = []): RepoChanges => ({
    repo: name,
    conflicted: [],
    staged: [],
    unstaged,
});

const held = (repos: readonly RepoChanges[], originAgents?: GitChangesResponse["originAgents"]): GitChangesResponse => ({
    repos: [...repos],
    ...(originAgents === undefined ? {} : { originAgents }),
});

const committed = (changes?: RepoChanges, originAgents?: CommitResult["originAgents"]): CommitResult => ({
    committed: true,
    ...(changes === undefined ? {} : { changes }),
    ...(originAgents === undefined ? {} : { originAgents }),
});

describe(`folding a commit's answer into the review`, () => {
    it(`replaces the committed repo IN PLACE, so the groups around it do not move`, () => {
        const before = held([repo(`root`), repo(`intentic`, [{ path: `a.ts`, status: `modified` }]), repo(`extensions/homelab`)]);
        const after = spliceRepoChanges(before, `intentic`, committed(repo(`intentic`, [{ path: `notes.md`, status: `added` }])));
        expect(after.repos.map((entry) => entry.repo)).toEqual([`root`, `intentic`, `extensions/homelab`]);
        expect(after.repos[1]?.unstaged).toEqual([{ path: `notes.md`, status: `added` }]);
    });

    it(`drops the repo when the commit reports nothing left, and leaves the others alone`, () => {
        // Absent `changes` is the daemon's own inclusion rule — same `undefined` a workspace scan filters on.
        const before = held([repo(`root`), repo(`intentic`, [{ path: `a.ts`, status: `modified` }])]);
        const after = spliceRepoChanges(before, `intentic`, committed());
        expect(after.repos.map((entry) => entry.repo)).toEqual([`root`]);
    });

    it(`appends a repo the cache was not holding, rather than swallowing it`, () => {
        const after = spliceRepoChanges(held([repo(`root`)]), `intentic`, committed(repo(`intentic`, [{ path: `notes.md`, status: `added` }])));
        expect(after.repos.map((entry) => entry.repo)).toEqual([`root`, `intentic`]);
    });

    it(`merges the answer's agents over the ones already held instead of replacing them`, () => {
        const before = held([repo(`root`), repo(`intentic`)], { a1: { title: `Older land`, provider: `claude` } });
        const after = spliceRepoChanges(before, `intentic`, committed(repo(`intentic`), { a2: { title: `Write notes`, provider: `codex` } }));
        expect(after.originAgents).toEqual({
            a1: { title: `Older land`, provider: `claude` },
            a2: { title: `Write notes`, provider: `codex` },
        });
    });

    it(`leaves originAgents absent when neither side names anyone`, () => {
        // An empty object would be a third state; absence is the only signal for "nobody named here".
        expect(spliceRepoChanges(held([repo(`intentic`)]), `intentic`, committed(repo(`intentic`)))).not.toHaveProperty(`originAgents`);
    });
});
