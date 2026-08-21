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
    // Ranked by what each mechanism SAVED, not by how often it fired: a handler can match constantly and be
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
    // One command per arm cannot measure anything, however large the gap between them looks.
    expect(report.holdout.measuredSavedPct).toBeUndefined();
    // the held-out row has no cleaner match but must NOT be reported as a gap.
    expect(report.gaps).toEqual([]);
});

/* The holdout is the only estimate in this report, and it publishes nothing it cannot support. The mean-based
 * version it replaced printed −6% on a window where the exact paired count said +3%, because output size is
 * heavy-tailed and a mean over a 10% arm reports which few huge captures happened to land in it. */
test("summarizeStats: a separated holdout publishes the median saving", () => {
    const rows = [
        ...Array.from({ length: 200 }, (_, i) => ({ command: "c", rawBytes: 2000 + i, emittedBytes: 1000 + i, matched: ["x"], heldOut: false })),
        ...Array.from({ length: 60 }, (_, i) => ({ command: "c", rawBytes: 2000 + i, emittedBytes: 2000 + i, matched: [], heldOut: true })),
    ];
    // median emitted cleaned 1100 against median raw held 2030 ⇒ ~46%.
    expect(summarizeStats(rows).holdout.measuredSavedPct).toBe(46);
});

test("summarizeStats: a holdout the cleaners did not separate publishes no number at all", () => {
    // The two arms are the same distribution, which is what an ineffective config looks like, and also what a
    // real one looks like on a window too short to tell. Either way the honest report is silence.
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
    // One row per command, `commands` runs summing to `tokens`: the list is read for which handler to write
    // next, and that is a question about a command over its runs, not about a single expensive run.
    expect(summarizeStats(rows).gaps).toEqual([{ command: "weird-tool run", commands: 2, tokens: 3000 }]);
});

test("parseStatsFile: skips blank and corrupt lines", () => {
    expect(parseStatsFile('{"rawBytes":1}\n\nnot json\n{"rawBytes":2}\n')).toEqual([{ rawBytes: 1 }, { rawBytes: 2 }]);
});
