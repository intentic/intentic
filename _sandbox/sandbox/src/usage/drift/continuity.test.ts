import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import pino from "pino";
import type { HeadroomTarget } from "../headroom.js";
import { continueReading, missingPools, sweptReadings } from "./continuity.js";

// A provider that changes its answer must look different from one whose account changed: a pool that stops being
// reported is kept and marked, and a model no pool covers is named.

const NOW = 1_800_000_000_000;
const window = (over: Partial<UsageWindow> & Pick<UsageWindow, "kind">): UsageWindow => ({
    utilization: 40,
    resetsAt: NOW / 1000 + 3_600,
    gates: "all",
    ...over,
});
const GEMINI = window({ kind: "google:gemini-weekly", label: "Gemini models", utilization: 47, gates: { models: ["gemini"] } });
const THIRD_PARTY = window({ kind: "google:3p-weekly", utilization: 100, gates: { models: ["claude", "gpt"] } });

test("a whole reading keeps a pool the last one named, marked with when it went missing", () => {
    const previous: AccountUsage = { windows: [GEMINI, THIRD_PARTY], measuredAt: NOW - 60_000 };
    const next: AccountUsage = { windows: [THIRD_PARTY], measuredAt: NOW };
    expect(continueReading(previous, next, true, NOW).windows).toEqual([THIRD_PARTY, { ...GEMINI, missingSince: NOW / 1000 }]);
    // Once marked, the mark keeps the instant it went missing.
    const later = continueReading({ windows: [THIRD_PARTY, { ...GEMINI, missingSince: 5 }], measuredAt: NOW }, { ...next, measuredAt: NOW + 1 }, true, NOW);
    expect(later.windows[1]?.missingSince).toBe(5);
    // A partial reading (a turn's stream) replaces as it always did.
    expect(continueReading(previous, next, false, NOW).windows).toEqual([THIRD_PARTY]);
});

test("a missing pool whose window has closed is not carried, and neither is a lapsed one", () => {
    const closed = { ...GEMINI, resetsAt: NOW / 1000 - 1 };
    expect(missingPools({ windows: [closed, THIRD_PARTY], measuredAt: NOW - 60_000 }, { windows: [THIRD_PARTY], measuredAt: NOW }, NOW)).toEqual([]);
    const lapsed = { ...GEMINI, lapsedAt: NOW / 1000 - 10 };
    expect(missingPools({ windows: [lapsed], measuredAt: NOW }, { windows: [THIRD_PARTY], measuredAt: NOW }, NOW)).toEqual([]);
});

test("models no pool covers are kept by a partial reading only while none of its pools covers them", () => {
    const previous: AccountUsage = { windows: [THIRD_PARTY], measuredAt: NOW, uncovered: ["gemini-3.8-flash-high"] };
    expect(continueReading(previous, { windows: [THIRD_PARTY], measuredAt: NOW + 1 }, false, NOW).uncovered).toEqual(["gemini-3.8-flash-high"]);
    expect(continueReading(previous, { windows: [THIRD_PARTY, GEMINI], measuredAt: NOW + 1 }, false, NOW)).not.toHaveProperty("uncovered");
    // A whole reading says its own: one that found everything covered drops the old list.
    expect(continueReading(previous, { windows: [THIRD_PARTY], measuredAt: NOW + 1 }, true, NOW)).not.toHaveProperty("uncovered");
});

const target = (over: Partial<HeadroomTarget> = {}): HeadroomTarget => ({
    key: "gemini:a.json",
    provider: "gemini",
    whole: true,
    read: async () => ({ windows: [] }),
    ...over,
});

const capture = () => {
    const written: string[] = [];
    return { logger: pino({ level: "info" }, { write: (line: string) => written.push(line) }), written };
};

test("a swept reading names the models no pool covers, and says each gap once", async () => {
    const { logger, written } = capture();
    const stored = new Map<string, AccountUsage>([["gemini:a.json", { windows: [GEMINI, THIRD_PARTY], measuredAt: NOW - 60_000 }]]);
    const swept = sweptReadings({ store: { read: async () => Object.fromEntries(stored) }, logger });
    const served = target({ served: async () => [{ id: "claude-opus-4-6-thinking" }, { id: "gemini-3.8-flash-high" }] });

    const first = await swept(served, [THIRD_PARTY]);
    expect(first.uncovered).toEqual(["gemini-3.8-flash-high"]);
    expect(written).toEqual([expect.stringContaining("serves models no pool in its reading covers"), expect.stringContaining("stopped reporting a pool")]);

    // The same gaps on the next sweep are not said again: the pool is marked missing by now.
    stored.set("gemini:a.json", { windows: [THIRD_PARTY, { ...GEMINI, missingSince: NOW / 1000 }], measuredAt: NOW });
    await swept(served, [THIRD_PARTY]);
    expect(written).toHaveLength(2);

    // A model list that cannot be read costs the check, never the reading.
    const unlisted = await swept(target({ key: "gemini:b.json", served: async () => { throw new Error("proxy down"); } }), [THIRD_PARTY]);
    expect(unlisted).not.toHaveProperty("uncovered");
});
