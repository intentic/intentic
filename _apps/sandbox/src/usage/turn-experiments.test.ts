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
    proseChars: 1000,
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
    expect(output?.metric).toBe("proseChars");
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
        ...Array.from({ length: 40 }, () => turn({ terse: true, iqContext: true, proseChars: 800, costUsd: 0.04 })),
        ...Array.from({ length: 30 }, () => turn({ terse: false, iqContext: false, proseChars: 1200, costUsd: 0.06 })),
    ];
    const { output, context } = await readTurnExperiments(storeOf(both), {});
    expect(output?.on.turns).toBe(40);
    expect(context?.on.turns).toBe(40);
    expect(output?.metric).toBe("proseChars");
    expect(context?.metric).toBe("costUsd");
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
    expect(output?.on.turns).toBe(40);
    expect(output?.marginPct).toBeGreaterThan(0);
    expect(output?.deltaPct).toBeUndefined();
    expect(output?.saved).toBeUndefined();
});

/* Pre-injection's arm is the coin flip and stays that way — re-labelling by what retrieval found would sort
 * turns by how searchable their question was, which is a property of the question, not of the treatment. The
 * cost of that correctness is a treatment arm the treatment did not reach, measured at four turns in five, and
 * the delta is diluted by exactly that. So delivery rides alongside instead. */
test("pre-injection reports how much of its treated arm the note actually reached", async () => {
    const arms = [
        ...Array.from({ length: 40 }, (_, index) => turn({ iqContext: true, iqContextOutcome: index < 10 ? "note" : "ineligible", costUsd: 0.05 })),
        ...Array.from({ length: 30 }, () => turn({ iqContext: false, iqContextOutcome: "ineligible", costUsd: 0.06 })),
    ];
    const { context } = await readTurnExperiments(storeOf(arms), {});
    // Of the treated arm, not of every turn: the control's non-delivery is what being the control means.
    expect(context?.deliveredPct).toBe(25);
});

/* A DELIVERY RATE WITHOUT ITS REASONS IS UNACTIONABLE. Nine days of real use put the note on 19% of the arm it
 * was assigned to, and the boolean that recorded it could not say whether the other 81% was the eligibility
 * gate declining on prompts that named their own file — working as designed — or a two-second deadline eating
 * the feature. Those are the same number and opposite bugs. */
test("the treated arm's non-delivery is broken down by reason, largest first", async () => {
    const arms = [
        ...Array.from({ length: 10 }, () => turn({ iqContext: true, iqContextOutcome: "note", costUsd: 0.05 })),
        ...Array.from({ length: 25 }, () => turn({ iqContext: true, iqContextOutcome: "ineligible", costUsd: 0.05 })),
        ...Array.from({ length: 5 }, () => turn({ iqContext: true, iqContextOutcome: "deadline", costUsd: 0.05 })),
        ...Array.from({ length: 30 }, () => turn({ iqContext: false, iqContextOutcome: "ineligible", costUsd: 0.06 })),
    ];
    const { context } = await readTurnExperiments(storeOf(arms), {});
    expect(context?.outcomes).toEqual([
        { outcome: "ineligible", turns: 25 },
        { outcome: "note", turns: 10 },
        { outcome: "deadline", turns: 5 },
    ]);
});

/* "Keep collecting" is only advice if the reader can tell three more days from three more years.
 *
 * AIMED AT A FIXED RESOLUTION, which is the whole correctness of the thing. Sized against the delta currently
 * observed, the real ledger's nine-day-old unresolved experiment asked for fourteen more turns — an estimate
 * divided by noise inherits it and promises an answer next week forever. Against a fixed target the same data
 * asks for hundreds, which is the fact worth printing. */
test("a withheld delta says how many more control turns would settle it", async () => {
    const noisy = [
        ...Array.from({ length: 40 }, (_, index) => turn({ iqContext: true, costUsd: index % 2 === 0 ? 0.02 : 0.18 })),
        ...Array.from({ length: 40 }, (_, index) => turn({ iqContext: false, costUsd: index % 2 === 0 ? 0.01 : 0.18 })),
    ];
    const { context } = await readTurnExperiments(storeOf(noisy), {});
    expect(context?.deltaPct).toBeUndefined();
    // A margin many times the target asks for many times the arm — the reading that says this holdout will not
    // get there, rather than that it is nearly done.
    expect(context?.controlTurnsNeeded).toBeGreaterThan(40);
});

/* THE FALSE-IMMINENCE REGRESSION, pinned. A delta sitting just under its own margin is the case where an
 * estimate sized against the effect collapses to nothing: the real ledger's +26.3% ± 29.3pp asked for FOURTEEN
 * more control turns after nine days of never resolving, because (margin ÷ delta)² is barely above one exactly
 * when the two are close. A wide margin means a wide margin, whatever the effect beside it happens to read, and
 * the arm has to grow by a multiple rather than a handful. */
test("a delta sitting just under its margin still asks for a multiple of the arm, not a handful", async () => {
    const noisy = [
        ...Array.from({ length: 40 }, (_, index) => turn({ iqContext: true, costUsd: index % 2 === 0 ? 0.02 : 0.18 })),
        ...Array.from({ length: 40 }, (_, index) => turn({ iqContext: false, costUsd: index % 2 === 0 ? 0.01 : 0.16 })),
    ];
    const { context } = await readTurnExperiments(storeOf(noisy), {});
    expect(context?.deltaPct).toBeUndefined();
    // The delta is within a few points of the margin, which is where the effect-sized form reported single
    // digits. Against a fixed target the arm has to multiply.
    expect(context?.marginPct).toBeGreaterThan(20);
    expect(context?.controlTurnsNeeded).toBeGreaterThan(3 * 40);
});

// Nothing to ask for once the resolution is already tight enough — then the effect is simply smaller than the
// width worth acting on, which is an answer rather than a shortfall.
test("no waiting estimate once the resolution is already good enough", async () => {
    const tight = [
        ...Array.from({ length: 400 }, () => turn({ iqContext: true, costUsd: 0.05 })),
        ...Array.from({ length: 400 }, () => turn({ iqContext: false, costUsd: 0.05 })),
    ];
    const { context } = await readTurnExperiments(storeOf(tight), {});
    expect(context?.deltaPct).toBeUndefined();
    expect(context?.controlTurnsNeeded).toBeUndefined();
});

// Nothing to wait for once the delta is published — the field is the withheld state's own explanation.
test("a resolved delta carries no waiting estimate", async () => {
    const clean = [
        ...Array.from({ length: 40 }, () => turn({ iqContext: true, costUsd: 0.04 })),
        ...Array.from({ length: 40 }, () => turn({ iqContext: false, costUsd: 0.06 })),
    ];
    const { context } = await readTurnExperiments(storeOf(clean), {});
    expect(context?.deltaPct).toBeDefined();
    expect(context?.controlTurnsNeeded).toBeUndefined();
});

test("a metric a turn never recorded leaves it out of the population, rather than counting it as zero", async () => {
    const mixed = [
        ...Array.from({ length: 40 }, () => turn({ terse: true, proseChars: 800 })),
        ...Array.from({ length: 30 }, () => turn({ terse: false, proseChars: 1200 })),
        // Rows from before prose was measured. Averaged in as zeros they would drag both means toward nothing.
        ...Array.from({ length: 20 }, () => turn({ terse: true, proseChars: undefined })),
    ];
    const { output } = await readTurnExperiments(storeOf(mixed), {});
    expect(output?.on.turns).toBe(40);
    expect(output?.on.mean).toBe(800);
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
