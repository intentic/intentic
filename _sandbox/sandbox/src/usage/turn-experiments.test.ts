import type { UsageTurn } from "@intentic/sandbox-contract";
import { MIN_ARM_TURNS } from "@intentic/agent-context/arm-stats";
import { readTurnExperiments } from "./turn-experiments.js";
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

test("a re-spelled iq cohort hash is read together with the revision it re-spells", async () => {
    const rows = [
        turn({ at: 1, conversationId: "older-on", iqSearchArm: true, iqSearchCohort: "9fca5b085548", searchCalls: 50 }),
        turn({ at: 2, conversationId: "sep-on", iqSearchArm: true, iqSearchCohort: "af7b1874e40c", searchCalls: 2 }),
        turn({ at: 2, conversationId: "sep-off", iqSearchArm: false, iqSearchCohort: "af7b1874e40c", searchCalls: 6 }),
        turn({ at: 3, conversationId: "oct-on", iqSearchArm: true, iqSearchCohort: "afccafc52ce9", searchCalls: 4 }),
        turn({ at: 3, conversationId: "oct-off", iqSearchArm: false, iqSearchCohort: "afccafc52ce9", searchCalls: 8 }),
    ];
    const { search } = await readTurnExperiments(storeOf(rows), {});
    expect(search?.cohort).toBe("af7b1874e40c");
    expect(search?.metrics[0]).toMatchObject({ on: { turns: 2, mean: 3 }, off: { turns: 2, mean: 7 } });
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

// One runaway conversation used to carry its arm: identical arms read 42 vs 28 on the ledger, and a shuffled-label check
// called one no-effect split in ten significant. Capped at the pooled 95th percentile, it counts as high, not unbounded.
test("one runaway conversation counts as high, not as a difference between the arms", async () => {
    const arms = [...searchArms(40, 40, 2, 2), turn({ conversationId: "runaway", iqSearchArm: true, searchCalls: 900, openingSearches: 450 })];
    const { search } = await readTurnExperiments(storeOf(arms), {});
    expect(search?.metrics[0].on.mean).toBe(2);
    expect(search?.metrics[0].deltaPct).toBeUndefined();
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

const mapConversation = (id: string, arm: boolean, listings: readonly number[], over: Partial<UsageTurn> = {}): UsageTurn[] =>
    listings.map((openingListings, index) => turn({ conversationId: id, mapArm: arm, turnIndex: index, at: index + 1, openingListings, ...over }));

// `onShare` of the treated conversations' opening turns list the root once and the rest list nothing; likewise `offShare`.
const mapArms = (on: number, off: number, onShare: number, offShare: number, over: Partial<UsageTurn> = {}): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) => mapConversation(`on-${index}`, true, [index < Math.round(on * onShare) ? 1 : 0], over)).flat(),
    ...Array.from({ length: off }, (_, index) => mapConversation(`off-${index}`, false, [index < Math.round(off * offShare) ? 1 : 0], over)).flat(),
];

test("the map is judged on the share of opening turns that listed directories", async () => {
    const { map } = await readTurnExperiments(storeOf(mapArms(40, 40, 0.3, 0.6)), {});
    expect(map?.metrics.map((reading) => reading.metric)).toEqual(["openedWithListing", "callsBeforeTarget"]);
    expect(map?.sampleUnit).toBe("opening turns");
    expect(map?.metrics[0]).toMatchObject({ on: { turns: 40, mean: 0.3 }, off: { turns: 40, mean: 0.6 } });
    expect(map?.metrics[0].deltaPct).toBeCloseTo(-50, 0);
});

// Three listings are one turn that listed, not three times the evidence.
test("a turn that listed several times counts once", async () => {
    const arms = [
        ...Array.from({ length: 30 }, (_, index) => mapConversation(`on-${index}`, true, [index < 15 ? 3 : 0])).flat(),
        ...Array.from({ length: 30 }, (_, index) => mapConversation(`off-${index}`, false, [index < 15 ? 1 : 0])).flat(),
    ];
    const { map } = await readTurnExperiments(storeOf(arms), {});
    expect(map?.metrics[0]).toMatchObject({ on: { mean: 0.5 }, off: { mean: 0.5 } });
});

// Capped at the pooled 95th percentile, a share under 5% would read as nobody listing at all.
test("a rare listing is not capped away", async () => {
    const { map } = await readTurnExperiments(storeOf(mapArms(100, 100, 0.03, 0.04)), {});
    expect(map?.metrics[0]).toMatchObject({ on: { mean: 0.03 }, off: { mean: 0.04 } });
});

/* Only the opening turn is sampled because later turns lack the opening note. */
test("only the opening turn of a conversation is the map's sample", async () => {
    const arms = [
        ...Array.from({ length: 40 }, (_, index) => mapConversation(`on-${index}`, true, [0, 9, 9, 9])).flat(),
        ...Array.from({ length: 40 }, (_, index) => mapConversation(`off-${index}`, false, [2, 9, 9, 9])).flat(),
    ];
    const { map } = await readTurnExperiments(storeOf(arms), {});
    expect(map?.metrics[0]).toMatchObject({ on: { turns: 40, mean: 0 }, off: { turns: 40, mean: 1 } });
});

/* A conversation whose opening turn fell outside the window contributes nothing rather than offering its. */
test("a conversation whose opening turn is missing is not counted", async () => {
    const arms = [
        ...mapArms(30, 30, 0.5, 1),
        ...Array.from({ length: 20 }, (_, index) =>
            [4, 5].map((turnIndex) => turn({ conversationId: `late-${index}`, mapArm: true, turnIndex, at: turnIndex, openingListings: 9 })),
        ).flat(),
    ];
    const { map } = await readTurnExperiments(storeOf(arms), {});
    expect(map?.metrics[0]).toMatchObject({ on: { turns: 30, mean: 0.5 }, off: { turns: 30, mean: 1 } });
});

/* ---- an earlier comparison's answer, kept while a restarted one is early ---- */

const cohortArms = (cohort: string | undefined, at: number, on: number, off: number, onShare: number, offShare: number): UsageTurn[] =>
    mapArms(on, off, onShare, offShare, cohort === undefined ? { at } : { at, mapCohort: cohort }).map((row) => ({
        ...row,
        conversationId: `${cohort ?? "unstamped"}-${row.conversationId ?? ""}`,
    }));

test("a restarted comparison carries the last one that reached an answer, with its dates", async () => {
    const rows = [...cohortArms(undefined, 1000, 60, 60, 0.2, 0.5), ...cohortArms("map-vs-none-2", 5000, 5, 5, 0, 1)];
    const { map } = await readTurnExperiments(storeOf(rows), {});
    expect(map?.cohort).toBe("map-vs-none-2");
    expect(map?.metrics[0].marginPct).toBeUndefined();
    expect(map?.previous).toMatchObject({ from: 1000, to: 1000, metrics: [{ metric: "openedWithListing", on: { mean: 0.2 }, off: { mean: 0.5 } }] });
    expect(map?.previous?.metrics[0]?.deltaPct).toBeCloseTo(-60, 0);
    // Opening turns edited nothing here, so the second reading never answered and is not carried.
    expect(map?.previous?.metrics).toHaveLength(1);
});

test("an earlier comparison of two maps is not carried as the map against none", async () => {
    const rows = [
        ...cohortArms(undefined, 1000, 60, 60, 0.2, 0.5),
        ...cohortArms("compact-vs-full", 3000, 60, 60, 0.1, 0.4),
        ...cohortArms("map-vs-none-2", 5000, 5, 5, 0, 1),
    ];
    const { map } = await readTurnExperiments(storeOf(rows), {});
    expect(map?.previous?.from).toBe(1000);
    expect(map?.previous?.cohort).toBeUndefined();
});

test("nothing is carried when no earlier comparison reached an answer", async () => {
    const rows = [...cohortArms("map-vs-none", 1000, 10, 10, 0.2, 0.5), ...cohortArms("map-vs-none-2", 5000, 5, 5, 0, 1)];
    const { map } = await readTurnExperiments(storeOf(rows), {});
    expect(map?.previous).toBeUndefined();
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
