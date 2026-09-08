import type { RepoChanges } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { ahead, behind, outgoingMark, outgoingSummary, outgoingWork, syncable, unpublished } from "./outgoingWork";

// Pins the rule the rail tile, workspace banner, and review panel all share: a clean tree isn't the same as
// nothing to do.

// A repo with no changes and no remote; override only the remote facts a case is about.
const repo = (remote?: RepoChanges["remote"]): RepoChanges => ({
    repo: `intentic`,
    conflicted: [],
    staged: [],
    unstaged: [],
    ...(remote === undefined ? {} : { remote }),
});

describe(`a repo's standing against its remote`, () => {
    it(`reads a repo with no remote configured as unsyncable rather than as zero`, () => {
        // Nothing to sync with isn't the same as in sync; a purely local repo must get no dead push button.
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
        // git reports no ahead count without an upstream: 0 here is an absence, not a fact; publishing is its own
        // state.
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
        // The core rule: `behind` is only as fresh as the last fetch, so acting on it would announce work already
        // taken and miss work that just arrived.
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
        // Remote state is as unknown as everything else here; the panel reports the scan failure, not a guessed number.
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
        // The per-repo fan-out publishes untracked branches on the way through, so one click covers both actions.
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
        // Both unpublished and ahead; the same push sends it, so it wears the same arrow as any other.
        expect(outgoingMark({ commits: 2, repos: 1, publish: true })).toBe(`arrow-up-right`);
        expect(outgoingMark({ commits: 2, repos: 1, publish: false })).toBe(`arrow-up-right`);
    });
});
