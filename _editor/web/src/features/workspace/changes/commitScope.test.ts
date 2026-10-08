import type { LandedMessageDraft, RepoChanges } from "@intentic/sandbox-contract";
import { commitScopeFor, draftLine, inScope, namingOrigin, scopeCommit, scopeFiles } from "./commitScope";

const repo = (over: Partial<RepoChanges> = {}): RepoChanges => ({
    repo: `root`,
    conflicted: [],
    staged: [{ path: `mine.ts`, status: `modified` }],
    unstaged: [
        { path: `agent.ts`, status: `modified` },
        { path: `scratch.log`, status: `added` },
    ],
    origins: { "agent.ts": [`a1`] },
    scratch: [{ path: `scratch.log`, reason: `byproduct` }],
    ...over,
});

describe(`commitScopeFor`, () => {
    it(`records git's own selection when something is staged, else everything`, () => {
        expect(commitScopeFor(1)).toEqual({ kind: `staged` });
        expect(commitScopeFor(0)).toEqual({ kind: `everything` });
    });
});

describe(`inScope`, () => {
    const held = repo();
    it(`reads the index, or everything but scratch`, () => {
        expect(inScope({ kind: `staged` }, held, `staged`, `mine.ts`)).toBe(true);
        expect(inScope({ kind: `staged` }, held, `unstaged`, `agent.ts`)).toBe(false);
        expect(inScope({ kind: `everything` }, held, `unstaged`, `agent.ts`)).toBe(true);
        // Every stage-everything leaves scratch out, so a commit that stages for you never takes it.
        expect(inScope({ kind: `everything` }, held, `unstaged`, `scratch.log`)).toBe(false);
    });
    it(`always counts a conflict, which blocks the commit until it is resolved`, () => {
        expect(inScope({ kind: `staged` }, held, `conflicted`, `mine.ts`)).toBe(true);
    });
});

describe(`scopeCommit`, () => {
    it(`records the index as it stands, or stages everything first`, () => {
        expect(scopeCommit({ kind: `staged` }, [repo(), repo({ repo: `other`, staged: [] })])).toEqual({
            groups: [{ repo: `root` }],
            stage: false,
            only: false,
        });
        expect(scopeCommit({ kind: `everything` }, [repo()])).toEqual({ groups: [{ repo: `root` }], stage: true, only: false });
    });
    it(`reaches a repo whose truncated rows could hold something, and says the count is a floor`, () => {
        const cut = repo({ repo: `big`, staged: [], unstaged: [], truncated: { staged: 0, unstaged: 900 } });
        expect(scopeCommit({ kind: `everything` }, [repo(), cut]).groups.map((group) => group.repo)).toEqual([`root`, `big`]);
        expect(scopeFiles({ kind: `everything` }, [repo(), cut])).toEqual({ files: 2, complete: false });
    });
});

describe(`namingOrigin`, () => {
    it(`names the one session every file in the commit came from`, () => {
        const theirs = repo({ staged: [{ path: `agent.ts`, status: `modified` }], unstaged: [] });
        expect(namingOrigin({ kind: `staged` }, [theirs])).toBe(`a1`);
    });
    it(`names nobody when the commit mixes in a file no session landed`, () => {
        expect(namingOrigin({ kind: `everything` }, [repo()])).toBeUndefined();
        expect(namingOrigin({ kind: `staged` }, [repo()])).toBeUndefined();
    });
});

describe(`draftLine`, () => {
    const asking: LandedMessageDraft = {
        startedAt: 0,
        steps: [
            { provider: `cursor`, model: `composer-2.5`, status: `refused`, at: 0, ms: 20_000, reason: `timeout` },
            { provider: `openai`, model: `gpt-6-luna`, status: `asking`, at: 5 },
        ],
    };
    it(`says which model is being asked, since when, and how many already said no`, () => {
        expect(draftLine(asking, false)).toMatchObject({ state: `asking`, since: 5, refused: 1 });
    });
    it(`reads the diff before any model is asked, and settles on written or failed`, () => {
        expect(draftLine({ startedAt: 0, steps: [] }, false)).toEqual({ state: `reading` });
        expect(draftLine({ ...asking, outcome: `failed`, reason: `all refused` }, false)).toEqual({ state: `failed`, refused: 1 });
        expect(
            draftLine(
                { startedAt: 0, steps: [{ provider: `openai`, model: `gpt-6-luna`, status: `answered`, at: 0, ms: 3 }], outcome: `written` },
                true,
            ).state,
        ).toBe(`written`);
    });
    it(`reads a message with no draft report as written, and neither as none`, () => {
        expect(draftLine(undefined, true)).toEqual({ state: `written`, model: undefined });
        expect(draftLine(undefined, false)).toEqual({ state: `none` });
    });
});
