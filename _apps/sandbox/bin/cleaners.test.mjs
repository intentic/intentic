import { expect, test } from "vitest";
import { filterOutput } from "./agent-output-filter.mjs";
import { CLEANERS, cleanLines, parseCleaners } from "./cleaners.mjs";

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
