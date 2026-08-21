import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readInputSavings } from "./filter-stats.js";

// The savings report, read off the ledger agent-output-filter appends to. What is pinned here is the shape the
// screen renders from: the stages summing to the whole saving, the reader's window applied on the ledger's own
// calendar, and the un-cleaned commands grouped so the list names a handler worth writing.

const tempDirs: string[] = [];
const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-savings-"));
    tempDirs.push(dir);
    return dir;
};

afterEach(async () => {
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

test("reads the filter-stats ledger and dates it by the newest row", async () => {
    const root = await ledgerRoot([
        { ts: 1000, command: "git status", rawBytes: 4000, emittedBytes: 1000, matched: ["git"], stageBytes: { git: 2000, cap: 1000 } },
        { ts: 5000, command: "pnpm build", rawBytes: 4000, emittedBytes: 3000, matched: ["pnpm"], stageBytes: { pnpm: 1000 } },
    ]);
    const savings = await readInputSavings(root, {});
    expect(savings.commands).toBe(2);
    expect(savings.savedPct).toBe(50);
    // Attribution is in TOKENS and biggest first, which mechanism is worth the most, not which fired most
    // often. `cap` ran on one command and outranks `pnpm`, which ran on one and saved less.
    expect(savings.perCleaner).toEqual([
        { id: "git", commands: 1, savedTokens: 500 },
        { id: "cap", commands: 1, savedTokens: 250 },
        { id: "pnpm", commands: 1, savedTokens: 250 },
    ]);
    // The newest row's OWN timestamp, not the file's mtime, which a prune rewrite would bump without a
    // command having run.
    expect(savings.updatedAt).toBe(5000);
});

test("attributes the stages to the whole saving, so the segments sum to raw − emitted", async () => {
    // The identity the stacked bar stands on: every byte between raw and emitted belongs to some mechanism,
    // including the ones with no switch (ansi) and the footer that ADDS bytes back.
    const root = await ledgerRoot([
        { ts: 1000, command: "ls -la", rawBytes: 8000, emittedBytes: 2120, stageBytes: { ansi: 800, ls: 4000, cap: 1200, footer: -120 } },
    ]);
    const savings = await readInputSavings(root, {});
    const attributed = savings.perCleaner.reduce((sum, stage) => sum + stage.savedTokens, 0);
    expect(attributed).toBe(savings.rawTokens - savings.emittedTokens);
});

test("windows the ledger by the UTC day each command ran on", async () => {
    const day = (iso: string): number => Date.parse(iso);
    const root = await ledgerRoot([
        { ts: day("2026-07-01T12:00:00Z"), command: "git status", rawBytes: 4000, emittedBytes: 1000, stageBytes: { git: 3000 } },
        { ts: day("2026-07-20T12:00:00Z"), command: "pnpm build", rawBytes: 2000, emittedBytes: 1000, stageBytes: { pnpm: 1000 } },
    ]);
    const savings = await readInputSavings(root, { from: "2026-07-15", to: "2026-07-31" });
    expect(savings.commands).toBe(1);
    expect(savings.perCleaner).toEqual([{ id: "pnpm", commands: 1, savedTokens: 250 }]);
});

test("reports a zeroed, undated report when no command has been recorded", async () => {
    const savings = await readInputSavings(await tempDir(), {});
    expect(savings).toEqual({
        commands: 0,
        rawTokens: 0,
        emittedTokens: 0,
        savedPct: 0,
        perCleaner: [],
        holdout: { cleaned: 0, heldOut: 0 },
        gaps: [],
    });
});

/* The un-cleaned list, which is read for one purpose: which command is worth a new handler. That makes it a
 * question about a command across its runs, not about a single big run, so the rows are grouped, and the
 * ranking is by total. Ungrouped, one 60k outlier outranked a command costing 5k twenty times over. */
test("groups un-cleaned commands, ranking them by what they cost in total", async () => {
    const root = await ledgerRoot([
        ...Array.from({ length: 4 }, () => ({ ts: 1000, command: "rg needle src", rawBytes: 20_000, emittedBytes: 20_000, matched: [] })),
        { ts: 1000, command: "curl -s https://example.com", rawBytes: 60_000, emittedBytes: 60_000, matched: [] },
        // Below the per-run floor: a command that emits little is not a cleaner's job however often it runs.
        ...Array.from({ length: 50 }, () => ({ ts: 1000, command: "git rev-parse HEAD", rawBytes: 41, emittedBytes: 41, matched: [] })),
        // Matched a cleaner, so it is already handled and is not a gap.
        { ts: 1000, command: "pnpm install", rawBytes: 90_000, emittedBytes: 1000, matched: ["pnpm"] },
    ]);
    const savings = await readInputSavings(root, {});
    expect(savings.gaps).toEqual([
        { command: "rg needle src", commands: 4, tokens: 20_000 },
        { command: "curl -s https://example.com", commands: 1, tokens: 15_000 },
    ]);
});

// Held-out commands bypassed cleaning on purpose, so they are not evidence that a handler is missing.
test("leaves held-out commands out of the gaps", async () => {
    const root = await ledgerRoot([{ ts: 1000, command: "rg needle src", rawBytes: 20_000, emittedBytes: 20_000, matched: [], heldOut: true }]);
    expect((await readInputSavings(root, {})).gaps).toEqual([]);
});
