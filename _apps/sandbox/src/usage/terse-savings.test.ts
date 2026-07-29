import type { UsageTurn } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { MIN_ARM_TURNS, readOutputSavings } from "./terse-savings.js";
import type { UsageStore } from "./usage-store.js";

// The terse steer's effect is the one savings figure that cannot be observed — a turn can't be re-run
// unsteered — so these pin the three rules that keep the reported number honest: only turns the experiment
// applied to are counted, no delta is reported until both arms are large enough to support one, and the
// saving is claimed over the turns that actually ran steered.

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

const arms = (on: number, off: number, onTokens: number, offTokens: number): UsageTurn[] => [
    ...Array.from({ length: on }, (_, index) => turn({ terse: true, outputTokens: onTokens + (index % 2) })),
    ...Array.from({ length: off }, (_, index) => turn({ terse: false, outputTokens: offTokens + (index % 2) })),
];

test("absent when no turn was in the experiment", async () => {
    // Turns with no arm stamped had the steer out of play entirely. Reporting them as a control group is how a
    // number gets attached to a comparison nobody ran.
    expect(await readOutputSavings(storeOf([turn({}), turn({})]), {})).toBeUndefined();
});

test("reports both arms but withholds the delta until each clears the threshold", async () => {
    const report = await readOutputSavings(storeOf(arms(MIN_ARM_TURNS, MIN_ARM_TURNS - 1, 800, 1200)), {});
    expect(report?.on.turns).toBe(MIN_ARM_TURNS);
    expect(report?.off.turns).toBe(MIN_ARM_TURNS - 1);
    // A delta over an under-powered control is noise wearing a percentage sign — the schema can't express one.
    expect(report?.deltaPct).toBeUndefined();
    expect(report?.marginPct).toBeUndefined();
    expect(report?.savedTokens).toBeUndefined();
});

test("reports the delta, its margin and what it was worth once both arms are big enough", async () => {
    const report = await readOutputSavings(storeOf(arms(40, 30, 800, 1200)), {});
    expect(report?.deltaPct).toBeCloseTo(-33.3, 0);
    // The arms are nearly constant here, so the margin is tiny — but it is always reported alongside.
    expect(report?.marginPct).toBeLessThan(1);
    // Claimed over the turns that actually ran steered, not extrapolated across turns that never were.
    expect(report?.savedTokens).toBe(Math.round((1200.5 - 800.5) * 40));
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
    await readOutputSavings(spy, { from: "2026-07-01", to: "2026-07-29" });
    expect(seen).toEqual({ from: "2026-07-01", to: "2026-07-29" });
});
