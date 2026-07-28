import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readCleanerSavings } from "./filter-stats.js";

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
        { ts: 1000, command: "git status", rawBytes: 4000, emittedBytes: 1000, matched: ["git"] },
        { ts: 5000, command: "pnpm build", rawBytes: 4000, emittedBytes: 3000, matched: ["pnpm"] },
    ]);
    const savings = await readCleanerSavings(root, "native");
    expect(savings.source).toBe("native");
    expect(savings.commands).toBe(2);
    expect(savings.savedPct).toBe(50);
    expect(savings.perCleaner).toEqual([
        { id: "git", commands: 1 },
        { id: "pnpm", commands: 1 },
    ]);
    // The newest row's OWN timestamp — not the file's mtime, which a prune rewrite would bump without a
    // command having run.
    expect(savings.updatedAt).toBe(5000);
});

test("native reports a zeroed, undated report when no command has been recorded", async () => {
    const savings = await readCleanerSavings(await tempDir(), "native");
    expect(savings).toEqual({
        source: "native",
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
    const savings = await readCleanerSavings(await tempDir(), "rtk");
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
});

test("rtk ignores the native ledger entirely", async () => {
    // The regression: a fat filter-stats.jsonl from an earlier native run (or a test that leaked into it) must
    // not be reported while rtk is the backend — nothing has appended to it since the switch.
    await stubRtk(RTK_GAIN);
    const root = await ledgerRoot(
        Array.from({ length: 181 }, () => ({ ts: 1000, command: "ls -la /", rawBytes: 1282, emittedBytes: 110, matched: ["ls"] })),
    );
    const savings = await readCleanerSavings(root, "rtk");
    expect(savings.commands).toBe(161);
    expect(savings.perCleaner).toEqual([]);
});

test("rtk dates the report by its own ledger's mtime", async () => {
    await stubRtk(RTK_GAIN);
    const dataHome = await tempDir();
    await mkdir(join(dataHome, "rtk"), { recursive: true });
    await writeFile(join(dataHome, "rtk", "history.db"), "");
    process.env["XDG_DATA_HOME"] = dataHome;
    const savings = await readCleanerSavings(await tempDir(), "rtk");
    expect(savings.updatedAt).toBeGreaterThan(0);
});

test("rtk reports nothing rather than the other backend's numbers when rtk is unavailable", async () => {
    await stubRtk(undefined);
    const root = await ledgerRoot([{ ts: 1000, command: "git status", rawBytes: 4000, emittedBytes: 1000, matched: ["git"] }]);
    const savings = await readCleanerSavings(root, "rtk");
    expect(savings.source).toBe("rtk");
    expect(savings.commands).toBe(0);
    expect(savings.updatedAt).toBeUndefined();
});
