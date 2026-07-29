import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readInputSavings } from "./filter-stats.js";

// The savings report must read the ledger of the backend that is actually compressing output. Reading one
// ledger regardless of backend is the bug these tests pin: under rtk the native filter is switched off
// (INTENTIC_RUN_FILTER=0), nothing appends to filter-stats.jsonl, and its last contents — a test run's, in the
// case that surfaced this — kept being reported as live agent traffic.

const tempDirs: string[] = [];
const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-savings-"));
    tempDirs.push(dir);
    return dir;
};

const originalPath = process.env["PATH"];
const originalDataHome = process.env["XDG_DATA_HOME"];
afterEach(async () => {
    process.env["PATH"] = originalPath;
    if (originalDataHome === undefined) {
        delete process.env["XDG_DATA_HOME"];
    } else {
        process.env["XDG_DATA_HOME"] = originalDataHome;
    }
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A historyRoot whose logs/filter-stats.jsonl holds the given rows.
const ledgerRoot = async (rows: object[]): Promise<string> => {
    const root = await tempDir();
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "logs", "filter-stats.jsonl"), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    return root;
};

// Make PATH hold exactly one stub `rtk` (or nothing), so the rtk branch is exercised without the real binary —
// and so the "rtk unavailable" case is reachable on an image that ships rtk. The stub uses only shell builtins,
// since a PATH holding one directory can't resolve `cat`.
const stubRtk = async (stdout: string | undefined): Promise<void> => {
    const dir = await tempDir();
    if (stdout !== undefined) {
        await writeFile(join(dir, "rtk"), `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`);
        await chmod(join(dir, "rtk"), 0o755);
    }
    process.env["PATH"] = dir;
};

const RTK_GAIN = `{"summary":{"total_commands":161,"total_input":47776,"total_output":13865,"total_saved":33911,"avg_savings_pct":70.97}}`;

test("native reads the filter-stats ledger and dates it by the newest row", async () => {
    const root = await ledgerRoot([
        { ts: 1000, command: "git status", rawBytes: 4000, emittedBytes: 1000, matched: ["git"], stageBytes: { git: 2000, cap: 1000 } },
        { ts: 5000, command: "pnpm build", rawBytes: 4000, emittedBytes: 3000, matched: ["pnpm"], stageBytes: { pnpm: 1000 } },
    ]);
    const savings = await readInputSavings(root, "native", {});
    expect(savings.source).toBe("native");
    expect(savings.commands).toBe(2);
    expect(savings.savedPct).toBe(50);
    // Attribution is in TOKENS and biggest first — which mechanism is worth the most, not which fired most
    // often. `cap` ran on one command and outranks `pnpm`, which ran on one and saved less.
    expect(savings.perCleaner).toEqual([
        { id: "git", commands: 1, savedTokens: 500 },
        { id: "cap", commands: 1, savedTokens: 250 },
        { id: "pnpm", commands: 1, savedTokens: 250 },
    ]);
    // The newest row's OWN timestamp — not the file's mtime, which a prune rewrite would bump without a
    // command having run.
    expect(savings.updatedAt).toBe(5000);
});

test("native attributes the stages to the whole saving, so the segments sum to raw − emitted", async () => {
    // The identity the stacked bar stands on: every byte between raw and emitted belongs to some mechanism,
    // including the ones with no switch (ansi) and the footer that ADDS bytes back.
    const root = await ledgerRoot([
        { ts: 1000, command: "ls -la", rawBytes: 8000, emittedBytes: 2120, stageBytes: { ansi: 800, ls: 4000, cap: 1200, footer: -120 } },
    ]);
    const savings = await readInputSavings(root, "native", {});
    const attributed = savings.perCleaner.reduce((sum, stage) => sum + stage.savedTokens, 0);
    expect(attributed).toBe(savings.rawTokens - savings.emittedTokens);
});

test("native windows the ledger by the UTC day each command ran on", async () => {
    const day = (iso: string): number => Date.parse(iso);
    const root = await ledgerRoot([
        { ts: day("2026-07-01T12:00:00Z"), command: "git status", rawBytes: 4000, emittedBytes: 1000, stageBytes: { git: 3000 } },
        { ts: day("2026-07-20T12:00:00Z"), command: "pnpm build", rawBytes: 2000, emittedBytes: 1000, stageBytes: { pnpm: 1000 } },
    ]);
    const savings = await readInputSavings(root, "native", { from: "2026-07-15", to: "2026-07-31" });
    expect(savings.commands).toBe(1);
    expect(savings.perCleaner).toEqual([{ id: "pnpm", commands: 1, savedTokens: 250 }]);
    // Said on the wire, because the screen has to state which calendar its numbers are on.
    expect(savings.windowed).toBe(true);
});

test("native reports a zeroed, undated report when no command has been recorded", async () => {
    const savings = await readInputSavings(await tempDir(), "native", {});
    expect(savings).toEqual({
        source: "native",
        windowed: true,
        commands: 0,
        rawTokens: 0,
        emittedTokens: 0,
        savedPct: 0,
        perCleaner: [],
        holdout: { cleaned: 0, heldOut: 0 },
        gaps: [],
    });
});

test("rtk reports rtk's own ledger", async () => {
    await stubRtk(RTK_GAIN);
    const savings = await readInputSavings(await tempDir(), "rtk", {});
    expect(savings.source).toBe("rtk");
    expect(savings.commands).toBe(161);
    expect(savings.rawTokens).toBe(47_776);
    expect(savings.emittedTokens).toBe(13_865);
    // Derived from the two totals the card prints beside it, so the line's arithmetic is self-consistent.
    expect(savings.savedPct).toBe(71);
    // rtk attributes no cleaner ids and keeps no held-out control; the card omits those sections rather than
    // borrowing the other backend's.
    expect(savings.perCleaner).toEqual([]);
    expect(savings.gaps).toEqual([]);
    expect(savings.holdout).toEqual({ cleaned: 0, heldOut: 0 });
    // `gain` stamps nothing with a time, so these totals cannot be windowed — and the screen must say so
    // rather than let a 7-day filter sit above an all-time figure.
    expect(savings.windowed).toBe(false);
});

test("rtk ignores the native ledger entirely", async () => {
    // The regression: a fat filter-stats.jsonl from an earlier native run (or a test that leaked into it) must
    // not be reported while rtk is the backend — nothing has appended to it since the switch.
    await stubRtk(RTK_GAIN);
    const root = await ledgerRoot(
        Array.from({ length: 181 }, () => ({ ts: 1000, command: "ls -la /", rawBytes: 1282, emittedBytes: 110, matched: ["ls"] })),
    );
    const savings = await readInputSavings(root, "rtk", {});
    expect(savings.commands).toBe(161);
    expect(savings.perCleaner).toEqual([]);
});

test("rtk dates the report by its own ledger's mtime", async () => {
    await stubRtk(RTK_GAIN);
    const dataHome = await tempDir();
    await mkdir(join(dataHome, "rtk"), { recursive: true });
    await writeFile(join(dataHome, "rtk", "history.db"), "");
    process.env["XDG_DATA_HOME"] = dataHome;
    const savings = await readInputSavings(await tempDir(), "rtk", {});
    expect(savings.updatedAt).toBeGreaterThan(0);
});

test("rtk reports nothing rather than the other backend's numbers when rtk is unavailable", async () => {
    await stubRtk(undefined);
    const root = await ledgerRoot([{ ts: 1000, command: "git status", rawBytes: 4000, emittedBytes: 1000, matched: ["git"] }]);
    const savings = await readInputSavings(root, "rtk", {});
    expect(savings.source).toBe("rtk");
    expect(savings.commands).toBe(0);
    expect(savings.updatedAt).toBeUndefined();
});
