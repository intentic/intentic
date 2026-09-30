import type { TurnExperiment, TurnMetricReading } from "@intentic/sandbox-contract";
import { outcomeOf, shortfallOf, tableOf } from "./experimentReadings";

// Every row of the results table must land in one of four answers, and the arithmetic behind the hover note (the likely
// range, the sample still owed) must say what the daemon's margin says. Pins each state rather than trusting the panel.

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

describe(`outcomeOf`, () => {
    it(`states a measured drop as a whole percent with the likely range around it`, () => {
        // -63.7 ± 29.6: somewhere between 34.1 and 93.3 percent fewer.
        expect(outcomeOf(reading({ deltaPct: -63.7, marginPct: 29.6, saved: 388.4 }))).toEqual({ kind: `lower`, pct: 64, low: 34, high: 93, saved: 388 });
    });

    it(`states a measured rise the same way, as its own kind`, () => {
        expect(outcomeOf(reading({ deltaPct: 7, marginPct: 3 }))).toEqual({ kind: `higher`, pct: 7, low: 4, high: 10 });
    });

    it(`never claims a range that crosses zero`, () => {
        expect(outcomeOf(reading({ deltaPct: -5, marginPct: 5 }))).toMatchObject({ low: 0 });
    });

    it(`leaves out a saving that saved nothing`, () => {
        expect(outcomeOf(reading({ deltaPct: 7, marginPct: 3, saved: -12 }))).not.toHaveProperty(`saved`);
    });

    it(`calls a margin with no delta unclear, and says how big a difference could still hide in it`, () => {
        expect(outcomeOf(reading({ marginPct: 19.5, controlTurnsNeeded: 312 }))).toEqual({ kind: `unclear`, within: 20, needed: 312 });
    });

    it(`says nothing about what more data would buy when the daemon has no estimate`, () => {
        expect(outcomeOf(reading({ marginPct: 35.1 }))).toEqual({ kind: `unclear`, within: 35 });
    });

    it(`calls a reading with no margin yet too early, whatever its averages look like`, () => {
        expect(outcomeOf(reading())).toEqual({ kind: `early` });
    });
});

describe(`tableOf`, () => {
    it(`is undefined while there is no experiment, which the panel says in words`, () => {
        expect(tableOf(undefined)).toBeUndefined();
    });

    // A win on the second reading must be a row like the first, not a footnote under a "No effect".
    it(`makes every reading a row of the same shape, in the daemon's order`, () => {
        const table = tableOf(
            experiment(
                [
                    reading({ metric: `searchCalls`, marginPct: 24.9, controlTurnsNeeded: 838 }),
                    reading({ metric: `openingSearches`, deltaPct: -26.6, marginPct: 12 }),
                ],
                { sampleUnit: `conversations` },
            ),
        );
        expect(table?.rows.map((row) => [row.key, row.outcome.kind])).toEqual([
            [`searchCalls`, `unclear`],
            [`openingSearches`, `lower`],
        ]);
        expect(table?.rows[1]).toMatchObject({ on: 3.2, off: 6.4 });
    });

    it(`counts the groups once, off the shared coin flip`, () => {
        const table = tableOf(experiment([reading()], { sampleUnit: `conversations` }));
        expect(table).toMatchObject({ unit: `conversations`, on: 133, off: 14, minimum: 30 });
    });

    // One opening turn per conversation: the reader counts conversations either way.
    it(`counts the map's opening turns as conversations`, () => {
        expect(tableOf(experiment([reading({ metric: `openingListings` })], { sampleUnit: `opening turns` }))?.unit).toBe(`conversations`);
    });

    it(`counts turns when the experiment names no unit`, () => {
        expect(tableOf(experiment([reading()]))?.unit).toBe(`turns`);
    });
});

describe(`shortfallOf`, () => {
    it(`is what the smaller group still owes`, () => {
        const table = tableOf(experiment([reading({ on: { turns: 84, mean: 1.3 }, off: { turns: 21, mean: 2.1 } })]));
        expect(table === undefined ? undefined : shortfallOf(table)).toBe(9);
    });

    it(`is zero once both groups have enough, and when there is no threshold at all`, () => {
        const table = tableOf(experiment([reading({ on: { turns: 84, mean: 1.3 }, off: { turns: 40, mean: 2.1 } })]));
        expect(table === undefined ? undefined : shortfallOf(table)).toBe(0);
        expect(shortfallOf({ unit: `commands`, on: 3, off: 1, rows: [] })).toBe(0);
    });
});
