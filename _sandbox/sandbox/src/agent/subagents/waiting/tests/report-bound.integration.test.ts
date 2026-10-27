import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundChildReport, HOME_REPORT_BOUND } from "../subagent-wait.js";

// How much of a child's report a wait hands its parent whole, the rest kept behind a retrieval handle.

let logsDir: string;
beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), "report-bound-"));
});
afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
});

const report = (length: number): string => Array.from({ length }, (_, at) => String.fromCodePoint(97 + (at % 26))).join("");

test("an ordinary parent gets a report up to 12k whole, and the head and tail of a longer one", () => {
    expect(boundChildReport(report(12_000), { logsDir })).toBe(report(12_000));
    const bounded = boundChildReport(report(20_000), { logsDir }) ?? "";
    expect(bounded).toContain("… report middle omitted …");
    expect(bounded).toContain("9000 chars cut");
});

// A home keeps every report it reads in the one session it means to keep small (home-rollover.ts).
test("a home gets less of it whole, and the handle to all of it", async () => {
    const long = report(10_000);
    const bounded = boundChildReport(long, { logsDir }, HOME_REPORT_BOUND) ?? "";
    expect(bounded.startsWith(long.slice(0, HOME_REPORT_BOUND.head))).toBe(true);
    expect(bounded).toContain(`${10_000 - HOME_REPORT_BOUND.head - HOME_REPORT_BOUND.tail} chars cut · full: retrieve-output`);
    expect(bounded.length).toBeLessThan(HOME_REPORT_BOUND.whole);
    const path = /retrieve-output (\S+)/u.exec(bounded)?.[1] ?? "";
    expect(await readFile(path, "utf8")).toBe(long);
    expect(boundChildReport(report(HOME_REPORT_BOUND.whole), { logsDir }, HOME_REPORT_BOUND)).toBe(report(HOME_REPORT_BOUND.whole));
});
