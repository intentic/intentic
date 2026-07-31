import type { InputSavings, TurnExperiment } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { compositionOf, savedByCleaner, stageLabel, verdictOf } from "./savingsChart";

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

// The three savings cards are only scannable if every one of them puts an ANSWER in the headline slot — a
// figure when there is one, a word when there isn't. So the states a card can be in are enumerated here rather
// than trusted to three templates that drifted apart once already.

const experiment = (overrides: Partial<TurnExperiment> = {}): TurnExperiment => ({
    metric: `outputTokens`,
    on: { turns: 133, mean: 38_500 },
    off: { turns: 14, mean: 28_100 },
    minTurns: 30,
    ...overrides,
});

describe(`verdictOf`, () => {
    it(`states a measured saving as a signed, arrowed delta carrying its margin`, () => {
        const verdict = verdictOf(experiment({ deltaPct: -12, marginPct: 4, saved: 91_000 }));
        expect(verdict).toMatchObject({ value: `↓12%`, unit: `output tokens per turn`, tone: `success` });
        expect(verdict.detail).toBe(`±4pp (95%) · ~91K tokens saved in this range`);
    });

    it(`states an increase without alarm — an experiment that says the mechanism cost more is working`, () => {
        expect(verdictOf(experiment({ deltaPct: 7, marginPct: 3 }))).toMatchObject({ value: `↑7%`, tone: `content` });
    });

    it(`scores the cost experiment in money, because that is the only unit its trade nets out in`, () => {
        const verdict = verdictOf(experiment({ metric: `costUsd`, deltaPct: -5, marginPct: 2, saved: 1.2 }));
        expect(verdict.unit).toBe(`cost per turn`);
        expect(verdict.detail).toBe(`±2pp (95%) · ~$1.20 saved in this range`);
    });

    it(`answers "Measuring" in the same slot a delta would take, and says what it is still short of`, () => {
        const verdict = verdictOf(experiment());
        expect(verdict).toMatchObject({ value: `Measuring`, tone: `muted` });
        // The shorter arm is the control's 14, against a threshold of 30.
        expect(verdict.detail).toBe(`needs 30 turns per arm — 16 more on the shorter one`);
    });

    it(`treats an experiment that isn't running as a verdict of its own, not a missing card`, () => {
        expect(verdictOf(undefined)).toMatchObject({ value: `Off`, unit: `not being measured`, tone: `muted` });
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
