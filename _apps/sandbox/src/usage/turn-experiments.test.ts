import type { UsageTurn } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { MIN_ARM_TURNS, readTurnExperiments } from "./turn-experiments.js";
import type { UsageStore } from "./usage-store.js";

// The turn-level mechanisms' effects are the savings figures that cannot be observed — a turn can't be re-run
// unsteered, or without the context it opened with — so these pin the rules that keep the reported numbers
// honest: only turns the experiment applied to are counted, no delta is reported until both arms are large
// enough to support one, the saving is claimed over the turns that actually ran treated, and each experiment
// is read as its own two populations even when a turn sits in both.

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

// A store that answers with exactly these turns; only `turns` is reached from the report.
const storeOf = (turns: readonly UsageTurn[]): UsageStore =>
    ({
        turns: () => Promise.resolve([...turns]),
    }) as unknown as UsageStore;

const terseArms = (on: number, off: number, onTokens: number, offTokens: number): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) => turn({ terse: true, outputTokens: onTokens + (index % 2) })),
    ...Array.from({ length: off }, (_, index) => turn({ terse: false, outputTokens: offTokens + (index % 2) })),
];

const contextArms = (on: number, off: number, onCost: number, offCost: number): UsageTurn[] => [
    ...Array.from({ length: on }, () => turn({ iqContext: true, costUsd: onCost })),
    ...Array.from({ length: off }, () => turn({ iqContext: false, costUsd: offCost })),
];

test("absent when no turn was in the experiment", async () => {
    // Turns with no arm stamped had the mechanism out of play entirely. Reporting them as a control group is
    // how a number gets attached to a comparison nobody ran.
    expect(await readTurnExperiments(storeOf([turn({}), turn({})]), {})).toEqual({});
});

test("reports both arms but withholds the delta until each clears the threshold", async () => {
    const { output } = await readTurnExperiments(storeOf(terseArms(MIN_ARM_TURNS, MIN_ARM_TURNS - 1, 800, 1200)), {});
    expect(output?.on.turns).toBe(MIN_ARM_TURNS);
    expect(output?.off.turns).toBe(MIN_ARM_TURNS - 1);
    // A delta over an under-powered control is noise wearing a percentage sign — the schema can't express one.
    expect(output?.deltaPct).toBeUndefined();
    expect(output?.marginPct).toBeUndefined();
    expect(output?.saved).toBeUndefined();
});

test("reports the delta, its margin and what it was worth once both arms are big enough", async () => {
    const { output } = await readTurnExperiments(storeOf(terseArms(40, 30, 800, 1200)), {});
    expect(output?.metric).toBe("outputTokens");
    expect(output?.deltaPct).toBeCloseTo(-33.3, 0);
    // The arms are nearly constant here, so the margin is tiny — but it is always reported alongside.
    expect(output?.marginPct).toBeLessThan(1);
    // Claimed over the turns that actually ran steered, not extrapolated across turns that never were.
    expect(output?.saved).toBe(Math.round((1200.5 - 800.5) * 40));
});

test("the pre-injection experiment is judged on cost, at sub-cent precision", async () => {
    // A cheaper treated arm: the injected context costs input tokens and buys back the search turns. Rounding
    // this through the token rounder — the bug the per-metric rounder exists to prevent — reports every arm
    // as $0 and every delta as absent.
    const { context } = await readTurnExperiments(storeOf(contextArms(40, 30, 0.042, 0.06)), {});
    expect(context?.metric).toBe("costUsd");
    expect(context?.on.mean).toBe(0.042);
    expect(context?.off.mean).toBe(0.06);
    expect(context?.deltaPct).toBeCloseTo(-30, 0);
    expect(context?.saved).toBeCloseTo((0.06 - 0.042) * 40, 4);
});

test("each experiment reads its own arms, so a turn in both counts in both", async () => {
    // The two coin flips are independent, so the other experiment's arm is just noise spread across these two.
    const both = [
        ...Array.from({ length: 40 }, () => turn({ terse: true, iqContext: true, outputTokens: 800, costUsd: 0.04 })),
        ...Array.from({ length: 30 }, () => turn({ terse: false, iqContext: false, outputTokens: 1200, costUsd: 0.06 })),
    ];
    const { output, context } = await readTurnExperiments(storeOf(both), {});
    expect(output?.on.turns).toBe(40);
    expect(context?.on.turns).toBe(40);
    expect(output?.metric).toBe("outputTokens");
    expect(context?.metric).toBe("costUsd");
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
