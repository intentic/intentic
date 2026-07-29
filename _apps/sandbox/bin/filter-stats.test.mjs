import { expect, test } from "vitest";
import { parseStatsFile, summarizeStats } from "./filter-stats.mjs";

test("summarizeStats: saved-% and tokens come from the cleaned population only", () => {
    const rows = [
        { command: "pnpm i", rawBytes: 4000, emittedBytes: 400, matched: ["pnpm"], heldOut: false, stageBytes: { pnpm: 3600 } },
        { command: "vitest", rawBytes: 8000, emittedBytes: 800, matched: ["test"], heldOut: false, stageBytes: { test: 6000, cap: 1200 } },
    ];
    const report = summarizeStats(rows);
    expect(report.commands).toBe(2);
    expect(report.rawTokens).toBe(3000); // (4000+8000)/4
    expect(report.emittedTokens).toBe(300); // (400+800)/4
    expect(report.savedPct).toBe(90);
    // Ranked by what each mechanism SAVED, not by how often it fired — a handler can match constantly and be
    // worth nothing, which is exactly what this list is read to find out.
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
    // avg emitted cleaned (1000) vs avg raw held (10000) ⇒ 90% measured.
    expect(report.holdout.measuredSavedPct).toBe(90);
    // the held-out row has no cleaner match but must NOT be reported as a gap.
    expect(report.gaps).toEqual([]);
});

test("summarizeStats: high-volume cleaned commands with no cleaner surface as gaps", () => {
    const rows = [{ command: "weird-tool run", rawBytes: 9000, emittedBytes: 9000, matched: [], heldOut: false }];
    expect(summarizeStats(rows).gaps).toEqual([{ command: "weird-tool run", tokens: 2250 }]);
});

test("parseStatsFile: skips blank and corrupt lines", () => {
    expect(parseStatsFile('{"rawBytes":1}\n\nnot json\n{"rawBytes":2}\n')).toEqual([{ rawBytes: 1 }, { rawBytes: 2 }]);
});
