import { arrivingDraft, withoutDraft } from "./agentDraft";

describe(`a first message handed in on the address`, () => {
    it(`reads the draft's word, and nothing from an absent, bare or empty one`, () => {
        expect(arrivingDraft({ draft: `Why does the build fail?` })).toBe(`Why does the build fail?`);
        expect([arrivingDraft({}), arrivingDraft({ draft: `` }), arrivingDraft({ draft: null })]).toEqual([undefined, undefined, undefined]);
    });

    it(`takes the first of a repeated word`, () => {
        expect(arrivingDraft({ draft: [`first`, `second`] })).toBe(`first`);
    });

    it(`takes the word off the address and leaves the rest`, () => {
        expect(withoutDraft({ draft: `text`, rail: `open` })).toEqual({ rail: `open` });
    });
});
