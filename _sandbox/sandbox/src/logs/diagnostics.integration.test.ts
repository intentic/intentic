import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readLogLines, readMetricSeries, TAIL_BUDGET_BYTES } from "./diagnostics.js";

/* The filtered read, which is the whole difference between this and `tail daemon.log`. What each case pins is a
 * way the naive version misleads: oldest-first ordering, routine lines drowning real ones, and, the one that
 * matters most, an empty answer that means "I could not see that far back" reading as "nothing happened". */

const root = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "diag-"));
    await mkdir(join(dir, "logs"), { recursive: true });
    return dir;
};

const line = (over: Record<string, unknown>): string => JSON.stringify({ time: "2026-08-22T12:00:00.000Z", level: "info", message: "x", ...over });

const write = (dir: string, name: string, lines: readonly string[]): Promise<void> => writeFile(join(dir, "logs", name), `${lines.join("\n")}\n`);

const AT = (minute: number): string => `2026-08-22T12:${String(minute).padStart(2, "0")}:00.000Z`;

test("warn is a floor: it returns warn and worse, and drops the routine lines around them", async () => {
    const dir = await root();
    await write(dir, "daemon.log", [
        line({ level: "info", message: "chores: probe finished" }),
        line({ level: "warn", message: "host: heartbeat failed" }),
        line({ level: "debug", message: "noise" }),
        line({ level: "error", message: "turn failed" }),
    ]);

    const result = await readLogLines(dir, { file: "daemon.log", level: "warn", limit: 10 });
    // Newest first: a diagnostic reads downwards from what just happened.
    expect(result.lines.map((l) => l["message"])).toEqual(["turn failed", "host: heartbeat failed"]);
    expect(result.matched).toBe(2);
});

test("an unclassifiable level is shown rather than dropped", async () => {
    const dir = await root();
    await write(dir, "daemon.log", [line({ level: "surprise", message: "who wrote this" })]);

    // A line nobody can classify is exactly the one worth showing; silently filtering it is how a real problem
    // becomes invisible to the tool that exists to find it.
    expect((await readLogLines(dir, { file: "daemon.log", level: "error", limit: 10 })).matched).toBe(1);
});

test("the time window is applied against the line's own timestamp", async () => {
    const dir = await root();
    await write(dir, "daemon.log", [
        line({ time: AT(0), level: "error", message: "old" }),
        line({ time: AT(30), level: "error", message: "recent" }),
    ]);

    const result = await readLogLines(dir, { file: "daemon.log", level: "error", sinceMs: Date.parse(AT(20)), limit: 10 });
    expect(result.lines.map((l) => l["message"])).toEqual(["recent"]);
});

test("contains matches anywhere in the line, so a caller need not know which field carries the id", async () => {
    const dir = await root();
    await write(dir, "daemon.log", [
        line({ level: "error", message: "turn failed", conversationId: "wise-condor-5qto" }),
        line({ level: "error", message: "turn failed", conversationId: "other" }),
    ]);

    const result = await readLogLines(dir, { file: "daemon.log", level: "error", contains: "WISE-condor", limit: 10 });
    expect(result.matched).toBe(1);
    expect(result.lines[0]?.["conversationId"]).toBe("wise-condor-5qto");
});

test("limit cuts the answer and says how many it cut", async () => {
    const dir = await root();
    await write(
        dir,
        "daemon.log",
        Array.from({ length: 50 }, (_, index) => line({ level: "error", message: `e${index}` })),
    );

    const result = await readLogLines(dir, { file: "daemon.log", level: "error", limit: 5 });
    // The newest five, and the count says the rest exist: a truncated answer that looks complete is the bug.
    expect(result.lines.map((l) => l["message"])).toEqual(["e49", "e48", "e47", "e46", "e45"]);
    expect(result.matched).toBe(50);
});

test("a missing file is a normal empty answer, not a failure", async () => {
    const dir = await root();
    // perf.jsonl does not exist until something has been slow.
    expect(await readLogLines(dir, { file: "perf.jsonl", limit: 10 })).toMatchObject({ lines: [], matched: 0, readBytes: 0 });
});

test("a torn line loses one line, never the read", async () => {
    const dir = await root();
    await write(dir, "daemon.log", ["{not json", line({ level: "error", message: "survivor" }), "[1,2,3]"]);

    const result = await readLogLines(dir, { file: "daemon.log", level: "error", limit: 10 });
    expect(result.lines.map((l) => l["message"])).toEqual(["survivor"]);
});

/* THE DISTINCTION A READER CANNOT MAKE FOR THEMSELVES. An empty answer over a window the read could not reach
 * looks exactly like proof that nothing happened, and that is the direction the mistake is dangerous in. */
test("a read that started mid-file says so when the window reaches past what it could see", async () => {
    const dir = await root();
    const filler = line({ level: "info", message: "x".repeat(2_000) });
    const count = Math.ceil(TAIL_BUDGET_BYTES / (filler.length + 1)) + 200;
    await write(
        dir,
        "daemon.log",
        Array.from({ length: count }, () => filler),
    );

    // Asking about a window older than the tail: the answer is empty and the caller is told it is incomplete.
    const truncated = await readLogLines(dir, { file: "daemon.log", level: "error", sinceMs: Date.parse(AT(0)) - 3_600_000, limit: 10 });
    expect(truncated.windowTruncated).toBe(true);
});

test("a window entirely inside what was read is never flagged as truncated", async () => {
    const dir = await root();
    const filler = line({ time: AT(0), level: "info", message: "x".repeat(2_000) });
    const count = Math.ceil(TAIL_BUDGET_BYTES / (filler.length + 1)) + 200;
    // Enough old filler to force a mid-file read, then the recent line the query is actually about.
    await write(dir, "daemon.log", [...Array.from({ length: count }, () => filler), line({ time: AT(10), level: "error", message: "recent" })]);

    /* The file was cut, but the oldest line still visible is OLDER than the window asked for, so the cut cannot
     * have hidden anything from this question. A warning that fires on complete answers is one nobody reads. */
    const complete = await readLogLines(dir, { file: "daemon.log", level: "error", sinceMs: Date.parse(AT(5)), limit: 10 });
    expect(complete.lines.map((l) => l["message"])).toEqual(["recent"]);
    expect(complete.windowTruncated).toBe(false);
});

// ---- the resource series ----

const sample = (minute: number, over: Record<string, unknown>): string => JSON.stringify({ at: AT(minute), ...over });

test("a dotted path becomes a series with its own summary", async () => {
    const dir = await root();
    await write(dir, "resource-metrics.jsonl", [
        sample(0, { window: { eventLoop: { delayP99Ms: 20 } } }),
        sample(1, { window: { eventLoop: { delayP99Ms: 80 } } }),
        sample(2, { window: { eventLoop: { delayP99Ms: 50 } } }),
    ]);

    const series = await readMetricSeries(dir, { field: "window.eventLoop.delayP99Ms", limit: 10 });
    // Oldest first: a series is plotted left-to-right in time, unlike a log.
    expect(series.points.map((point) => point.value)).toEqual([20, 80, 50]);
    expect(series).toMatchObject({ min: 20, max: 80, mean: 50 });
});

test("a path naming an object rather than a number counts as missing, so a typo is visible", async () => {
    const dir = await root();
    await write(dir, "resource-metrics.jsonl", [sample(0, { window: { eventLoop: { delayP99Ms: 20 } } })]);

    // The caller gets "no numeric values, 1 sample looked at" instead of a confidently empty series.
    const series = await readMetricSeries(dir, { field: "window.eventLoop", limit: 10 });
    expect(series).toMatchObject({ points: [], missing: 1 });
    expect(series.mean).toBeUndefined();
});

test("the series window is applied, and an empty window reports no summary rather than zeroes", async () => {
    const dir = await root();
    await write(dir, "resource-metrics.jsonl", [sample(0, { daemon: { memory: { rssBytes: 5 } } })]);

    const series = await readMetricSeries(dir, { field: "daemon.memory.rssBytes", sinceMs: Date.parse(AT(30)), limit: 10 });
    expect(series.points).toEqual([]);
    // Absent, not 0: a zero here would read as a measurement of an idle machine.
    expect(series.min).toBeUndefined();
});

test("the OOM counter is reachable by the path the tools advertise", async () => {
    const dir = await root();
    await write(dir, "resource-metrics.jsonl", [
        sample(0, { system: { cgroup: { event_oom_kill: 0 } } }),
        sample(1, { system: { cgroup: { event_oom_kill: 3 } } }),
    ]);

    expect((await readMetricSeries(dir, { field: "system.cgroup.event_oom_kill", limit: 10 })).points.map((p) => p.value)).toEqual([0, 3]);
});
