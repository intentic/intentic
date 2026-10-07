// Pins what verify-clocks counts as a test that can see a clock, and that the selection stays a real subset of the
// packages it reads, never all of them and never none.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { clockFiles, DEFAULT_ZONES, timeSensitive } from "./clock-suites.mjs";

test("a file that builds, reads, formats or fakes a clock is selected", () => {
    for (const text of [
        "const at = new Date(2026, 9, 7);",
        "expect(Date.now()).toBeGreaterThan(0);",
        "new Intl.DateTimeFormat('en', { hour: 'numeric' })",
        "value.toLocaleDateString()",
        "when.getHours() === 23",
        "when.setUTCDate(1)",
        "schedule({ timezone: 'Europe/Warsaw' })",
        "{ timeZone: 'UTC' }",
        "process.env.TZ = 'Pacific/Niue'",
        "evaluate the cron expression",
        "parseCron('0 3 * * *')",
        "jest.useFakeTimers()",
        "setSystemTime(0)",
        "at.toISOString()",
        "const createdAt = '2026-10-07T20:43:00Z';",
        "const createdAt = 1759869780000;",
        "bucket by dayOf(at)",
    ]) {
        assert.equal(timeSensitive(text), true, text);
    }
});

test("a file with no clock in it is left to the UTC jobs", () => {
    for (const text of [
        "expect(sum(1, 2)).toBe(3);",
        "const update = () => {};",
        "it('renders the dated badge', () => {})",
        "const version = '2026.10.7';",
        "const port = 18787;",
        "const id = 1234567890;",
    ]) {
        assert.equal(timeSensitive(text), false, text);
    }
});

test("the zones are the two extremes, a day apart on every instant", () => {
    assert.deepEqual(DEFAULT_ZONES, ["Pacific/Kiritimati", "Pacific/Niue"]);
});

test("the packages verify-clocks reads each select some of their files and never all of them", () => {
    for (const dir of ["_sandbox/sandbox", "_editor/web"]) {
        const files = clockFiles(dir);
        const all = execFileSync("git", ["ls-files", "--", `${dir}/**/*.test.ts`], { encoding: "utf8" })
            .split("\n")
            .filter(Boolean).length;
        assert.ok(files.length > 20 && files.length < all / 2, `${dir} selects ${String(files.length)} of ${String(all)}`);
        assert.ok(
            files.every((file) => !file.startsWith("/") && !file.startsWith(dir)),
            "paths are relative to the package",
        );
    }
});
