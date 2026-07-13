import { expect, test } from "vitest";
import { filterOutput } from "./agent-output-filter.mjs";
import { CACHE_MARKER, CLEANERS, cleanLines, collapseCached, parseCleaners, sessionKeyFromLog } from "./cleaners.mjs";

// An in-memory stand-in for the file-backed cache store, so cache tests stay deterministic (no disk).
const memoryStore = () => {
    const map = new Map();
    return { lookup: (key) => map.get(key), record: (key, value) => map.set(key, value) };
};

test("parseCleaners: empty/undefined enables everything", () => {
    expect(parseCleaners("")).toEqual(new Set(CLEANERS));
    expect(parseCleaners(undefined)).toEqual(new Set(CLEANERS));
});

test("parseCleaners: allow-list selects only the named cleaners", () => {
    expect(parseCleaners("git,pnpm")).toEqual(new Set(["git", "pnpm"]));
});

test("parseCleaners: default-minus disables the named cleaners", () => {
    const set = parseCleaners("-git,-cap");
    expect(set.has("git")).toBe(false);
    expect(set.has("cap")).toBe(false);
    expect(set.has("pnpm")).toBe(true);
});

test("parseCleaners: unknown tokens are ignored (fail-open), never thrown", () => {
    expect(parseCleaners("nonsense")).toEqual(new Set(CLEANERS)); // all tokens unknown → all on
    expect(parseCleaners("git,bogus")).toEqual(new Set(["git"])); // known kept, unknown dropped
});

test("cleanLines: strips pnpm progress on success when enabled", () => {
    const lines = ["Progress: resolved 100", "added 5 packages", "done"];
    expect(cleanLines(lines, { command: "pnpm install", exitCode: "0", enabled: new Set(CLEANERS) })).toEqual(["added 5 packages", "done"]);
});

test("cleanLines: a disabled cleaner leaves its noise untouched", () => {
    const lines = ["Progress: resolved 100", "added 5 packages"];
    expect(cleanLines(lines, { command: "pnpm install", exitCode: "0", enabled: parseCleaners("-pnpm") })).toEqual(lines);
});

test("cleanLines: failure keeps everything (no command strip)", () => {
    const lines = ["Progress: resolved 100", "error: boom"];
    expect(cleanLines(lines, { command: "pnpm install", exitCode: "1", enabled: new Set(CLEANERS) })).toEqual(lines);
});

test("cleanLines: cap elides the middle past MAX when enabled", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const out = cleanLines(lines, { command: "echo", exitCode: "0", enabled: new Set(CLEANERS) });
    expect(out.length).toBeLessThan(200);
    expect(out.some((line) => /lines elided/.test(line))).toBe(true);
});

test("cleanLines: cap disabled keeps all lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    expect(cleanLines(lines, { command: "echo", exitCode: "0", enabled: parseCleaners("-cap") })).toHaveLength(200);
});

test("filterOutput: strips ANSI and appends a footer when lines were dropped", () => {
    const raw = `${["Progress: a", "Progress: b", "\x1b[32mdone\x1b[0m"].join("\n")}\n`;
    const out = filterOutput(raw, "pnpm install", "0", "1", "/logs/x.log");
    expect(out).toContain("done");
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("retrieve-output /logs/x.log");
});

test("filterOutput: no footer when nothing was dropped", () => {
    expect(filterOutput("hello\nworld\n", "echo hi", "0", "0", "")).toBe("hello\nworld\n");
});

test("test cleaner: drops per-test pass lines on green, keeps the summary", () => {
    const lines = ["✓ src/a.test.ts (3)", "✓ src/b.test.ts (2)", "Test Files  2 passed (2)", "Tests  5 passed (5)"];
    const out = cleanLines(lines, { command: "vitest run", exitCode: "0", enabled: new Set(CLEANERS) });
    expect(out).toEqual(["Test Files  2 passed (2)", "Tests  5 passed (5)"]);
});

test("test cleaner: a failing run keeps everything (command cleaners skip on non-zero exit)", () => {
    const lines = ["✓ src/a.test.ts (3)", "FAIL src/b.test.ts", "AssertionError: expected 1 to be 2"];
    expect(cleanLines(lines, { command: "vitest run", exitCode: "1", enabled: new Set(CLEANERS) })).toEqual(lines);
});

test("dedup: collapses a run of >=3 identical lines with a count", () => {
    const lines = ["warn: retry", "warn: retry", "warn: retry", "warn: retry", "done"];
    expect(cleanLines(lines, { command: "echo", exitCode: "0", enabled: parseCleaners("dedup") })).toEqual([
        "warn: retry",
        "  … (3 more identical lines)",
        "done",
    ]);
});

test("dedup: leaves distinct lines and short runs untouched", () => {
    const lines = ["a", "b", "b", "c"];
    expect(cleanLines(lines, { command: "echo", exitCode: "0", enabled: parseCleaners("dedup") })).toEqual(lines);
});

test("redact: masks secret-named assignments, AWS keys, and bearer tokens on success and failure", () => {
    const lines = ["export GITHUB_TOKEN=ghp_abcd1234", "key AKIAIOSFODNN7EXAMPLE end", "Authorization: Bearer sk-xyz.123"];
    expect(cleanLines(lines, { command: "env", exitCode: "0", enabled: parseCleaners("redact") })).toEqual([
        "export GITHUB_TOKEN=***",
        "key *** end",
        "Authorization: Bearer ***",
    ]);
    expect(cleanLines(["boom TOKEN=secretval"], { command: "env", exitCode: "1", enabled: parseCleaners("redact") })).toEqual(["boom TOKEN=***"]);
});

test("lint cleaner: drops tsc perf diagnostics and node warnings on green, keeps real diagnostics", () => {
    const lines = ["(node:42) ExperimentalWarning: Type Stripping", "Files:  412", "Check time:  3.10s", "src/a.ts(1,1): warning TS6133: unused"];
    expect(cleanLines(lines, { command: "tsc --noEmit --diagnostics", exitCode: "0", enabled: parseCleaners("lint") })).toEqual([
        "src/a.ts(1,1): warning TS6133: unused",
    ]);
});

test("ls cleaner: strips the `total N` block header", () => {
    const lines = ["total 24", "-rw-r--r-- 1 u u 120 a.ts", "-rw-r--r-- 1 u u 240 b.ts"];
    expect(cleanLines(lines, { command: "ls -l", exitCode: "0", enabled: parseCleaners("ls") })).toEqual([
        "-rw-r--r-- 1 u u 120 a.ts",
        "-rw-r--r-- 1 u u 240 b.ts",
    ]);
});

test("build cleaner: strips cargo per-crate Compiling/Updating noise, keeps Finished", () => {
    const lines = ["   Compiling serde v1.0", "   Updating crates.io index", "    Finished dev [unoptimized] in 12.4s"];
    expect(cleanLines(lines, { command: "cargo build", exitCode: "0", enabled: parseCleaners("build") })).toEqual([
        "    Finished dev [unoptimized] in 12.4s",
    ]);
});

test("sessionKeyFromLog: recovers the agent session name from a per-command pane-log path", () => {
    expect(sessionKeyFromLog("/logs/terminals/agent-abcd1234-%5.log")).toBe("agent-abcd1234");
    expect(sessionKeyFromLog("")).toBeUndefined();
    expect(sessionKeyFromLog(undefined)).toBeUndefined();
});

test("collapseCached: first run records and passes through, an identical repeat collapses to the marker", () => {
    const store = memoryStore();
    const first = collapseCached("git status output", "git status", store, "/logs/x.log");
    expect(first).toEqual({ body: "git status output", cached: false });
    const second = collapseCached("git status output", "git status", store, "/logs/x.log");
    expect(second.cached).toBe(true);
    expect(second.body).toContain(CACHE_MARKER);
    expect(second.body).toContain("retrieve-output /logs/x.log");
});

test("collapseCached: different output for the same command is not a hit", () => {
    const store = memoryStore();
    collapseCached("first", "date", store, "");
    expect(collapseCached("second", "date", store, "").cached).toBe(false);
});

test("filterOutput: cache collapses a byte-identical success repeat, and is a no-op without a store", () => {
    const store = memoryStore();
    const raw = "hello\nworld\n";
    expect(filterOutput(raw, "echo hi", "0", "0", "", new Set(CLEANERS), store)).toBe("hello\nworld\n");
    const repeat = filterOutput(raw, "echo hi", "0", "0", "/logs/y.log", new Set(CLEANERS), store);
    expect(repeat).toContain(CACHE_MARKER);
    // Without a store the same input passes through unchanged (deterministic for the offline bench).
    expect(filterOutput(raw, "echo hi", "0", "0", "")).toBe("hello\nworld\n");
});

test("filterOutput: cache disabled leaves a repeat untouched", () => {
    const store = memoryStore();
    const raw = "same\noutput\n";
    filterOutput(raw, "echo x", "0", "0", "", parseCleaners("-cache"), store);
    expect(filterOutput(raw, "echo x", "0", "0", "", parseCleaners("-cache"), store)).toBe("same\noutput\n");
});
