import type { HandoffOffer } from "@intentic/sandbox-contract";
import { handoffLine, handoffOptions } from "./handoffChoice";

// What the pick-up card says about how a held turn continues, from the daemon's own offer.

const OFFER: HandoffOffer = {
    suggested: `trim`,
    basis: `size`,
    carry: { tokens: 431_000 },
    trim: { tokens: 112_000, cleared: 180 },
    summary: { tokens: 42_000, reads: 300_000 },
};

describe(`handoffOptions`, () => {
    it(`offers the ways this turn can take, in one order, marking the suggested one`, () => {
        const options = handoffOptions(OFFER);
        expect(options.map((option) => [option.value, option.label, option.mark])).toEqual([
            [`carry`, `Carry everything`, undefined],
            [`trim`, `Trim old output`, `sparkles`],
            [`summary`, `Summary`, undefined],
        ]);
        expect(options.find((option) => option.value === `trim`)?.markTitle).toBe(`Suggested`);
    });

    it(`leaves out a way the daemon did not offer, and names the owner's default as such`, () => {
        const { summary: _summary, ...noSummary } = OFFER;
        const options = handoffOptions({ ...noSummary, suggested: `carry`, basis: `setting` });
        expect(options.map((option) => option.value)).toEqual([`carry`, `trim`]);
        expect(options[0]?.markTitle).toBe(`Your default in Settings.`);
    });
});

describe(`handoffLine`, () => {
    it(`says what the selected way does with the daemon's sizes, and that it is the suggestion`, () => {
        expect(handoffLine(OFFER, `trim`)).toBe(
            `Keeps every message and tool call, clears 180 older tool outputs: ~112K tokens instead of ~431K. Suggested for a conversation this size.`,
        );
    });

    it(`names what was suggested once the person picks another way`, () => {
        expect(handoffLine(OFFER, `carry`)).toBe(`Keeps everything, and re-reads ~431K tokens on every call of the next turn. Suggested: Trim old output.`);
        expect(handoffLine(OFFER, `summary`)).toBe(
            `A fresh session opened with a summary of the conversation, the latest exchanges and where the work stands: ~42K tokens, after the summary model reads ~300K once. Detail the summary leaves out is gone. Suggested: Trim old output.`,
        );
    });
});
