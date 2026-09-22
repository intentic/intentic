import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterEach } from "bun:test";
import { commandSignature, readInputSavings } from "./filter-stats.js";

// Savings report read off the ledger agent-output-filter appends to. Pins: stages summing to the whole saving, the
// window against the ledger's own calendar, and un-cleaned commands grouped by the verb a handler would match on.

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
    // perCleaner ranks by tokens saved, not by how often a mechanism fired.
    expect(savings.perCleaner).toEqual([
        { id: "git", commands: 1, savedTokens: 500 },
        { id: "cap", commands: 1, savedTokens: 250 },
        { id: "pnpm", commands: 1, savedTokens: 250 },
    ]);
    // updatedAt is the newest row's own timestamp, not the file's mtime (a prune rewrite would bump that).
    expect(savings.updatedAt).toBe(5000);
});

test("attributes the stages to the whole saving, so the segments sum to raw − emitted", async () => {
    // Every raw-to-emitted byte is attributed; footer's negative value adds bytes back, not removes them.
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

// Gaps name which un-cleaned command is worth a new handler; grouped by the verb a handler would match on and ranked by
// what those runs still cost the model, not by any single run and not by bytes already removed.
test("groups un-cleaned commands by verb, ranking them by what still reaches the model", async () => {
    const root = await ledgerRoot([
        // Four different questions, one handler: grouped by the verb, they outrank a single bigger run.
        ...Array.from({ length: 4 }, (_, index) => ({
            ts: 1000,
            command: `cd /work && rg -n needle${index} src | head -30`,
            rawBytes: 20_000,
            emittedBytes: 20_000,
            matched: [],
        })),
        { ts: 1000, command: "curl -s https://example.com", rawBytes: 60_000, emittedBytes: 60_000, matched: [] },
        // Below the per-run floor: emits too little to be worth a cleaner, however often it runs.
        ...Array.from({ length: 50 }, () => ({ ts: 1000, command: "git rev-parse HEAD", rawBytes: 41, emittedBytes: 41, matched: [] })),
        // Matched a cleaner already, so it does not count as a gap.
        { ts: 1000, command: "pnpm install", rawBytes: 90_000, emittedBytes: 1000, matched: ["pnpm"] },
        // The cap already removed all but 200 bytes of this one: raw says 90 KB, the model paid nothing.
        { ts: 1000, command: "strings /usr/local/bin/tool | sort -u", rawBytes: 90_000, emittedBytes: 200, matched: [] },
        // A deliberate read is not a gap: the model asked for exactly these bytes by name.
        { ts: 1000, command: "cd /work && cat src/styles.css", rawBytes: 30_000, emittedBytes: 30_000, matched: [] },
        { ts: 1000, command: "head -60 docs/fly-io.md", rawBytes: 30_000, emittedBytes: 30_000, matched: [] },
    ]);
    const savings = await readInputSavings(root, {});
    expect(savings.gaps).toEqual([
        { command: "rg", commands: 4, tokens: 20_000 },
        { command: "curl", commands: 1, tokens: 15_000 },
    ]);
});

// heldOut commands skip cleaning on purpose; that is not evidence a handler is missing.
test("leaves held-out commands out of the gaps", async () => {
    const root = await ledgerRoot([{ ts: 1000, command: "rg needle src", rawBytes: 20_000, emittedBytes: 20_000, matched: [], heldOut: true }]);
    expect((await readInputSavings(root, {})).gaps).toEqual([]);
});

// The signature is the command a handler is written against, so it has to survive the shapes agents actually type.
test("reads the signature through wrappers, pipelines and subcommands", () => {
    expect(commandSignature("cd /work/intentic && rg -n displayName _editor | head -30")).toBe("rg");
    expect(commandSignature("cd /work/intentic && git diff contract.lock.json | head -40")).toBe("git diff");
    expect(commandSignature("B=/history/engines/codex/bin/codex; strings -n 6 $B | sort -u")).toBe("strings");
    expect(commandSignature("sudo timeout 600 pnpm --filter @intentic/sandbox build")).toBe("pnpm");
    // `run` is `npx vitest`'s argument, not a second subcommand; the verb is what a cleaner matches.
    expect(commandSignature("npx vitest run src/agent")).toBe("npx vitest");
    // Not a subcommand verb: the second word is this run's question, and folding it in would make every run its own gap.
    expect(commandSignature("rg autoPicked --glob '!*.test.ts'")).toBe("rg");
    expect(commandSignature("/usr/local/bin/node -e 'console.log(1)'")).toBe("node");
});
