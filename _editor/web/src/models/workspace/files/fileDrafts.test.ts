import { shallowRef } from "vue";
import { withFileDraft, type FileDraftView } from "../../conversations/session/turnLiveState";
import { agentScope, SHARED_SCOPE } from "../../../app/workspaceScope";
import { draftedText, fileDraftOf, followFileDrafts } from "./fileDrafts";

type Fact = Parameters<typeof withFileDraft>[1];
const fact = (at: number, text: string, extra: Partial<Fact> = {}): Fact => ({ kind: `file_draft`, callId: `c1`, path: `a.md`, op: `write`, at, text, ...extra });
const fold = (facts: readonly Fact[]): ReadonlyMap<string, FileDraftView> => facts.reduce<ReadonlyMap<string, FileDraftView>>(withFileDraft, new Map());

describe(`withFileDraft`, () => {
    it(`extends a draft by the stretch that starts where it ends`, () => {
        expect(fold([fact(0, `# Ti`), fact(4, `tle`)]).get(`c1`)).toEqual({ callId: `c1`, path: `a.md`, op: `write`, text: `# Title` });
    });

    it(`rewrites from an earlier stretch, as an attach replaying the turn's facts does`, () => {
        expect(fold([fact(0, `# Title`), fact(0, `# Ti`), fact(4, `tle!`)]).get(`c1`)?.text).toBe(`# Title!`);
    });

    it(`waits rather than drawing a gap when a stretch was missed`, () => {
        expect(fold([fact(0, `ab`), fact(9, `zz`)]).get(`c1`)?.text).toBe(`ab`);
        // A late joiner that missed the first stretch holds nothing until the replay starts it.
        expect(fold([fact(5, `zz`)]).get(`c1`)?.text).toBe(``);
    });

    it(`keeps an edit's old text, its scope and the cap from the frames that said them`, () => {
        const edit = fold([
            fact(0, `ne`, { op: `edit`, old: `old` }),
            fact(2, `w`, { op: `edit`, replaceAll: true }),
            fact(3, ``, { op: `edit`, truncated: true }),
        ]).get(`c1`);
        expect(edit).toEqual({ callId: `c1`, path: `a.md`, op: `edit`, text: `new`, old: `old`, replaceAll: true, truncated: true });
    });

    it(`lets the draft go once its call settled`, () => {
        expect(fold([fact(0, `x`), fact(0, ``, { done: true })]).size).toBe(0);
    });
});

describe(`draftedText`, () => {
    const draft = (extra: Partial<FileDraftView>): FileDraftView => ({ callId: `c1`, path: `a.md`, op: `edit`, text: `NEW`, ...extra });

    it(`is a write's text so far, whatever is on disk`, () => {
        expect(draftedText(`old file`, draft({ op: `write`, text: `# Dra` }))).toBe(`# Dra`);
        expect(draftedText(undefined, draft({ op: `write`, text: `` }))).toBe(``);
    });

    it(`replaces an edit's old text, the first occurrence unless it says every one`, () => {
        expect(draftedText(`a old b old`, draft({ old: `old` }))).toBe(`a NEW b old`);
        expect(draftedText(`a old b old`, draft({ old: `old`, replaceAll: true }))).toBe(`a NEW b NEW`);
    });

    it(`cannot place an edit whose old text is missing, not yet whole, or not in the file`, () => {
        expect(draftedText(`a b`, draft({ old: `zzz` }))).toBeUndefined();
        expect(draftedText(`a b`, draft({ old: `zzz`, replaceAll: true }))).toBeUndefined();
        expect(draftedText(`a b`, draft({}))).toBeUndefined();
        expect(draftedText(undefined, draft({ old: `a` }))).toBeUndefined();
    });

    it(`stands an edit with no old text only over an empty or missing file, which it creates`, () => {
        expect(draftedText(undefined, draft({ old: `` }))).toBe(`NEW`);
        expect(draftedText(``, draft({ old: `` }))).toBe(`NEW`);
        expect(draftedText(`content`, draft({ old: `` }))).toBeUndefined();
    });
});

describe(`fileDraftOf`, () => {
    it(`finds a conversation's draft by file in the copy it writes, and loses it with the turn's drafts`, () => {
        const drafts = shallowRef<ReadonlyMap<string, FileDraftView>>(fold([fact(0, `# A`)]));
        let isolated = true;
        followFileDrafts(`conv-1`, { scope: () => (isolated ? agentScope(`conv-1`) : SHARED_SCOPE), drafts });
        expect(fileDraftOf(`a.md`, agentScope(`conv-1`))?.text).toBe(`# A`);
        // Not the same file in another copy, nor another file.
        expect(fileDraftOf(`a.md`, SHARED_SCOPE)).toBeUndefined();
        expect(fileDraftOf(`a.md`, agentScope(`conv-2`))).toBeUndefined();
        expect(fileDraftOf(`b.md`, agentScope(`conv-1`))).toBeUndefined();
        // A main-tree conversation writes the shared tree.
        isolated = false;
        expect(fileDraftOf(`a.md`, SHARED_SCOPE)?.text).toBe(`# A`);
        // The turn settling clears its drafts, and with them what this finds.
        drafts.value = new Map();
        expect(fileDraftOf(`a.md`, SHARED_SCOPE)).toBeUndefined();
    });

    it(`prefers the call that started last when two write one file`, () => {
        const drafts = shallowRef<ReadonlyMap<string, FileDraftView>>(fold([fact(0, `first`), fact(0, `second`, { callId: `c2` })]));
        followFileDrafts(`conv-3`, { scope: () => agentScope(`conv-3`), drafts });
        expect(fileDraftOf(`a.md`, agentScope(`conv-3`))?.text).toBe(`second`);
    });
});
