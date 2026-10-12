import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCE_METRICS_FILE, type ResourceSampler, type ResourceSnapshot, startResourceMetrics } from "./resource-metrics.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("samples immediately into the durable logs tree as JSONL", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "resource-metrics-"));
    roots.push(historyRoot);
    const snapshot: ResourceSnapshot = {
        schema: 2,
        at: "2026-08-09T00:00:00.000Z",
        uptimeSeconds: 12,
        window: { eventLoop: { delayP99Ms: 4 } },
        daemon: { memory: { rssBytes: 100 } },
        system: {},
        processes: {},
        queue: { heavy: { slots: 2, held: 1, longestHoldSeconds: 12 } },
        owners: { turnRuns: { frames: 3 } },
    };
    const sampler: ResourceSampler = { sample: jest.fn(async () => snapshot), stop: jest.fn() };
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: jest.fn(), error: jest.fn() }, intervalMs: 3_600_000, sampler });

    // The explicit sample joins any eager one still in flight, so startup is deterministic without a poll.
    await metrics.sample();
    metrics.stop();

    const text = await readFile(join(historyRoot, "logs", RESOURCE_METRICS_FILE), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(
        text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
    ).toEqual([snapshot]);
    expect(sampler.stop).toHaveBeenCalledTimes(1);
});

test("an empty history root is the explicit persistence opt-out", async () => {
    const sampler: ResourceSampler = { sample: jest.fn(), stop: jest.fn() };
    const metrics = startResourceMetrics({ historyRoot: "", logger: { warn: jest.fn(), error: jest.fn() }, sampler });
    await metrics.sample();
    metrics.stop();
    expect(sampler.sample).not.toHaveBeenCalled();
    expect(sampler.stop).toHaveBeenCalledTimes(1);
});

/* THE SERIES CUTS ITSELF, because the logs prune cut it in place beside its appends, and a reader could meet it half written. */
test("past its own cap the series keeps the newest whole samples that fit in most of a week, and a torn last line costs only itself", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "resource-metrics-"));
    roots.push(historyRoot);
    const path = join(historyRoot, "logs", RESOURCE_METRICS_FILE);
    await mkdir(join(historyRoot, "logs"));
    // Just past forty megabytes of thousand-byte lines, and a fragment a crash left at the end.
    await writeFile(path, `${`${"x".repeat(999)}\n`.repeat(40_001)}{"torn`);
    const snapshot = withCgroup("2026-08-09T00:00:00.000Z", 0, {});
    const sampler: ResourceSampler = { sample: jest.fn(async () => snapshot), stop: jest.fn() };
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: jest.fn(), error: jest.fn() }, intervalMs: 3_600_000, sampler });
    await metrics.sample();
    metrics.stop();

    const text = await readFile(path, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(30_000_000);
    const lines = text.split("\n").filter((line) => line !== "");
    // The fragment ended a line of its own rather than swallowing the sample, which is the newest line whole.
    expect(lines.at(-2)).toBe('{"torn');
    expect(JSON.parse(lines.at(-1) ?? "")).toEqual(snapshot);
    expect(lines.slice(0, -2).every((line) => line === "x".repeat(999))).toBe(true);
});

// OOM alarm: fires on the delta between samples, never on the first sample after a restart.
const withCgroup = (at: string, kills: number, roles: Record<string, number>): ResourceSnapshot => ({
    schema: 2,
    at,
    uptimeSeconds: 1,
    window: {},
    daemon: {},
    system: { cgroup: { event_oom_kill: kills } },
    processes: { byRole: Object.fromEntries(Object.entries(roles).map(([role, count]) => [role, { count }])) },
    // Nothing held, so the OOM assertions below cannot be reading a slot alarm by accident.
    queue: {},
    owners: {},
});

test("an OOM kill logs at error, naming how many and which roles shrank", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "resource-metrics-"));
    roots.push(historyRoot);
    const samples = [
        withCgroup("2026-08-09T00:00:00.000Z", 0, { browser: 17, terminal: 4 }),
        withCgroup("2026-08-09T00:01:00.000Z", 2, { browser: 13, terminal: 4 }),
    ];
    let index = 0;
    const sampler: ResourceSampler = { sample: jest.fn(async () => samples[index++] ?? samples[1]!), stop: jest.fn() };
    const error = jest.fn();
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: jest.fn(), error }, intervalMs: 3_600_000, sampler });

    await metrics.sample();
    // First sample has nothing to diff against; comparing to zero would replay every historical kill.
    expect(error).not.toHaveBeenCalled();

    await metrics.sample();
    metrics.stop();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ event_oom_kill: 2, lostByRole: { browser: 4 } });
    // A role that did not shrink is not named.
    expect(error.mock.calls[0]?.[0]?.lostByRole).not.toHaveProperty("terminal");
});

test("a steady OOM counter is silent: the alarm is the delta, not the level", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "resource-metrics-"));
    roots.push(historyRoot);
    // Absolute count stays 5 forever after one historical kill; alarming on the level would fire every minute.
    const snapshot = withCgroup("2026-08-09T00:00:00.000Z", 5, { browser: 2 });
    const sampler: ResourceSampler = { sample: jest.fn(async () => snapshot), stop: jest.fn() };
    const error = jest.fn();
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: jest.fn(), error }, intervalMs: 3_600_000, sampler });

    await metrics.sample();
    await metrics.sample();
    await metrics.sample();
    metrics.stop();
    expect(error).not.toHaveBeenCalled();
});
