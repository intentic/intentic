import type { InputSavings } from "@intentic/sandbox-contract";
import { compositionOf, savedByCleaner, stageLabel } from "./savingsChart";

// Composition segments must sum exactly to the raw output; everything else on the card is read against that
// identity.

const report = (overrides: Partial<InputSavings> = {}): InputSavings => ({
    commands: 10,
    rawTokens: 10_000,
    // 10_000 raw - 7_900 removed + 100 footer added back: the identity the daemon's aggregation guarantees.
    emittedTokens: 2200,
    savedPct: 78,
    perCleaner: [
        { id: `cap`, commands: 8, savedTokens: 5000 },
        { id: `pnpm`, commands: 4, savedTokens: 2000 },
        { id: `ansi`, commands: 10, savedTokens: 900 },
        { id: `footer`, commands: 8, savedTokens: -100 },
    ],
    holdout: { cleaned: 9, heldOut: 1 },
    gaps: [],
    ...overrides,
});

describe(`compositionOf`, () => {
    it(`decomposes the raw total exactly, ending with what reached the assistant`, () => {
        const { segments, rawTokens } = compositionOf(report());
        expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(rawTokens);
        expect(segments.at(-1)?.key).toBe(`reached`);
        // 2100 = raw minus everything removed, i.e. emitted minus the footer added back.
        expect(segments.at(-1)?.tokens).toBe(2100);
    });

    it(`keeps the retrieval footer off the stack and reports it as the cost it is`, () => {
        const composition = compositionOf(report());
        expect(composition.segments.map((segment) => segment.key)).not.toContain(`footer`);
        expect(composition.footerTokens).toBe(100);
    });

    it(`folds the tail past the palette's width rather than inventing colours`, () => {
        const perCleaner = Array.from({ length: 9 }, (_, index) => ({ id: `c${index}`, commands: 1, savedTokens: 900 - index * 100 }));
        const { segments } = compositionOf(report({ perCleaner, rawTokens: 10_000 }));
        // 5 named + 1 folded "other" + 1 reached = 7 segments.
        expect(segments).toHaveLength(7);
        expect(segments[5]).toMatchObject({ key: `other`, label: `4 more` });
    });

    it(`draws an empty window as an empty bar rather than dividing by nothing`, () => {
        const { segments, rawTokens } = compositionOf(report({ rawTokens: 0, emittedTokens: 0, perCleaner: [] }));
        expect(rawTokens).toBe(0);
        expect(segments.every((segment) => segment.tokens === 0)).toBe(true);
    });
});

describe(`stageLabel`, () => {
    it(`names the mechanisms with no switch, so a reader can tell those from ones that aren't listed`, () => {
        expect(stageLabel(`ansi`)).toBe(`terminal escapes`);
        expect(stageLabel(`cap`)).toBe(`head/tail cap`);
        // Unknown id (newer daemon than this browser) shown as itself, not dropped.
        expect(stageLabel(`brand-new`)).toBe(`brand-new`);
    });
});

describe(`savedByCleaner`, () => {
    it(`omits a mechanism that saved nothing, so its row can say "not measured" instead of "0"`, () => {
        const saved = savedByCleaner(report({ perCleaner: [{ id: `git`, commands: 3, savedTokens: 0 }] }));
        expect(saved.has(`git`)).toBe(false);
    });

    it(`is empty when the report hasn't loaded`, () => {
        expect(savedByCleaner(undefined).size).toBe(0);
    });
});
