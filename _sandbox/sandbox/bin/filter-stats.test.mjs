import { expect, test } from "vitest";
import { parseStatsFile, summarizeStats } from "./filter-stats.mjs";

test("summarizeStats: saved-% and tokens come from the cleaned population only", () => {
    const rows = [
        { command: "pnpm i", rawBytes: 4000, emittedBytes: 400, matched: ["pnpm"], heldOut: false, stageBytes: { pnpm: 3600 } },
        { command: "vitest", rawBytes: 8000, emittedBytes: 800, matched: ["test"], heldOut: false, stageBytes: { test: 6000, cap: 1200 } },
    ];
    const report = summarizeStats(rows);
    expect(report.commands).toBe(2);
    expect(report.rawTokens).toBe(3000);
    expect(report.emittedTokens).toBe(300);
    expect(report.savedPct).toBe(90);
    // Ranked by tokens saved, not by how often a mechanism fired.
    expect(report.perCleaner).toEqual([
        { id: "test", commands: 1, savedTokens: 1500 },
        { id: "pnpm", commands: 1, savedTokens: 900 },
        { id: "cap", commands: 1, savedTokens: 300 },
    ]);
});

test("summarizeStats: held-out rows form the measured control and never count as gaps", () => {
    const rows = [
        { command: "big-build", rawBytes: 10_000, emittedBytes: 1000, matched: ["build"], heldOut: false },
        { command: "big-build", rawBytes: 10_000, emittedBytes: 10_000, matched: [], heldOut: true },
    ];
    const report = summarizeStats(rows);
    expect(report.holdout.cleaned).toBe(1);
    expect(report.holdout.heldOut).toBe(1);
    // One command per arm cannot measure anything, however large the gap looks.
    expect(report.holdout.measuredSavedPct).toBeUndefined();
    // The held-out row has no cleaner match but must not be reported as a gap.
    expect(report.gaps).toEqual([]);
});

// The holdout is the only estimate here; it publishes nothing it cannot support, using medians since output sizes are
// heavy-tailed.
test("summarizeStats: a separated holdout publishes the median saving", () => {
    const rows = [
        ...Array.from({ length: 200 }, (_, i) => ({ command: "c", rawBytes: 2000 + i, emittedBytes: 1000 + i, matched: ["x"], heldOut: false })),
        ...Array.from({ length: 60 }, (_, i) => ({ command: "c", rawBytes: 2000 + i, emittedBytes: 2000 + i, matched: [], heldOut: true })),
    ];
    // Median emitted (cleaned) 1100 vs median raw (held) 2030 gives ~46%.
    expect(summarizeStats(rows).holdout.measuredSavedPct).toBe(46);
});

test("summarizeStats: a holdout the cleaners did not separate publishes no number at all", () => {
    // Same distribution either means an ineffective config or a real one on too short a window; either way the report
    // stays silent rather than guess.
    const rows = [
        ...Array.from({ length: 200 }, (_, i) => ({
            command: "c",
            rawBytes: 2000 + (i % 60),
            emittedBytes: 2000 + (i % 60),
            matched: ["x"],
            heldOut: false,
        })),
        ...Array.from({ length: 60 }, (_, i) => ({
            command: "c",
            rawBytes: 2000 + (i % 60),
            emittedBytes: 2000 + (i % 60),
            matched: [],
            heldOut: true,
        })),
    ];
    expect(summarizeStats(rows).holdout.measuredSavedPct).toBeUndefined();
});

test("summarizeStats: high-volume cleaned commands with no cleaner surface as gaps, grouped by command", () => {
    const rows = [
        { command: "weird-tool run", rawBytes: 9000, emittedBytes: 9000, matched: [], heldOut: false },
        { command: "weird-tool run", rawBytes: 3000, emittedBytes: 3000, matched: [], heldOut: false },
    ];
    // `commands` and `tokens` sum over all runs of the command, not just its largest single run.
    expect(summarizeStats(rows).gaps).toEqual([{ command: "weird-tool run", commands: 2, tokens: 3000 }]);
});

test("parseStatsFile: skips blank and corrupt lines", () => {
    expect(parseStatsFile('{"rawBytes":1}\n\nnot json\n{"rawBytes":2}\n')).toEqual([{ rawBytes: 1 }, { rawBytes: 2 }]);
});
