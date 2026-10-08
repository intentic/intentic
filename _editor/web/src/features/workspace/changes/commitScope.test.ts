import type { LandedMessageDraft, RepoChanges } from "@intentic/sandbox-contract";
import { defaultScope, draftLine, inScope, scopeCommit, scopeFiles, scopeStillHolds } from "./commitScope";

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

const legend = (agents: readonly string[], yours: number) => ({ agents: agents.map((id) => ({ id, files: 1 })), yours });

describe(`defaultScope`, () => {
    it(`opens on a session the commit was asked to be named after, while it still has work here`, () => {
        expect(defaultScope({ namedAfter: `a1`, staged: 3, legend: legend([`a1`], 1) })).toEqual({ kind: `origin`, id: `a1` });
        expect(defaultScope({ namedAfter: `gone`, staged: 3, legend: legend([`a1`], 1) })).toEqual({ kind: `staged` });
    });
    it(`prefers git's own selection, then the one session that is all of it, then everything`, () => {
        expect(defaultScope({ namedAfter: undefined, staged: 1, legend: legend([`a1`], 0) })).toEqual({ kind: `staged` });
        expect(defaultScope({ namedAfter: undefined, staged: 0, legend: legend([`a1`], 0) })).toEqual({ kind: `origin`, id: `a1` });
        expect(defaultScope({ namedAfter: undefined, staged: 0, legend: legend([`a1`, `a2`], 0) })).toEqual({ kind: `everything` });
        expect(defaultScope({ namedAfter: undefined, staged: 0, legend: legend([`a1`], 2) })).toEqual({ kind: `everything` });
    });
});

describe(`inScope`, () => {
    const held = repo();
    it(`reads a session's own files, your unclaimed ones, the index, or everything but scratch`, () => {
        expect(inScope({ kind: `origin`, id: `a1` }, held, `unstaged`, `agent.ts`)).toBe(true);
        expect(inScope({ kind: `origin`, id: `a1` }, held, `staged`, `mine.ts`)).toBe(false);
        expect(inScope({ kind: `yours` }, held, `staged`, `mine.ts`)).toBe(true);
        expect(inScope({ kind: `yours` }, held, `unstaged`, `agent.ts`)).toBe(false);
        expect(inScope({ kind: `staged` }, held, `unstaged`, `agent.ts`)).toBe(false);
        expect(inScope({ kind: `everything` }, held, `unstaged`, `agent.ts`)).toBe(true);
        // Every stage-everything leaves scratch out, so no scope that stages for you takes it.
        expect(inScope({ kind: `everything` }, held, `unstaged`, `scratch.log`)).toBe(false);
    });
    it(`never dims a conflict, which blocks every scope until it is resolved`, () => {
        expect(inScope({ kind: `origin`, id: `a1` }, held, `conflicted`, `mine.ts`)).toBe(true);
    });
});

describe(`scopeCommit`, () => {
    it(`records a session or your own edits alone, so whatever else is staged stays out`, () => {
        expect(scopeCommit({ kind: `origin`, id: `a1` }, [repo()])).toEqual({
            groups: [{ repo: `root`, scope: { origin: `a1` } }],
            stage: true,
            only: true,
        });
        expect(scopeCommit({ kind: `yours` }, [repo()])).toEqual({ groups: [{ repo: `root`, scope: { unlanded: true } }], stage: true, only: true });
    });
    it(`records the index as it stands, or stages everything first`, () => {
        expect(scopeCommit({ kind: `staged` }, [repo(), repo({ repo: `other`, staged: [] })])).toEqual({
            groups: [{ repo: `root` }],
            stage: false,
            only: false,
        });
        expect(scopeCommit({ kind: `everything` }, [repo()])).toEqual({ groups: [{ repo: `root` }], stage: true, only: false });
    });
    it(`leaves out a repo the session never touched, unless its truncated rows could hold some`, () => {
        const untouched = repo({ repo: `other`, origins: {} });
        expect(scopeCommit({ kind: `origin`, id: `a1` }, [repo(), untouched]).groups.map((group) => group.repo)).toEqual([`root`]);
        const cut = repo({ repo: `big`, origins: {}, truncated: { staged: 0, unstaged: 900 } });
        expect(scopeCommit({ kind: `origin`, id: `a1` }, [repo(), cut]).groups.map((group) => group.repo)).toEqual([`root`, `big`]);
        expect(scopeFiles({ kind: `origin`, id: `a1` }, [repo(), cut])).toEqual({ files: 1, complete: false });
    });
});

it(`retires a pick that has nothing left to record`, () => {
    expect(scopeStillHolds({ kind: `origin`, id: `a1` }, { staged: 0, legend: legend([], 1) })).toBe(false);
    expect(scopeStillHolds({ kind: `staged` }, { staged: 0, legend: legend([`a1`], 0) })).toBe(false);
    expect(scopeStillHolds({ kind: `yours` }, { staged: 0, legend: legend([`a1`], 1) })).toBe(true);
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
