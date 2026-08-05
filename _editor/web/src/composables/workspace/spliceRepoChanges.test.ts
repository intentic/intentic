import type { CommitResult, GitChangesResponse, RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { spliceRepoChanges } from "./spliceRepoChanges";

/* How a commit redraws the review without re-reading the workspace. What is being pinned here is that the
 * commit's one-repo answer can stand in for a whole scan — it replaces exactly its own repo, drops it on the
 * daemon's say-so, and leaves every other repo's rows and attribution untouched. */

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
        // Order is the claim, not just membership: the panel groups by repo, and a repo that jumped to the end
        // of the list on every commit would shift rows under a user who is still reading them.
        const before = held([repo(`root`), repo(`intentic`, [{ path: `a.ts`, status: `modified` }]), repo(`extensions/homelab`)]);
        const after = spliceRepoChanges(before, `intentic`, committed(repo(`intentic`, [{ path: `notes.md`, status: `added` }])));
        expect(after.repos.map((entry) => entry.repo)).toEqual([`root`, `intentic`, `extensions/homelab`]);
        expect(after.repos[1]?.unstaged).toEqual([{ path: `notes.md`, status: `added` }]);
    });

    it(`drops the repo when the commit reports nothing left, and leaves the others alone`, () => {
        // Absent `changes` is the daemon's own inclusion rule — the same `undefined` the workspace scan filters
        // on. The panel drops the group on this answer rather than waiting for a scan to stop listing it.
        const before = held([repo(`root`), repo(`intentic`, [{ path: `a.ts`, status: `modified` }])]);
        const after = spliceRepoChanges(before, `intentic`, committed());
        expect(after.repos.map((entry) => entry.repo)).toEqual([`root`]);
    });

    it(`appends a repo the cache was not holding, rather than swallowing it`, () => {
        // A commit can leave work behind in a repo the last scan had nothing to say about — an untracked file
        // `commit -a` never sweeps, or a branch that only now has something to push. Dropping that answer would
        // hide real work until some later scan happened to surface it.
        const after = spliceRepoChanges(held([repo(`root`)]), `intentic`, committed(repo(`intentic`, [{ path: `notes.md`, status: `added` }])));
        expect(after.repos.map((entry) => entry.repo)).toEqual([`root`, `intentic`]);
    });

    it(`merges the answer's agents over the ones already held instead of replacing them`, () => {
        // The answer names only the agents of the ONE repo it scanned. Replacing the map would strip every
        // other repo's rows of their titles and drop them back to the "Agent 1a2b3c" fallback.
        const before = held([repo(`root`), repo(`intentic`)], { a1: { title: `Older land`, provider: `claude` } });
        const after = spliceRepoChanges(before, `intentic`, committed(repo(`intentic`), { a2: { title: `Write notes`, provider: `codex` } }));
        expect(after.originAgents).toEqual({
            a1: { title: `Older land`, provider: `claude` },
            a2: { title: `Write notes`, provider: `codex` },
        });
    });

    it(`leaves originAgents absent when neither side names anyone`, () => {
        // The response shape says the map covers the ids the review names "and only those" — an empty object
        // would be a third state the panel would have to know not to read anything into.
        expect(spliceRepoChanges(held([repo(`intentic`)]), `intentic`, committed(repo(`intentic`)))).not.toHaveProperty(`originAgents`);
    });
});
