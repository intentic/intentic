import { cardProof, proofMark, sealOf } from "./proofSeal";

// No mocks: the seal is a pure projection of what the last turn showed of its own work, like agentStatus beside it.
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

describe(`sealOf`, () => {
    it(`breaks on a failed check, and leaves the ring open on anything unproven`, () => {
        expect(sealOf({ verification: `failing` })).toBe(`broke`);
        expect(sealOf({ verification: `failing`, unviewed: 2 })).toBe(`broke`);
        expect(sealOf({ verification: `unproven` })).toBe(`open`);
        expect(sealOf({ unviewed: 1 })).toBe(`open`);
    });

    it(`closes only when nothing left it open`, () => {
        expect(sealOf({ verification: `verified`, check: `pnpm test` })).toBe(`closed`);
        expect(sealOf({ verification: `verified` })).toBe(`closed`);
    });

    // A check that passed says nothing about an interface nobody looked at.
    it(`keeps it open when the check passed but an interface changed unseen`, () => {
        expect(sealOf({ verification: `verified`, unviewed: 2 })).toBe(`open`);
    });
});
