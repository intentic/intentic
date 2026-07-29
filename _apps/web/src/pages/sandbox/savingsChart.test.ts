import type { InputSavings } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { compositionOf, savedByCleaner, stageLabel } from "./savingsChart";

// The composition bar's one invariant: its segments are a decomposition of the raw output, so they sum to it
// exactly. Everything else on the card is read against that — a stack whose parts don't add up to the whole is
// not a budget, it's a picture.

const report = (overrides: Partial<InputSavings> = {}): InputSavings => ({
    source: `native`,
    windowed: true,
    commands: 10,
    rawTokens: 10_000,
    // 10_000 raw − 7_900 removed + 100 of footers added back. The fixture holds the identity the daemon's
    // aggregation guarantees, because that identity is what the chart is a picture of.
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
        // Raw − everything the mechanisms removed, which is exactly the emitted total minus the footers the
        // filter added back — the reason the footer is disclosed separately instead of stacked.
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
        // Five named mechanisms, one fold, one residual.
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
        // An id from a newer daemon than this browser: shown as itself rather than dropped.
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
