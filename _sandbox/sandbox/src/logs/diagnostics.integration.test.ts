import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opMatches, readLogLines, readMetricSeries, readSlowSpans } from "./diagnostics.js";

// Pins the ways a naive tail misleads: oldest-first order, routine lines drowning real ones, and an empty answer that
// could mean the read did not reach far enough.

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
    expect(result.lines.map((l) => l["message"])).toEqual(["turn failed", "host: heartbeat failed"]);
    expect(result.matched).toBe(2);
});

test("an unclassifiable level is shown rather than dropped", async () => {
    const dir = await root();
    await write(dir, "daemon.log", [line({ level: "surprise", message: "who wrote this" })]);

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
    expect(result.lines.map((l) => l["message"])).toEqual(["e49", "e48", "e47", "e46", "e45"]);
    expect(result.matched).toBe(50);
});

test("a missing file is a normal empty answer, not a failure", async () => {
    const dir = await root();
    // perf.jsonl does not exist until something has been slow.
    expect(await readLogLines(dir, { file: "perf.jsonl", limit: 10 })).toMatchObject({ lines: [], matched: 0, readBytes: 0 });
});

test("a log that exists but cannot be read is a failure, never a quiet empty answer", async () => {
    const dir = await root();
    await mkdir(join(dir, "logs", "daemon.log"));
    await expect(readLogLines(dir, { file: "daemon.log", level: "error", limit: 10 })).rejects.toThrow("EISDIR");
});

test("a torn line loses one line, never the read", async () => {
    const dir = await root();
    await write(dir, "daemon.log", ["{not json", line({ level: "error", message: "survivor" }), "[1,2,3]"]);

    const result = await readLogLines(dir, { file: "daemon.log", level: "error", limit: 10 });
    expect(result.lines.map((l) => l["message"])).toEqual(["survivor"]);
});

test("a read whose budget ran out inside the window says so", async () => {
    const dir = await root();
    const filler = line({ level: "info", message: "x".repeat(2_000) });
    await write(dir, "daemon.log", Array.from({ length: 100 }, () => filler));

    const truncated = await readLogLines(dir, { file: "daemon.log", level: "error", sinceMs: Date.parse(AT(0)) - 3_600_000, limit: 10, budgetBytes: 50_000 });
    expect(truncated.windowTruncated).toBe(true);
    expect(truncated.coverage.ended).toBe("budget");
});

test("a window entirely inside what was read is never flagged as truncated, and the read stops at its start", async () => {
    const dir = await root();
    const filler = line({ time: AT(0), level: "info", message: "x".repeat(2_000) });
    await write(dir, "daemon.log", [...Array.from({ length: 2_000 }, () => filler), line({ time: AT(10), level: "error", message: "recent" })]);

    const complete = await readLogLines(dir, { file: "daemon.log", level: "error", sinceMs: Date.parse(AT(5)), limit: 10, budgetBytes: 1_000_000 });
    expect(complete.lines.map((l) => l["message"])).toEqual(["recent"]);
    expect(complete.windowTruncated).toBe(false);
    expect(complete.coverage.ended).toBe("window");
    // One chunk back reached a line older than the window: the four megabytes before it were never read.
    expect(complete.readBytes).toBeLessThan(1_000_000);
});

// Read backwards in chunks: a line that straddles two of them, or is longer than one, must come back whole.
test("lines longer than a read chunk, and lines straddling chunks, come back whole", async () => {
    const dir = await root();
    const long = line({ level: "error", message: "long", pad: "y".repeat(600_000) });
    const many = Array.from({ length: 3_000 }, (_, index) => line({ level: "error", message: `e${index}`, pad: "z".repeat(index % 300) }));
    await write(dir, "daemon.log", [line({ level: "error", message: "first" }), long, ...many]);

    const result = await readLogLines(dir, { file: "daemon.log", level: "error", limit: 5_000 });
    expect(result.matched).toBe(3_002);
    expect(result.lines.at(-1)?.["message"]).toBe("first");
    expect(result.lines.at(-2)?.["pad"]).toHaveLength(600_000);
    expect(result.coverage.ended).toBe("start");
});

// pruneLogFiles keeps what a cut dropped as daemon.log.1 (log-files.ts); a window reaching back past the live file reads on.
test("a window that reaches past the live file reads on into its rotated segment, and one that does not leaves it alone", async () => {
    const dir = await root();
    await write(dir, "daemon.log.1", [line({ time: AT(1), level: "error", message: "rotated" })]);
    await write(dir, "daemon.log", [line({ time: AT(20), level: "error", message: "live" })]);

    const all = await readLogLines(dir, { file: "daemon.log", level: "error", limit: 10 });
    expect(all.lines.map((l) => l["message"])).toEqual(["live", "rotated"]);
    expect(all.coverage.files.map((file) => file.split("/").at(-1))).toEqual(["daemon.log", "daemon.log.1"]);

    const recent = await readLogLines(dir, { file: "daemon.log", level: "error", sinceMs: Date.parse(AT(10)), limit: 10 });
    expect(recent.lines.map((l) => l["message"])).toEqual(["live"]);
    // The live file reached the window's start only at its own first line, so the segment was opened and stopped at once.
    expect(recent.coverage.ended).toBe("window");
});

test("repeats of one message fold into one group, ids and numbers aside", async () => {
    const dir = await root();
    await write(dir, "daemon.log", [
        line({ time: AT(1), level: "warn", message: "hosts: refused a socket from 10.0.0.1" }),
        line({ time: AT(2), level: "error", message: "turn failed" }),
        line({ time: AT(3), level: "warn", message: "hosts: refused a socket from 10.0.0.2" }),
        line({ time: AT(4), level: "warn", message: "hosts: refused a socket from 10.0.0.3" }),
    ]);

    const result = await readLogLines(dir, { file: "daemon.log", level: "warn", limit: 10 });
    expect(result.groups.map((group) => group.count)).toEqual([3, 1]);
    expect(result.groups[0]).toMatchObject({ newestAt: Date.parse(AT(4)), oldestAt: Date.parse(AT(1)) });
    expect(result.groups[0]?.example["message"]).toBe("hosts: refused a socket from 10.0.0.3");
});

// ---- slow spans ----

test("an op names one span exactly, and a trailing dot or star names every span under it", () => {
    expect(opMatches("git.run", "git.run")).toBe(true);
    expect(opMatches("git.run", "git.run.wait")).toBe(false);
    expect(opMatches("git.", "git.run.wait")).toBe(true);
    expect(opMatches("git.*", "git.scan")).toBe(true);
    expect(opMatches("git.", "http.request")).toBe(false);
});

test("slow spans group by op, and by op and subject, with percentiles over every match", async () => {
    const dir = await root();
    const span = (perf: string, ms: number, over: Record<string, unknown> = {}): string => line({ level: "warn", perf, ms, message: `slow ${perf}`, ...over });
    await write(dir, "perf.jsonl", [
        ...[100, 200, 300, 400].map((ms) => span("http.request", ms, { method: "GET", path: `/agents/a${ms}/state` })),
        span("http.request", 900, { method: "POST", path: "/turns" }),
        span("git.run", 50, { git: "status --porcelain" }),
        span("git.run.wait", 5_000, { git: "status --porcelain" }),
    ]);

    const byOp = await readSlowSpans(dir, { groupBy: "op", limit: 10 });
    const http = byOp.spanGroups.find((group) => group.key === "http.request");
    expect(http).toMatchObject({ count: 5, p50: 300, max: 900 });
    expect(http?.worst["path"]).toBe("/turns");

    const bySubject = await readSlowSpans(dir, { groupBy: "op+path", op: "http.request", limit: 10 });
    expect(bySubject.spanGroups.map((group) => [group.key, group.count])).toEqual([
        ["http.request GET /agents/:id/state", 4],
        ["http.request POST /turns", 1],
    ]);

    const gitRun = await readSlowSpans(dir, { groupBy: "op", op: "git.run", limit: 10 });
    expect(gitRun.matched).toBe(1);
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
    // Series order is oldest-first, opposite of the newest-first log reads.
    expect(series.points.map((point) => point.value)).toEqual([20, 80, 50]);
    expect(series).toMatchObject({ min: 20, max: 80, mean: 50 });
});

test("a path naming an object or a list answers with its newest value rather than an empty series", async () => {
    const dir = await root();
    await write(dir, "resource-metrics.jsonl", [
        sample(0, { window: { eventLoop: { delayP99Ms: 20 } }, processes: { top: [{ name: "old" }] } }),
        sample(1, { window: { eventLoop: { delayP99Ms: 30 } }, processes: { top: [{ name: "node", rssBytes: 9 }] } }),
    ]);

    const object = await readMetricSeries(dir, { field: "window.eventLoop", limit: 10 });
    expect(object).toMatchObject({ points: [], latest: { at: AT(1), value: { delayP99Ms: 30 } } });
    expect(object.mean).toBeUndefined();
    expect((await readMetricSeries(dir, { field: "processes.top", limit: 10 })).latest?.value).toEqual([{ name: "node", rssBytes: 9 }]);
});

test("a path absent from the newest sample names the deepest part of it that exists, and what is under it", async () => {
    const dir = await root();
    await write(dir, "resource-metrics.jsonl", [sample(0, { daemon: { memory: { rssBytes: 5, heapUsedBytes: 2 } } })]);

    const series = await readMetricSeries(dir, { field: "daemon.memory.rssByttes", limit: 10 });
    expect(series.nearest).toEqual({ path: "daemon.memory", keys: ["rssBytes", "heapUsedBytes"] });
});

test("summaries cover every sample in the window, and a long window is thinned to its peaks", async () => {
    const dir = await root();
    // Sixty samples, one spike in the middle: the limit of six must keep it.
    await write(
        dir,
        "resource-metrics.jsonl",
        Array.from({ length: 60 }, (_, minute) => sample(minute, { daemon: { memory: { rssBytes: minute === 31 ? 1_000 : 10 } } })),
    );

    const series = await readMetricSeries(dir, { field: "daemon.memory.rssBytes", limit: 6 });
    expect(series).toMatchObject({ samples: 60, min: 10, max: 1_000, bucketSize: 10 });
    expect(series.points).toHaveLength(6);
    expect(series.points[0]?.at).toBe(AT(0));
    expect(series.points.map((point) => point.value)).toContain(1_000);
});

test("the series window is applied, and an empty window reports no summary rather than zeroes", async () => {
    const dir = await root();
    await write(dir, "resource-metrics.jsonl", [sample(0, { daemon: { memory: { rssBytes: 5 } } })]);

    const series = await readMetricSeries(dir, { field: "daemon.memory.rssBytes", sinceMs: Date.parse(AT(30)), limit: 10 });
    expect(series.points).toEqual([]);
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
