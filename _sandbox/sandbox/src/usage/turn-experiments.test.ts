import type { UsageTurn } from "@intentic/sandbox-contract/schemas/providers/usage";
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

test("absent when no turn was in the experiment", async () => {
    expect(await readTurnExperiments(storeOf([turn({}), turn({})]), {})).toEqual({});
});

const toolArms = (on: number, off: number, onPrompt: number, offPrompt: number): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) =>
        turn({ conversationId: `on-${index}`, toolSearchArm: true, openingCacheReadTokens: onPrompt - 1000, openingCacheCreationTokens: 1000, failedCalls: 1 }),
    ),
    ...Array.from({ length: off }, (_, index) =>
        turn({ conversationId: `off-${index}`, toolSearchArm: false, openingCacheReadTokens: offPrompt - 1000, openingCacheCreationTokens: 1000, failedCalls: 1 }),
    ),
];

// The opening prompt a turn sent, as tool search reads it: cache reads plus writes.
const promptTurn = (conversationId: string, arm: boolean, prompt: number, over: Partial<UsageTurn> = {}): UsageTurn =>
    turn({ conversationId, toolSearchArm: arm, openingCacheReadTokens: prompt - 1000, openingCacheCreationTokens: 1000, ...over });

test("reports both arms but withholds the delta until each clears the threshold", async () => {
    const { toolSearch } = await readTurnExperiments(storeOf(toolArms(MIN_ARM_TURNS, MIN_ARM_TURNS - 1, 30_000, 60_000)), {});
    expect(toolSearch?.metrics[0].on.turns).toBe(MIN_ARM_TURNS);
    expect(toolSearch?.metrics[0].off.turns).toBe(MIN_ARM_TURNS - 1);
    expect(toolSearch?.metrics[0].deltaPct).toBeUndefined();
    expect(toolSearch?.metrics[0].marginPct).toBeUndefined();
    expect(toolSearch?.metrics[0].saved).toBeUndefined();
});

test("a long conversation contributes one sample rather than manufacturing independent turns", async () => {
    const arms = [...Array.from({ length: 20 }, () => promptTurn("one-long-chat", true, 20_000)), promptTurn("one-control", false, 50_000)];
    const { toolSearch } = await readTurnExperiments(storeOf(arms), {});
    expect(toolSearch?.metrics[0]).toMatchObject({ on: { turns: 1, mean: 20_000 }, off: { turns: 1, mean: 50_000 } });
});

test("a delta whose margin spans zero is not a delta: only its resolution is reported", async () => {
    const noisy = [
        ...Array.from({ length: 40 }, (_, index) => promptTurn(`on-${index}`, true, index % 2 === 0 ? 2_000 : 18_000)),
        ...Array.from({ length: 40 }, (_, index) => promptTurn(`off-${index}`, false, index % 2 === 0 ? 1_500 : 18_000)),
    ];
    const { toolSearch } = await readTurnExperiments(storeOf(noisy), {});
    expect(toolSearch?.metrics[0].on.turns).toBe(40);
    expect(toolSearch?.metrics[0].marginPct).toBeGreaterThan(0);
    expect(toolSearch?.metrics[0].deltaPct).toBeUndefined();
    expect(toolSearch?.metrics[0].saved).toBeUndefined();
});

// One runaway conversation used to carry its arm: identical arms read 42 vs 28 on the ledger, and a shuffled-label check
// called one no-effect split in ten significant. Capped at the pooled 95th percentile, it counts as high, not unbounded.
test("one runaway conversation counts as high, not as a difference between the arms", async () => {
    const arms = [...toolArms(40, 40, 20_000, 20_000), promptTurn("runaway", true, 9_000_000)];
    const { toolSearch } = await readTurnExperiments(storeOf(arms), {});
    expect(toolSearch?.metrics[0].on.mean).toBe(20_000);
    expect(toolSearch?.metrics[0].deltaPct).toBeUndefined();
});

test("failed and cancelled turns are dropped from the population", async () => {
    const healthy = toolArms(MIN_ARM_TURNS, MIN_ARM_TURNS, 40_000, 40_000);
    const failures = Array.from({ length: MIN_ARM_TURNS }, () => promptTurn("fail", true, 2_000, { outcome: "error" }));
    const stopped = Array.from({ length: MIN_ARM_TURNS }, () => promptTurn("stop", true, 2_000, { outcome: "cancelled" }));

    const clean = await readTurnExperiments(storeOf(healthy), {});
    const polluted = await readTurnExperiments(storeOf([...healthy, ...failures, ...stopped]), {});

    expect(polluted.toolSearch).toEqual(clean.toolSearch);
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

// Codex counts about twelve failed calls a turn to Claude Code's two: pooled, a comparison reads the two loops' mix.
test("a comparison is read within the loop that ran most of its conversations", async () => {
    const claude = mapArms(MIN_ARM_TURNS, MIN_ARM_TURNS, 0.5, 1);
    const codex = mapArms(5, 5, 0, 0).map((row) => ({ ...row, conversationId: `codex-${row.conversationId}`, provider: "codex", runtime: "codex" }));
    const { map } = await readTurnExperiments(storeOf([...claude, ...codex]), {});
    expect(map?.metrics[0].on).toEqual({ turns: MIN_ARM_TURNS, mean: 0.5 });
    expect(map?.metrics[0].off).toEqual({ turns: MIN_ARM_TURNS, mean: 1 });
});

test("a row from before the loop was recorded is placed by its provider and harness", async () => {
    // Rows of 2026-10-12 and earlier carry no `runtime`; Claude on its own loop is Claude Code, as a recorded one says.
    const old = mapArms(20, 20, 0.5, 1);
    const recent = mapArms(20, 20, 0.5, 1).map((row) => ({ ...row, conversationId: `recent-${row.conversationId}`, runtime: "claude-code" }));
    expect((await readTurnExperiments(storeOf([...old, ...recent]), {})).map?.metrics[0].on.turns).toBe(40);
});

test("tool search is judged on the opening request's prompt, then on failed calls, per conversation", async () => {
    const { toolSearch } = await readTurnExperiments(storeOf(toolArms(40, 40, 30_000, 80_000)), {});
    expect(toolSearch?.metrics.map((reading) => reading.metric)).toEqual(["openingPrompt", "failedCalls"]);
    expect(toolSearch?.sampleUnit).toBe("conversations");
    expect(toolSearch?.metrics[0]).toMatchObject({ on: { turns: 40, mean: 30_000 }, off: { turns: 40, mean: 80_000 } });
});

test("a turn that reported only half of its opening request is not read as a prompt", async () => {
    const rows = [
        turn({ conversationId: "on", toolSearchArm: true, openingCacheReadTokens: 30_000 }),
        turn({ conversationId: "off", toolSearchArm: false, openingCacheReadTokens: 70_000, openingCacheCreationTokens: 10_000 }),
    ];
    const { toolSearch } = await readTurnExperiments(storeOf(rows), {});
    expect(toolSearch?.metrics[0]).toMatchObject({ on: { turns: 0 }, off: { turns: 1, mean: 80_000 } });
});

test("cold trim compares eligible arms on opening prompt and failed calls, including controls that did not trim", async () => {
    const rows = [
        ...Array.from({ length: 40 }, (_, i) =>
            turn({
                conversationId: `on-${i}`,
                coldTrimArm: true,
                coldTrimmed: 20,
                openingCacheReadTokens: 0,
                openingCacheCreationTokens: 50_000,
                failedCalls: 2,
            }),
        ),
        ...Array.from({ length: 40 }, (_, i) =>
            turn({ conversationId: `off-${i}`, coldTrimArm: false, openingCacheReadTokens: 0, openingCacheCreationTokens: 150_000, failedCalls: 1 }),
        ),
        turn({ conversationId: "warm", openingCacheCreationTokens: 999_999, failedCalls: 99 }),
    ];
    const { coldTrim } = await readTurnExperiments(storeOf(rows), {});
    expect(coldTrim?.sampleUnit).toBe("conversations");
    expect(coldTrim?.metrics.map(({ metric }) => metric)).toEqual(["openingPrompt", "failedCalls"]);
    expect(coldTrim?.metrics[0]).toMatchObject({ on: { turns: 40, mean: 50_000 }, off: { turns: 40, mean: 150_000 } });
    expect(coldTrim?.metrics[1]).toMatchObject({ on: { turns: 40, mean: 2 }, off: { turns: 40, mean: 1 } });
});
