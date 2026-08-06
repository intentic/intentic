import type { InputSavings, TurnExperiment, TurnMetricReading } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { compositionOf, dilutionOf, meanLabel, savedByCleaner, stageLabel, verdictsOf } from "./savingsChart";

// The composition bar's one invariant: its segments are a decomposition of the raw output, so they sum to it
// exactly. Everything else on the card is read against that — a stack whose parts don't add up to the whole is
// not a budget, it's a picture.

const report = (overrides: Partial<InputSavings> = {}): InputSavings => ({
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

const reading = (overrides: Partial<TurnMetricReading> = {}): TurnMetricReading => ({
    metric: `proseChars`,
    on: { turns: 133, mean: 38_500 },
    off: { turns: 14, mean: 28_100 },
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
        const verdict = headlineOf([reading({ deltaPct: -12, marginPct: 4, saved: 91_000 })]);
        expect(verdict).toMatchObject({ value: `↓12%`, unit: `prose written per turn`, tone: `success` });
        expect(verdict.detail).toBe(`±4pp (95%) · ~91K chars saved in this range`);
    });

    it(`states an increase without alarm — an experiment that says the mechanism cost more is working`, () => {
        expect(headlineOf([reading({ deltaPct: 7, marginPct: 3 })])).toMatchObject({ value: `↑7%`, tone: `content` });
    });

    /* SEARCHES, NOT COST, and in whole ones. Retrieval removes searching, so searching is the quantity that can
     * see it; cost per turn spent nine days reporting which arm had drawn the bigger jobs. A mean difference
     * carries a spare decimal, and a fifth of a search is not something anybody avoided. */
    it(`scores the retrieval experiment in searches, rounded to ones a turn could actually have run`, () => {
        const verdict = headlineOf([reading({ metric: `searchCalls`, deltaPct: -48, marginPct: 9, saved: 91.4 })]);
        expect(verdict.unit).toBe(`searches per turn`);
        expect(verdict.detail).toBe(`±9pp (95%) · ~91 searches saved in this range`);
    });

    // Two readings, one coin flip: the headline counts every search, the second only the ones before the turn
    // opened a file. Both come back, in the order the daemon put them in — a screen must not have to sort them.
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
        // The shorter arm is the control's 14, against a threshold of 30.
        expect(verdict.detail).toBe(`needs 30 turns per arm — 16 more on the shorter one`);
    });

    /* MEASURED, NO EFFECT — its own verdict, because the reader's next move differs from "Measuring". The steer
     * crossed thirty control turns and published +31.2% ± 35.1pp: an interval from −3.4% to +66.7%, rendered as
     * an alarming number pointing the wrong way. The daemon now withholds the delta and sends the margin alone. */
    it(`says so when the arms are big enough and the effect still isn't resolvable`, () => {
        const verdict = headlineOf([reading({ off: { turns: 31, mean: 28_100 }, marginPct: 35.1 })]);
        expect(verdict).toMatchObject({ value: `No effect`, unit: `measurable in prose written per turn`, tone: `muted` });
        expect(verdict.detail).toBe(`anything real is inside ±35.1pp (95%) — keep collecting`);
    });

    /* "Keep collecting" is not advice a reader can act on — three more days and three more years look the same
     * in it. The estimate is coarse and says so by being an order of magnitude, but it is the difference between
     * waiting and changing the holdout. */
    it(`says how much more control data a withheld delta would need`, () => {
        const verdict = headlineOf([reading({ off: { turns: 31, mean: 28_100 }, marginPct: 35.1, controlTurnsNeeded: 5_800 })]);
        expect(verdict).toMatchObject({ value: `No effect`, tone: `muted` });
        expect(verdict.detail).toBe(`anything real is inside ±35.1pp (95%) — ~5.8K more control turns would settle it`);
    });

    it(`treats an experiment that isn't running as a verdict of its own, not a missing card`, () => {
        expect(verdictsOf(undefined).headline).toMatchObject({ value: `Off`, unit: `not being measured`, tone: `muted` });
        expect(verdictsOf(undefined).also).toHaveLength(0);
    });
});

/* A delta over a mostly-untreated arm is a fraction of the delta over the treated ones, and the number alone
 * cannot say so. Pre-injection's arm is the coin flip by design — so this qualifies EVERY reading over it, which
 * is why it is one sentence beside them rather than a clause repeated inside each. */
describe(`dilutionOf`, () => {
    it(`says how much of the treated arm the mechanism actually reached`, () => {
        expect(dilutionOf(experiment([reading()], { deliveredPct: 19 }))).toBe(`The note actually landed on 19% of the treated arm.`);
    });

    /* …and names what took the rest, with the turns behind it, because 19% delivered reads as a broken mechanism
     * until you can see that most of the shortfall is the eligibility gate declining on prompts that named their
     * own file. Same number, opposite response from whoever is reading the card. */
    it(`names the largest reason the treated arm went untreated`, () => {
        const dilution = dilutionOf(
            experiment([reading()], {
                deliveredPct: 19,
                outcomes: [
                    { outcome: `ineligible`, turns: 227 },
                    { outcome: `note`, turns: 72 },
                    { outcome: `no-hits`, turns: 40 },
                ],
            }),
        );
        expect(dilution).toContain(`Most of the rest was ineligible (227 turns).`);
    });

    it(`is empty for an experiment whose treatment always lands, so no card prints an empty clause`, () => {
        expect(dilutionOf(experiment([reading()]))).toBe(``);
    });
});

// The bars carry the arms' own units, and the two experiments' units are not interchangeable — a chart that
// labelled searches as characters would be a picture of the wrong quantity.
describe(`meanLabel`, () => {
    it(`prints prose compact and searches to the tenth, the same split the daemon rounds on`, () => {
        expect(meanLabel(reading(), 38_500)).toBe(`38.5K chars/turn`);
        expect(meanLabel(reading({ metric: `searchCalls` }), 3.2)).toBe(`3.2 searches/turn`);
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
