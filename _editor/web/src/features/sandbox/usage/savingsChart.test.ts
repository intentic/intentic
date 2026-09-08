import type { InputSavings, TurnExperiment, TurnMetricReading } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { compositionOf, meanLabel, savedByCleaner, stageLabel, verdictsOf } from "./savingsChart";

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

// Every headline slot must show an answer: a figure or a word. Pins each state a card can be in rather than
// trusting three templates to agree.

const reading = (overrides: Partial<TurnMetricReading> = {}): TurnMetricReading => ({
    metric: `searchCalls`,
    on: { turns: 133, mean: 3.2 },
    off: { turns: 14, mean: 6.4 },
    ...overrides,
});

const experiment = (readings: TurnMetricReading[], overrides: Partial<TurnExperiment> = {}): TurnExperiment => ({
    metrics: [readings[0] ?? reading(), ...readings.slice(1)],
    minTurns: 30,
    ...overrides,
});

const headlineOf = (readings: TurnMetricReading[], overrides: Partial<TurnExperiment> = {}) => verdictsOf(experiment(readings, overrides)).headline;

describe(`verdictsOf`, () => {
    it(`states a measured saving as a signed, arrowed delta carrying its margin`, () => {
        const verdict = headlineOf([reading({ deltaPct: -12, marginPct: 4, saved: 91.4 })]);
        expect(verdict).toMatchObject({ value: `↓12%`, unit: `searches per turn`, tone: `success` });
        expect(verdict.detail).toBe(`±4pp (95%) · ~91 searches saved in this range`);
    });

    it(`states an increase without alarm: an experiment that says the mechanism cost more is working`, () => {
        expect(headlineOf([reading({ deltaPct: 7, marginPct: 3 })])).toMatchObject({ value: `↑7%`, tone: `content` });
    });

    it(`scores the search experiment in searches, rounded to ones a turn could actually have run`, () => {
        const verdict = headlineOf([reading({ metric: `searchCalls`, deltaPct: -48, marginPct: 9, saved: 91.4 })]);
        expect(verdict.unit).toBe(`searches per turn`);
        expect(verdict.detail).toBe(`±9pp (95%) · ~91 searches saved in this range`);
    });

    // searchCalls counts every search; openingSearches only those before the first file. Order follows the daemon's
    // list.
    it(`returns every reading an experiment carries, headline first`, () => {
        const verdicts = verdictsOf(
            experiment([
                reading({ metric: `searchCalls`, deltaPct: -48, marginPct: 9 }),
                reading({ metric: `openingSearches`, deltaPct: -61, marginPct: 12 }),
            ]),
        );
        expect(verdicts.headline).toMatchObject({ value: `↓48%`, unit: `searches per turn` });
        expect(verdicts.also).toHaveLength(1);
        expect(verdicts.also[0]).toMatchObject({ value: `↓61%`, unit: `searches before the first file` });
    });

    it(`answers "Measuring" in the same slot a delta would take, and says what it is still short of`, () => {
        const verdict = headlineOf([reading()]);
        expect(verdict).toMatchObject({ value: `Measuring`, tone: `muted` });
        // Shortfall = 30 - 14 (the control arm's turns).
        expect(verdict.detail).toBe(`needs 30 turns per arm, 16 more on the shorter one`);
    });

    it(`names conversations when the teaching experiment randomizes sessions rather than turns`, () => {
        const verdict = headlineOf([reading({ on: { turns: 18, mean: 3 }, off: { turns: 11, mean: 4 } })], {
            sampleUnit: `conversations`,
        });
        expect(verdict.detail).toBe(`needs 30 conversations per arm, 19 more on the shorter one`);
    });

    it(`says so when the arms are big enough and the effect still isn't resolvable`, () => {
        const verdict = headlineOf([reading({ off: { turns: 31, mean: 6.4 }, marginPct: 35.1 })]);
        expect(verdict).toMatchObject({ value: `No effect`, unit: `measurable in searches per turn`, tone: `muted` });
        expect(verdict.detail).toBe(`±35.1pp (95%) · keep collecting`);
    });

    // Rounded to an order of magnitude (5_800 -> 5.8K): coarse, but distinguishes waiting from changing the holdout.
    it(`says how much more control data a withheld delta would need`, () => {
        const verdict = headlineOf([reading({ off: { turns: 31, mean: 6.4 }, marginPct: 35.1, controlTurnsNeeded: 5_800 })]);
        expect(verdict).toMatchObject({ value: `No effect`, tone: `muted` });
        expect(verdict.detail).toBe(`±35.1pp (95%) · ~5.8K more control turns would settle it`);
    });

    it(`treats an experiment that isn't running as a verdict of its own, not a missing card`, () => {
        expect(verdictsOf(undefined).headline).toMatchObject({ value: `Off`, unit: `not being measured`, tone: `muted` });
        expect(verdictsOf(undefined).also).toHaveLength(0);
    });
});

// Units are not interchangeable between experiments; mislabeling one as another's unit pictures the wrong quantity.
describe(`meanLabel`, () => {
    it(`prints searches to the tenth`, () => {
        expect(meanLabel(reading(), 3.2)).toBe(`3.2 searches/turn`);
        expect(meanLabel(reading({ metric: `openingSearches` }), 1.5)).toBe(`1.5 searches/turn`);
    });

    // The map is judged on opening listings and calls before the target file, not searches.
    it(`prints the map's own quantities`, () => {
        expect(meanLabel(reading({ metric: `openingListings` }), 0.3)).toBe(`0.3 listings/turn`);
        expect(meanLabel(reading({ metric: `callsBeforeTarget` }), 4)).toBe(`4 calls`);
    });
});

describe(`the map's verdicts`, () => {
    it(`names the quantity each of its two readings counts`, () => {
        const verdicts = verdictsOf(
            experiment([reading({ metric: `openingListings`, deltaPct: -31, marginPct: 9 }), reading({ metric: `callsBeforeTarget` })], {
                sampleUnit: `opening turns`,
            }),
        );
        expect(verdicts.headline).toMatchObject({ value: `↓31%`, unit: `directory listings opening a conversation`, tone: `success` });
        expect(verdicts.also[0]?.unit).toBe(`calls before the file it edits`);
    });

    it(`counts what it still needs in opening turns`, () => {
        const verdict = verdictsOf(
            experiment([reading({ metric: `openingListings`, on: { turns: 12, mean: 0.3 }, off: { turns: 8, mean: 0.5 } })], {
                sampleUnit: `opening turns`,
            }),
        ).headline;
        expect(verdict.detail).toBe(`needs 30 opening turns per arm, 22 more on the shorter one`);
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
