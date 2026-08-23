import type { UsageTurn } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { readTierReport } from "./tier-report.js";
import type { UsageStore } from "./usage-store.js";

/* THE TIER READOUT OVER LEDGER ROWS. What these pin is the arithmetic the settings row stands behind: which
 * rows count as judged, which as fast, where the money lands, and that the escalation read really is "the very
 * next row of the same conversation asked for a dearer rung than this one ran" — the one number that guards the
 * whole feature (docs/model-routing-design.md §4). */

let stamp = 0;
const row = (over: Partial<UsageTurn>): UsageTurn => {
    stamp += 1;
    return {
        at: stamp,
        day: "2026-08-23",
        provider: "claude",
        harness: "native",
        turns: 1,
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 100,
        ...over,
    };
};

const storeOf = (rows: UsageTurn[]): UsageStore => unstubbed<UsageStore>("usage", { turns: async () => rows });

test("nothing judged in the window reads as absence, not as a report full of zeros", async () => {
    // "Not measured" and "measured, found nothing" are different sentences, and the screen renders the first
    // by rendering nothing.
    const report = await readTierReport(storeOf([row({}), row({ costUsd: 3 })]), {});

    expect(report).toBeUndefined();
});

test("the fast share and the money at stake come off the stored score against the exported ceiling", async () => {
    const report = await readTierReport(
        storeOf([
            // Judged fast, unrouted (shadow): its cost is the money on the table.
            row({ tierScore: 0.15, tierRules: ["easy-words"], tierRouted: false, costUsd: 0.4 }),
            row({ tierScore: 0.25, tierRules: [], tierRouted: false, costUsd: 0.1 }),
            // Judged standard: counted, never at stake.
            row({ tierScore: 1, tierRules: ["hard-words"], tierRouted: false, costUsd: 2 }),
            // Unjudged row in the same window (feature was off for it): not in the denominator.
            row({ costUsd: 5 }),
        ]),
        {},
    );

    expect(report).toMatchObject({ judged: 3, fast: 2, atStakeUsd: 0.5, routed: 0, routedUsd: 0, denied: 0 });
});

test("routed turns carry their own realized cost and leave the at-stake sum", async () => {
    const report = await readTierReport(
        storeOf([row({ tierScore: 0.2, tierRouted: true, costUsd: 0.05 }), row({ tierScore: 0.2, tierRouted: false, costUsd: 0.3 })]),
        {},
    );

    expect(report).toMatchObject({ fast: 2, atStakeUsd: 0.3, routed: 1, routedUsd: 0.05 });
});

test("an escalation is the same conversation's very next row asking for a dearer rung than the fast turn ran", async () => {
    const report = await readTierReport(
        storeOf([
            // Routed onto the cheap rung… and the user reached for the picker on the next message.
            row({ conversationId: "c1", tierScore: 0.2, tierRouted: true, model: "claude-haiku-4-5", modelRequested: "claude-opus-5" }),
            row({ conversationId: "c1", tierScore: 1, modelRequested: "claude-opus-5", model: "claude-opus-5" }),
            // A fast turn followed by the same model again is the weak positive, not a bump.
            row({ conversationId: "c2", tierScore: 0.2, tierRouted: true, model: "claude-haiku-4-5", modelRequested: "claude-haiku-4-5" }),
            row({ conversationId: "c2", tierScore: 0.2, model: "claude-haiku-4-5", modelRequested: "claude-haiku-4-5" }),
        ]),
        {},
    );

    expect(report?.escalated).toBe(1);
});

test("a bump after a STANDARD verdict is not held against the judge", async () => {
    const report = await readTierReport(
        storeOf([
            row({ conversationId: "c1", tierScore: 1, model: "claude-haiku-4-5" }),
            row({ conversationId: "c1", tierScore: 1, modelRequested: "claude-opus-5" }),
        ]),
        {},
    );

    expect(report?.escalated).toBe(0);
});

test("the recorded verdict wins over the old derivation, because the cutoff is now the owner's to move", async () => {
    // A row judged at the eager stop can sit well above the balanced cutoff and still have been called simple.
    // Reading the score against one fixed number would report it as a turn the judge left alone.
    const report = await readTierReport(
        storeOf([
            row({ tierScore: 0.35, tierCeiling: 0.4, tierFast: true, costUsd: 0.2 }),
            row({ tierScore: 0.2, tierCeiling: 0, tierFast: false, costUsd: 0.1 }),
        ]),
        {},
    );

    expect(report).toMatchObject({ judged: 2, fast: 1, atStakeUsd: 0.2 });
});

test("a row from before the dial existed is read the way it was actually judged", async () => {
    // No verdict and no ceiling means the balanced cutoff, which is what those rows were judged against, so the
    // two eras stay one population instead of the older one quietly dropping out of the share.
    const report = await readTierReport(storeOf([row({ tierScore: 0.2 }), row({ tierScore: 0.3 })]), {});

    expect(report).toMatchObject({ judged: 2, fast: 1 });
});

test("denied counts the veto rows, and failed or cancelled turns leave every population", async () => {
    // The same rule the experiments apply (turn-experiments.ts `measurable`): a turn that died measures
    // nothing, and a burst of refusals must not read as a flood of simple turns.
    const report = await readTierReport(
        storeOf([
            row({ tierScore: 0.2, tierDenied: true, costUsd: 0.2 }),
            row({ tierScore: 0.2, outcome: "error", costUsd: 0 }),
            row({ tierScore: 0.2, outcome: "cancelled", costUsd: 0.1 }),
        ]),
        {},
    );

    expect(report).toMatchObject({ judged: 1, fast: 1, denied: 1, atStakeUsd: 0.2 });
});
