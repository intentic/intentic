import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterRun } from "./agent-output-filter.mjs";
import { CACHE_MARKER } from "./cleaners.mjs";
import { parseStatsFile } from "./filter-stats.mjs";

// filterRun is the pass both runtimes share (the sandbox's pane pipeline and the Claude Code plugin's hook), so these
// pin what it keeps under logsDir and that a keeping failure never costs the trim itself.

const dirs: string[] = [];
const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "output-cleaners-"));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Past the generic cap (30 head, an elision marker and 50 tail of anything over 100 lines), so the footer names the
// retained raw text.
const LONG = `${Array.from({ length: 300 }, (_, index) => `progress line ${index}`).join("\n")}\n`;

test("keeps the raw text a footer names and ledgers one row per command", () => {
    const logsDir = tempDir();
    const { out, heldOut } = filterRun(LONG, { command: "./build.sh", logsDir, runName: "s1-call1.log", sessionKey: "s1", now: () => 1234 });
    expect(heldOut).toBe(false);
    const retained = join(logsDir, "raw-output", "s1-call1.log");
    expect(out).toContain(`300 lines filtered to 81 · full: retrieve-output ${retained} [pattern]`);
    expect(readFileSync(retained, "utf8")).toBe(LONG.trimEnd());
    const rows = parseStatsFile(readFileSync(join(logsDir, "filter-stats.jsonl"), "utf8"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ts: 1234, command: "./build.sh", exit: "0", rawBytes: LONG.length, emittedBytes: out.length, heldOut: false });
});

test("tags ride on the ledger row, and never displace the pass's own fields", () => {
    const logsDir = tempDir();
    filterRun("ok\n", { command: "true", logsDir, tags: { project: "/src/app", session: "s9", heldOut: "forged" }, now: () => 7 });
    const rows = parseStatsFile(readFileSync(join(logsDir, "filter-stats.jsonl"), "utf8"));
    expect(rows[0]).toMatchObject({ project: "/src/app", session: "s9", heldOut: false, ts: 7 });
});

test("a held-out command reaches the model untrimmed, keeps no raw copy, and is ledgered as the control", () => {
    const logsDir = tempDir();
    const { out, heldOut, stages } = filterRun(LONG, { command: "./build.sh", logsDir, runName: "s1-call2.log", holdout: 0.5, random: () => 0.1 });
    expect(heldOut).toBe(true);
    expect(out).toBe(LONG);
    expect(stages).toEqual([]);
    expect(existsSync(join(logsDir, "raw-output"))).toBe(false);
    const rows = parseStatsFile(readFileSync(join(logsDir, "filter-stats.jsonl"), "utf8"));
    expect(rows[0]).toMatchObject({ heldOut: true, rawBytes: LONG.length, emittedBytes: LONG.length, stageBytes: {} });
});

test("a ledger that cannot be written costs the ledger, never the trim", () => {
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "a file where the logs directory should be");
    const { out } = filterRun(LONG, { command: "./build.sh", logsDir: join(blocker, "logs"), runName: "s1-call3.log" });
    expect(out).toContain("300 lines filtered to 81");
    expect(out).not.toContain("retrieve-output");
});

test("the same output twice in one session collapses to a pointer at the first", () => {
    const logsDir = tempDir();
    const body = `${Array.from({ length: 60 }, (_, index) => `row ${index} of a report that repeats verbatim`).join("\n")}\n`;
    const first = filterRun(body, { command: "cat report.txt", logsDir, runName: "s2-a.log", sessionKey: "s2" });
    const second = filterRun(body, { command: "cat report.txt", logsDir, runName: "s2-b.log", sessionKey: "s2" });
    expect(first.out).toBe(body);
    expect(second.out).toBe(`${CACHE_MARKER}a previous run this session · retrieve-output ${join(logsDir, "raw-output", "s2-b.log")})\n`);
    expect(readdirSync(join(logsDir, "output-cache"))).toEqual(["s2.json"]);
});

test("without a logs directory nothing is kept and the trim still happens", () => {
    const { out } = filterRun(LONG, { command: "./build.sh" });
    expect(out).toContain("--- [exit 0, 0s] 300 lines filtered to 81\n");
});
