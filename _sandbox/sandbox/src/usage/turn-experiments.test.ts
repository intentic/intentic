import type { UsageTurn } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { MIN_ARM_TURNS, readTurnExperiments } from "./turn-experiments.js";
import type { UsageStore } from "./usage-store.js";

const turn = (overrides: Partial<UsageTurn>): UsageTurn => ({
    at: 1,
    day: "2026-07-29",
    provider: "claude",
    harness: "native",
    turns: 1,
    inputTokens: 100,
    outputTokens: 1000,
    searchCalls: 4,
    openingSearches: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    durationMs: 1000,
    ...overrides,
});

const storeOf = (turns: readonly UsageTurn[]): UsageStore =>
    ({
        turns: () => Promise.resolve([...turns]),
    }) as unknown as UsageStore;

const searchArms = (on: number, off: number, onSearches: number, offSearches: number): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) =>
        turn({ conversationId: `on-${index}`, iqSearchArm: true, searchCalls: onSearches, openingSearches: onSearches / 2 }),
    ),
    ...Array.from({ length: off }, (_, index) =>
        turn({ conversationId: `off-${index}`, iqSearchArm: false, searchCalls: offSearches, openingSearches: offSearches / 2 }),
    ),
];

test("absent when no turn was in the experiment", async () => {
    expect(await readTurnExperiments(storeOf([turn({}), turn({})]), {})).toEqual({});
});

test("reports both arms but withholds the delta until each clears the threshold", async () => {
    const { search } = await readTurnExperiments(storeOf(searchArms(MIN_ARM_TURNS, MIN_ARM_TURNS - 1, 3.2, 6.4)), {});
    expect(search?.metrics[0].on.turns).toBe(MIN_ARM_TURNS);
    expect(search?.metrics[0].off.turns).toBe(MIN_ARM_TURNS - 1);
    expect(search?.metrics[0].deltaPct).toBeUndefined();
    expect(search?.metrics[0].marginPct).toBeUndefined();
    expect(search?.metrics[0].saved).toBeUndefined();
});

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

test("a long iq-search conversation contributes one sample rather than manufacturing independent turns", async () => {
    const arms = [
        ...Array.from({ length: 20 }, () => turn({ conversationId: "one-long-chat", iqSearchArm: true, searchCalls: 2 })),
        turn({ conversationId: "one-control", iqSearchArm: false, searchCalls: 5 }),
    ];
    const { search } = await readTurnExperiments(storeOf(arms), {});
    expect(search?.metrics[0]).toMatchObject({ on: { turns: 1, mean: 2 }, off: { turns: 1, mean: 5 } });
});

test("a delta whose margin spans zero is not a delta: only its resolution is reported", async () => {
    const noisy = [
        ...Array.from({ length: 40 }, (_, index) =>
            turn({ conversationId: `on-${index}`, iqSearchArm: true, searchCalls: index % 2 === 0 ? 2 : 18 }),
        ),
        ...Array.from({ length: 40 }, (_, index) =>
            turn({ conversationId: `off-${index}`, iqSearchArm: false, searchCalls: index % 2 === 0 ? 1 : 18 }),
        ),
    ];
    const { search } = await readTurnExperiments(storeOf(noisy), {});
    expect(search?.metrics[0].on.turns).toBe(40);
    expect(search?.metrics[0].marginPct).toBeGreaterThan(0);
    expect(search?.metrics[0].deltaPct).toBeUndefined();
    expect(search?.metrics[0].saved).toBeUndefined();
});

test("failed and cancelled turns are dropped from the population", async () => {
    const healthy = searchArms(MIN_ARM_TURNS, MIN_ARM_TURNS, 4, 4);
    const failures = Array.from({ length: MIN_ARM_TURNS }, () =>
        turn({ conversationId: "fail", iqSearchArm: true, searchCalls: 0, outcome: "error" }),
    );
    const stopped = Array.from({ length: MIN_ARM_TURNS }, () =>
        turn({ conversationId: "stop", iqSearchArm: true, searchCalls: 0, outcome: "cancelled" }),
    );

    const clean = await readTurnExperiments(storeOf(healthy), {});
    const polluted = await readTurnExperiments(storeOf([...healthy, ...failures, ...stopped]), {});

    expect(polluted.search).toEqual(clean.search);
});

/* ---- the project map, judged on the opening turn it was sent to ---- */

const mapConversation = (id: string, arm: boolean, listings: readonly number[]): UsageTurn[] =>
    listings.map((openingListings, index) => turn({ conversationId: id, mapArm: arm, turnIndex: index, at: index + 1, openingListings }));

const mapArms = (on: number, off: number, onListings: number, offListings: number): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) => mapConversation(`on-${index}`, true, [onListings])).flat(),
    ...Array.from({ length: off }, (_, index) => mapConversation(`off-${index}`, false, [offListings])).flat(),
];

test("the map is judged on the listings its note tells the turn not to run", async () => {
    const { map } = await readTurnExperiments(storeOf(mapArms(40, 40, 0.3, 0.6)), {});
    expect(map?.metrics.map((reading) => reading.metric)).toEqual(["openingListings", "callsBeforeTarget"]);
    expect(map?.sampleUnit).toBe("opening turns");
    expect(map?.metrics[0]).toMatchObject({ on: { turns: 40, mean: 0.3 }, off: { turns: 40, mean: 0.6 } });
    expect(map?.metrics[0].deltaPct).toBeCloseTo(-50, 0);
});

/* Only the opening turn is sampled because later turns lack the opening note. */
test("only the opening turn of a conversation is the map's sample", async () => {
    const arms = [
        ...Array.from({ length: 40 }, (_, index) => mapConversation(`on-${index}`, true, [0, 9, 9, 9])).flat(),
        ...Array.from({ length: 40 }, (_, index) => mapConversation(`off-${index}`, false, [2, 9, 9, 9])).flat(),
    ];
    const { map } = await readTurnExperiments(storeOf(arms), {});
    expect(map?.metrics[0]).toMatchObject({ on: { turns: 40, mean: 0 }, off: { turns: 40, mean: 2 } });
});

/* A conversation whose opening turn fell outside the window contributes nothing rather than offering its. */
test("a conversation whose opening turn is missing is not counted", async () => {
    const arms = [
        ...mapArms(30, 30, 1, 2),
        ...Array.from({ length: 20 }, (_, index) =>
            [4, 5].map((turnIndex) => turn({ conversationId: `late-${index}`, mapArm: true, turnIndex, at: turnIndex, openingListings: 9 })),
        ).flat(),
    ];
    const { map } = await readTurnExperiments(storeOf(arms), {});
    expect(map?.metrics[0]).toMatchObject({ on: { turns: 30, mean: 1 }, off: { turns: 30, mean: 2 } });
});

test("a sandbox measuring neither mechanism reports neither", async () => {
    expect(await readTurnExperiments(storeOf([turn({ conversationId: "a" }), turn({ conversationId: "b" })]), {})).toEqual({});
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

// The field notes' own design: every turn is evidence (the brief sits in the prompt all session), the headline is
// failed calls, and a monthly rewrite is a NEW treatment rather than more of the old one.
const notesArms = (revision: string, onFailures: number, offFailures: number, count = MIN_ARM_TURNS): UsageTurn[] => [
    ...Array.from({ length: count }, (_, index) =>
        turn({ conversationId: `${revision}-on-${index}`, notesArm: true, notesCohort: revision, failedCalls: onFailures }),
    ),
    ...Array.from({ length: count }, (_, index) =>
        turn({ conversationId: `${revision}-off-${index}`, notesArm: false, notesCohort: revision, failedCalls: offFailures }),
    ),
];

test("field notes are judged on failed calls, per conversation rather than per opening turn", async () => {
    const { notes } = await readTurnExperiments(storeOf(notesArms("rev1", 1, 3)), {});
    expect(notes?.metrics[0].metric).toBe("failedCalls");
    expect(notes?.sampleUnit).toBe("conversations");
    expect(notes?.metrics[0].on.mean).toBe(1);
    expect(notes?.metrics[0].off.mean).toBe(3);
    expect(notes?.metrics[0].deltaPct).toBeLessThan(0);
});

test("a later turn of a treated conversation counts too, unlike the map's opening-turn sample", async () => {
    // Same conversations, all their evidence on turn 7: a design sampling opening turns alone would see nothing here.
    const later = notesArms("rev1", 1, 3).map((row) => ({ ...row, turnIndex: 7 }));
    expect((await readTurnExperiments(storeOf(later), {})).notes?.metrics[0].on.turns).toBe(MIN_ARM_TURNS);
    expect((await readTurnExperiments(storeOf(later), {})).map).toBeUndefined();
});

test("a monthly rewrite is a new treatment: only the latest revision's turns are pooled", async () => {
    const old = notesArms("rev1", 9, 9);
    const fresh = notesArms("rev2", 1, 3).map((row) => ({ ...row, at: 2 }));
    const { notes } = await readTurnExperiments(storeOf([...old, ...fresh]), {});
    expect(notes?.cohort).toBe("rev2");
    // The old revision's turns are excluded outright rather than averaged in, which would have pulled both arms to 9.
    expect(notes?.metrics[0].on.mean).toBe(1);
    expect(notes?.metrics[0].on.turns).toBe(MIN_ARM_TURNS);
});

// The short form is `on`; the long form, kept by the holdout, is the control it is compared against.
test("the guidance experiment compares failed calls between the short and long forms", async () => {
    const rows = [
        ...Array.from({ length: MIN_ARM_TURNS }, (_, index) =>
            turn({ conversationId: `short-${index}`, guidanceArm: true, guidanceCohort: "g1", failedCalls: index % 2 === 0 ? 1 : 2 }),
        ),
        ...Array.from({ length: MIN_ARM_TURNS }, (_, index) =>
            turn({ conversationId: `long-${index}`, guidanceArm: false, guidanceCohort: "g1", failedCalls: index % 2 === 0 ? 3 : 4 }),
        ),
    ];
    const { guidance, notes } = await readTurnExperiments(storeOf(rows), {});

    expect(notes).toBeUndefined();
    expect(guidance?.cohort).toBe("g1");
    expect(guidance?.sampleUnit).toBe("conversations");
    expect(guidance?.metrics[0]).toMatchObject({
        metric: "failedCalls",
        on: { turns: MIN_ARM_TURNS, mean: 1.5 },
        off: { turns: MIN_ARM_TURNS, mean: 3.5 },
    });
});
