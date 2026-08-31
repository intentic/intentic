import type { RepoChanges } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { ahead, behind, outgoingMark, outgoingSummary, outgoingWork, syncable, unpublished } from "./outgoingWork";

/* The remote-state reads the rail tile, the workspace banner and the review panel all share. What is being
 * pinned here is the RULE, not the arithmetic: a clean tree is not the same thing as a tree with nothing to do,
 * and the surfaces that say so must say it in one voice. */

// A repo with no changes and no remote: override only the remote facts a case is about.
const repo = (remote?: RepoChanges["remote"]): RepoChanges => ({
    repo: `intentic`,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...(remote === undefined ? {} : { remote }),
});

describe(`a repo's standing against its remote`, () => {
    it(`reads a repo with no remote configured as unsyncable rather than as zero`, () => {
        // The distinction the panel hangs its controls off: nothing to sync WITH is not the same as in sync,
        // and a purely local repo must get no dead push button.
        expect(syncable(repo())).toBe(false);
        expect(unpublished(repo())).toBe(false);
    });

    it(`reads a fresh clone as syncable, published and level`, () => {
        const clone = repo({ remote: `origin`, upstream: `origin/main`, ahead: 0, behind: 0 });
        expect(syncable(clone)).toBe(true);
        expect(unpublished(clone)).toBe(false);
        expect(ahead(clone)).toBe(0);
        expect(behind(clone)).toBe(0);
    });

    it(`treats a branch that tracks nothing as unpublished, not as zero commits ahead`, () => {
        // git reports no ahead count for a branch with no upstream, so "0" here is an absence of an answer.
        // Publishing is its own state precisely because the amount is unsayable.
        const fresh = repo({ remote: `origin`, ahead: 0, behind: 0 });
        expect(unpublished(fresh)).toBe(true);
        expect(ahead(fresh)).toBe(0);
    });
});

describe(`what a clean tree still owes`, () => {
    it(`says nothing when every repo is level with its upstream`, () => {
        expect(outgoingWork([repo({ remote: `origin`, upstream: `origin/main`, ahead: 0, behind: 0 })])).toBeUndefined();
    });

    it(`says nothing about a repo that is only BEHIND`, () => {
        // The rule this module exists for. `behind` is true only as of the last fetch, so it is wrong in both
        // directions: it would announce work already taken and stay silent about work that just arrived.
        expect(outgoingWork([repo({ remote: `origin`, upstream: `origin/main`, ahead: 0, behind: 7 })])).toBeUndefined();
    });

    it(`sums commits across repos and counts the repos, because a sync is one push each`, () => {
        const work = outgoingWork([
            { ...repo({ remote: `origin`, upstream: `origin/main`, ahead: 2, behind: 0 }), repo: `root` },
            { ...repo({ remote: `origin`, upstream: `origin/main`, ahead: 3, behind: 9 }), repo: `intentic` },
        ]);
        expect(work).toEqual({ commits: 5, repos: 2, publish: false });
    });

    it(`counts an unpublished branch as outgoing even though it has no commits to count`, () => {
        expect(outgoingWork([repo({ remote: `origin`, ahead: 0, behind: 0 })])).toEqual({ commits: 0, repos: 1, publish: true });
    });

    it(`ignores a repo git could not scan`, () => {
        // Its remote state is as unknown as everything else about it, and the panel reports the scan failure
        // itself: badging the rail off a number we do not have would be inventing one.
        const torn: RepoChanges = { ...repo({ remote: `origin`, upstream: `origin/main`, ahead: 4, behind: 0 }), error: `not a git repository` };
        expect(outgoingWork([torn])).toBeUndefined();
    });

    it(`ignores a purely local repo, which has nowhere to send anything`, () => {
        expect(outgoingWork([repo()])).toBeUndefined();
    });
});

describe(`what the surfaces say about outgoing work`, () => {
    it(`counts commits and names the push`, () => {
        expect(outgoingSummary({ commits: 3, repos: 1, publish: false })).toContain(`3`);
        expect(outgoingSummary({ commits: 1, repos: 1, publish: false })).toContain(`1`);
        expect(outgoingSummary({ commits: 3, repos: 1, publish: false })).not.toBe(outgoingSummary({ commits: 1, repos: 1, publish: false }));
    });

    it(`says how many repos are in play, because a sync is one push per repo`, () => {
        const work = { commits: 4, repos: 2, publish: false };
        const summary = outgoingSummary(work);
        expect(summary).toContain(String(work.commits));
        expect(summary).toContain(String(work.repos));
    });

    it(`describes a mixed publish-and-ahead set by its commits alone`, () => {
        // The per-repo fan-out publishes untracked branches on the way through, so the user has one click:
        // spelling out both would describe two actions.
        const mixed = { commits: 2, repos: 2, publish: true };
        expect(outgoingSummary(mixed)).toContain(String(mixed.commits));
        expect(outgoingSummary(mixed)).toBe(outgoingSummary({ commits: 2, repos: 2, publish: false }));
    });

    it(`falls back to branches when there are no commits to count`, () => {
        expect(outgoingSummary({ commits: 0, repos: 1, publish: true })).not.toBe(outgoingSummary({ commits: 0, repos: 3, publish: true }));
        expect(outgoingSummary({ commits: 0, repos: 3, publish: true })).toContain(`3`);
    });

    it(`wears the cloud only when publishing is all there is to do`, () => {
        expect(outgoingMark({ commits: 0, repos: 1, publish: true })).toBe(`cloud-upload`);
        // Both unpublished AND ahead: the same push sends it, so it wears the same arrow as any other.
        expect(outgoingMark({ commits: 2, repos: 1, publish: true })).toBe(`arrow-up-right`);
        expect(outgoingMark({ commits: 2, repos: 1, publish: false })).toBe(`arrow-up-right`);
    });
});
