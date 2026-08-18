import type { UsageTurn } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { MIN_ARM_TURNS, readTurnExperiments } from "./turn-experiments.js";
import type { UsageStore } from "./usage-store.js";

// The turn-level mechanisms' effects are the savings figures that cannot be observed — a turn can't be re-run
// unsteered — so these pin the rules that keep the reported numbers honest: only turns the experiment applied
// to are counted, no delta is reported until both arms are large enough to support one, the saving is claimed
// over the turns that actually ran treated, and each experiment is read as its own two populations even when a
// turn sits in both.

const turn = (overrides: Partial<UsageTurn>): UsageTurn => ({
    at: 1,
    day: "2026-07-29",
    provider: "claude",
    harness: "native",
    turns: 1,
    inputTokens: 100,
    outputTokens: 1000,
    proseChars: 1000,
    searchCalls: 4,
    openingSearches: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    durationMs: 1000,
    ...overrides,
});

// A store that answers with exactly these turns; only `turns` is reached from the report.
const storeOf = (turns: readonly UsageTurn[]): UsageStore =>
    ({
        turns: () => Promise.resolve([...turns]),
    }) as unknown as UsageStore;

const terseArms = (on: number, off: number, onProse: number, offProse: number): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) => turn({ terse: true, proseChars: onProse + (index % 2) })),
    ...Array.from({ length: off }, (_, index) => turn({ terse: false, proseChars: offProse + (index % 2) })),
];

// One-turn conversations, so a conversation's mean per turn is the turn's own reading.
const searchArms = (on: number, off: number, onSearches: number, offSearches: number): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) =>
        turn({ conversationId: `on-${index}`, iqSearchArm: true, searchCalls: onSearches, openingSearches: onSearches / 2 }),
    ),
    ...Array.from({ length: off }, (_, index) =>
        turn({ conversationId: `off-${index}`, iqSearchArm: false, searchCalls: offSearches, openingSearches: offSearches / 2 }),
    ),
];

test("absent when no turn was in the experiment", async () => {
    // Turns with no arm stamped had the mechanism out of play entirely. Reporting them as a control group is
    // how a number gets attached to a comparison nobody ran.
    expect(await readTurnExperiments(storeOf([turn({}), turn({})]), {})).toEqual({});
});

test("reports both arms but withholds the delta until each clears the threshold", async () => {
    const { output } = await readTurnExperiments(storeOf(terseArms(MIN_ARM_TURNS, MIN_ARM_TURNS - 1, 800, 1200)), {});
    expect(output?.metrics[0].on.turns).toBe(MIN_ARM_TURNS);
    expect(output?.metrics[0].off.turns).toBe(MIN_ARM_TURNS - 1);
    // A delta over an under-powered control is noise wearing a percentage sign — the schema can't express one.
    expect(output?.metrics[0].deltaPct).toBeUndefined();
    expect(output?.metrics[0].marginPct).toBeUndefined();
    expect(output?.metrics[0].saved).toBeUndefined();
});

test("reports the delta, its margin and what it was worth once both arms are big enough", async () => {
    const { output } = await readTurnExperiments(storeOf(terseArms(40, 30, 800, 1200)), {});
    expect(output?.metrics[0].metric).toBe("proseChars");
    expect(output?.metrics[0].deltaPct).toBeCloseTo(-33.3, 0);
    // The arms are nearly constant here, so the margin is tiny — but it is always reported alongside.
    expect(output?.metrics[0].marginPct).toBeLessThan(1);
    // Claimed over the turns that actually ran steered, not extrapolated across turns that never were.
    expect(output?.metrics[0].saved).toBe(Math.round((1200.5 - 800.5) * 40));
});

/* SEARCH MEANS ARE REPORTED TO THE TENTH: put through the character rounder a mean of 3.2 reads as 3 and both
 * arms collapse onto the same integer. The rounder rides with the metric for exactly this. */
test("the search experiment is judged on searches, to the tenth", async () => {
    const { search } = await readTurnExperiments(storeOf(searchArms(40, 30, 3.2, 6.4)), {});
    expect(search?.metrics[0].metric).toBe("searchCalls");
    expect(search?.metrics[0].on.mean).toBe(3.2);
    expect(search?.metrics[0].off.mean).toBe(6.4);
    expect(search?.metrics[0].deltaPct).toBeCloseTo(-50, 0);
});

test("iq search teaching is measured on its conversation-stable arm", async () => {
    const arms = [
        ...Array.from({ length: 40 }, (_, index) => turn({ conversationId: `on-${index}`, iqSearchArm: true, searchCalls: 2, openingSearches: 1 })),
        ...Array.from({ length: 30 }, (_, index) => turn({ conversationId: `off-${index}`, iqSearchArm: false, searchCalls: 5, openingSearches: 3 })),
    ];
    const { search } = await readTurnExperiments(storeOf(arms), {});
    expect(search?.metrics.map((reading) => reading.metric)).toEqual(["searchCalls", "openingSearches"]);
    expect(search?.sampleUnit).toBe("conversations");
    expect(search?.metrics[0]).toMatchObject({ on: { turns: 40, mean: 2 }, off: { turns: 30, mean: 5 } });
    expect(search?.metrics[0].saved).toBeUndefined();
});

test("iq search results do not mix instruction revisions into one unnamed experiment", async () => {
    const rows = [
        turn({ at: 1, conversationId: "old-on", iqSearchArm: true, iqSearchCohort: "old", searchCalls: 20 }),
        turn({ at: 1, conversationId: "old-off", iqSearchArm: false, iqSearchCohort: "old", searchCalls: 20 }),
        turn({ at: 2, conversationId: "new-on", iqSearchArm: true, iqSearchCohort: "new", searchCalls: 2 }),
        turn({ at: 2, conversationId: "new-off", iqSearchArm: false, iqSearchCohort: "new", searchCalls: 5 }),
    ];
    const { search } = await readTurnExperiments(storeOf(rows), {});
    expect(search?.cohort).toBe("new");
    expect(search?.metrics[0]).toMatchObject({ on: { turns: 1, mean: 2 }, off: { turns: 1, mean: 5 } });
});

test("an unstamped newest row cannot revert iq search reporting to the legacy cohort", async () => {
    const rows = [
        turn({ at: 1, conversationId: "legacy", iqSearchArm: true, searchCalls: 20 }),
        turn({ at: 2, conversationId: "versioned-on", iqSearchArm: true, iqSearchCohort: "current", searchCalls: 2 }),
        turn({ at: 2, conversationId: "versioned-off", iqSearchArm: false, iqSearchCohort: "current", searchCalls: 5 }),
        turn({ at: 3, conversationId: "missing-stamp", iqSearchArm: true, searchCalls: 30 }),
    ];
    const { search } = await readTurnExperiments(storeOf(rows), {});
    expect(search?.cohort).toBe("current");
    expect(search?.metrics[0]).toMatchObject({ on: { turns: 1, mean: 2 }, off: { turns: 1, mean: 5 } });
});

test("a long iq-search conversation contributes one sample rather than manufacturing independent turns", async () => {
    const arms = [
        ...Array.from({ length: 20 }, () => turn({ conversationId: "one-long-chat", iqSearchArm: true, searchCalls: 2 })),
        turn({ conversationId: "one-control", iqSearchArm: false, searchCalls: 5 }),
    ];
    const { search } = await readTurnExperiments(storeOf(arms), {});
    expect(search?.metrics[0]).toMatchObject({ on: { turns: 1, mean: 2 }, off: { turns: 1, mean: 5 } });
});

test("each experiment reads its own arms, so a turn in both counts in both", async () => {
    // The two coin flips are independent, so the other experiment's arm is just noise spread across these two.
    const both = [
        ...Array.from({ length: 40 }, (_, index) =>
            turn({ conversationId: `on-${index}`, terse: true, iqSearchArm: true, proseChars: 800, searchCalls: 3 }),
        ),
        ...Array.from({ length: 30 }, (_, index) =>
            turn({ conversationId: `off-${index}`, terse: false, iqSearchArm: false, proseChars: 1200, searchCalls: 6 }),
        ),
    ];
    const { output, search } = await readTurnExperiments(storeOf(both), {});
    expect(output?.metrics[0].on.turns).toBe(40);
    expect(search?.metrics[0].on.turns).toBe(40);
    expect(output?.metrics[0].metric).toBe("proseChars");
    expect(search?.metrics[0].metric).toBe("searchCalls");
});

/* THE SECOND WITHHOLD. Clearing MIN_ARM_TURNS says the normal approximation holds, not that anything has been
 * resolved: the terse steer crossed its thirtieth control turn and published +31.2% ± 35.1pp — an interval from
 * −3.4% to +66.7%, which is no measurement at all, printed as an alarming number pointing the wrong way. The
 * margin still goes out, because "smaller than ±35 points" is the true reading and the one that says to wait. */
test("a delta whose margin spans zero is not a delta — only its resolution is reported", async () => {
    // Arms drawn wide apart per turn but with means a hair apart: big n, big spread, no resolvable effect.
    const noisy = [
        ...Array.from({ length: 40 }, (_, index) => turn({ terse: true, proseChars: index % 2 === 0 ? 200 : 1800 })),
        ...Array.from({ length: 40 }, (_, index) => turn({ terse: false, proseChars: index % 2 === 0 ? 100 : 1800 })),
    ];
    const { output } = await readTurnExperiments(storeOf(noisy), {});
    expect(output?.metrics[0].on.turns).toBe(40);
    expect(output?.metrics[0].marginPct).toBeGreaterThan(0);
    expect(output?.metrics[0].deltaPct).toBeUndefined();
    expect(output?.metrics[0].saved).toBeUndefined();
});

/* "Keep collecting" is only advice if the reader can tell three more days from three more years.
 *
 * AIMED AT A FIXED RESOLUTION, which is the whole correctness of the thing. Sized against the delta currently
 * observed, a real nine-day-old unresolved experiment once asked for fourteen more turns — an estimate divided
 * by noise inherits it and promises an answer next week forever. Against a fixed target the same data asks for
 * hundreds, which is the fact worth printing. */
test("a withheld delta says how many more control turns would settle it", async () => {
    const noisy = [
        ...Array.from({ length: 40 }, (_, index) => turn({ terse: true, proseChars: index % 2 === 0 ? 200 : 1800 })),
        ...Array.from({ length: 40 }, (_, index) => turn({ terse: false, proseChars: index % 2 === 0 ? 100 : 1800 })),
    ];
    const { output } = await readTurnExperiments(storeOf(noisy), {});
    expect(output?.metrics[0].deltaPct).toBeUndefined();
    // A margin many times the target asks for many times the arm — the reading that says this holdout will not
    // get there, rather than that it is nearly done.
    expect(output?.metrics[0].controlTurnsNeeded).toBeGreaterThan(40);
});

/* THE FALSE-IMMINENCE REGRESSION, pinned. A delta sitting just under its own margin is the case where an
 * estimate sized against the effect collapses to nothing: (margin ÷ delta)² is barely above one exactly when
 * the two are close. A wide margin means a wide margin, whatever the effect beside it happens to read, and the
 * arm has to grow by a multiple rather than a handful. */
test("a delta sitting just under its margin still asks for a multiple of the arm, not a handful", async () => {
    const noisy = [
        ...Array.from({ length: 40 }, (_, index) => turn({ terse: true, proseChars: index % 2 === 0 ? 200 : 1800 })),
        ...Array.from({ length: 40 }, (_, index) => turn({ terse: false, proseChars: index % 2 === 0 ? 100 : 1600 })),
    ];
    const { output } = await readTurnExperiments(storeOf(noisy), {});
    expect(output?.metrics[0].deltaPct).toBeUndefined();
    // The delta is within a few points of the margin, which is where the effect-sized form reported single
    // digits. Against a fixed target the arm has to multiply.
    expect(output?.metrics[0].marginPct).toBeGreaterThan(20);
    expect(output?.metrics[0].controlTurnsNeeded).toBeGreaterThan(3 * 40);
});

// Nothing to ask for once the resolution is already tight enough — then the effect is simply smaller than the
// width worth acting on, which is an answer rather than a shortfall.
test("no waiting estimate once the resolution is already good enough", async () => {
    const tight = [
        ...Array.from({ length: 400 }, () => turn({ terse: true, proseChars: 500 })),
        ...Array.from({ length: 400 }, () => turn({ terse: false, proseChars: 500 })),
    ];
    const { output } = await readTurnExperiments(storeOf(tight), {});
    expect(output?.metrics[0].deltaPct).toBeUndefined();
    expect(output?.metrics[0].controlTurnsNeeded).toBeUndefined();
});

// Nothing to wait for once the delta is published — the field is the withheld state's own explanation.
test("a resolved delta carries no waiting estimate", async () => {
    const { output } = await readTurnExperiments(storeOf(terseArms(40, 40, 800, 1200)), {});
    expect(output?.metrics[0].deltaPct).toBeDefined();
    expect(output?.metrics[0].controlTurnsNeeded).toBeUndefined();
});

test("a metric a turn never recorded leaves it out of the population, rather than counting it as zero", async () => {
    const mixed = [
        ...Array.from({ length: 40 }, () => turn({ terse: true, proseChars: 800 })),
        ...Array.from({ length: 30 }, () => turn({ terse: false, proseChars: 1200 })),
        // Rows from before prose was measured. Averaged in as zeros they would drag both means toward nothing.
        ...Array.from({ length: 20 }, () => turn({ terse: true, proseChars: undefined })),
    ];
    const { output } = await readTurnExperiments(storeOf(mixed), {});
    expect(output?.metrics[0].on.turns).toBe(40);
    expect(output?.metrics[0].on.mean).toBe(800);
});

test("only turns inside the window count", async () => {
    const store = storeOf([]);
    let seen: unknown;
    const spy: UsageStore = {
        ...store,
        turns: (query) => {
            seen = query;
            return Promise.resolve([]);
        },
    };
    await readTurnExperiments(spy, { from: "2026-07-01", to: "2026-07-29" });
    expect(seen).toEqual({ from: "2026-07-01", to: "2026-07-29" });
});
