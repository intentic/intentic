import type { GitChanges, GitLog } from "@intentic/sandbox-contract";
import { holdsWork, madeEntries, onlyStarter, starterStateOf } from "./madeWork";

// What counts as work for "No repository to push this work to". A phone that had just signed up was told its work had
// nowhere to go before it had sent a message: the workspace held only the daemon's state and the seeded starter site.

const FRESH = [`.intentic`, `site`];

const seedLog: GitLog = {
    repo: `site`,
    branch: `main`,
    hasMore: false,
    commits: [
        {
            sha: `a`.repeat(40),
            short: `aaaaaaa`,
            parents: [],
            subject: `chore: starter site`,
            body: ``,
            author: `agent`,
            email: `a@b`,
            at: 0,
            refs: [],
            head: true,
        },
    ],
};
const clean: GitChanges = { repos: [] };
const edited: GitChanges = {
    repos: [
        {
            repo: `site`,
            branch: `main`,
            conflicted: [],
            staged: [],
            unstaged: [{ path: `_apps/landing/src/pages/index.astro`, status: `modified`, additions: 2, deletions: 1 }],
        },
    ],
} as GitChanges;

describe(`a fresh workspace`, () => {
    it(`is the sandbox's own furniture and its seeded starter site, which is nobody's work`, () => {
        expect(madeEntries([...FRESH, `refs`])).toEqual([`site`]);
        expect(onlyStarter(FRESH)).toBe(true);
        expect(holdsWork(FRESH, starterStateOf({ data: seedLog, failed: false }, clean))).toBe(false);
    });

    it(`holds nothing while the tree has not been read, nor while the starter's history is out`, () => {
        expect(holdsWork(undefined, `moved`)).toBe(false);
        expect(starterStateOf({ failed: false }, clean)).toBe(`unread`);
        expect(starterStateOf({ data: seedLog, failed: false }, undefined)).toBe(`unread`);
        expect(holdsWork(FRESH, `unread`)).toBe(false);
    });

    it(`holds nothing when the image seeded no starter at all`, () => {
        expect(holdsWork([`.intentic`], `unread`)).toBe(false);
    });
});

describe(`work`, () => {
    it(`is anything else at the top of the workspace, whoever made it`, () => {
        expect(holdsWork([...FRESH, `notes.md`], `seed`)).toBe(true);
        expect(holdsWork([`.intentic`, `my-app`], `unread`)).toBe(true);
        expect(onlyStarter([...FRESH, `notes.md`])).toBe(false);
    });

    // An agent's landed work is a commit on the starter; an edit nobody committed is a change in it.
    it(`is a starter site built on, by a commit past its seed or a change not yet committed`, () => {
        expect(starterStateOf({ data: { ...seedLog, hasMore: true }, failed: false }, clean)).toBe(`moved`);
        expect(starterStateOf({ data: seedLog, failed: false }, edited)).toBe(`moved`);
        expect(holdsWork(FRESH, `moved`)).toBe(true);
    });

    // The seed always has exactly one commit: a `site` with no history, or none git can read, is not it.
    it(`is a site folder that is not the seeded repository`, () => {
        expect(starterStateOf({ data: { ...seedLog, commits: [] }, failed: false }, clean)).toBe(`moved`);
        expect(starterStateOf({ failed: true }, undefined)).toBe(`moved`);
    });
});
