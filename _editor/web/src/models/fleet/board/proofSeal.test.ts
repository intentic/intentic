import { cardProof, proofMark } from "./proofSeal";

// No mocks: a pure projection of what the last turn showed of its own work, like agentStatus beside it.
const NOW = 1_700_000_000_000;

describe(`proofMark`, () => {
    it(`marks what the last turn showed, and nothing for a turn that changed no code and looked at everything`, () => {
        expect(proofMark(undefined)).toBeUndefined();
        expect(proofMark({ at: NOW, verification: `no-code` })).toBeUndefined();
        expect(proofMark({ at: NOW, verification: `no-code`, unviewed: 0 })).toBeUndefined();
        expect(proofMark({ at: NOW, verification: `unproven` })).toEqual({ verification: `unproven` });
        expect(proofMark({ at: NOW, verification: `failing`, check: `pnpm test src/a.test.ts` })).toEqual({
            verification: `failing`,
            check: `pnpm test src/a.test.ts`,
        });
        expect(proofMark({ at: NOW, verification: `no-code`, unviewed: 3 })).toEqual({ unviewed: 3 });
    });
});

describe(`cardProof`, () => {
    it(`hides the last turn's proof while a new turn is working`, () => {
        const agent = { proof: { at: NOW, verification: `unproven` as const } };
        expect(cardProof(agent, false)).toEqual({ verification: `unproven` });
        expect(cardProof(agent, true)).toBeUndefined();
        expect(cardProof({}, false)).toBeUndefined();
    });
});
