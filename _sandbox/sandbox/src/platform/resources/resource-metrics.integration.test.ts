import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RESOURCE_METRICS_FILE, type ResourceSampler, type ResourceSnapshot, startResourceMetrics } from "./resource-metrics.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("samples immediately into the durable logs tree as JSONL", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "resource-metrics-"));
    roots.push(historyRoot);
    const snapshot: ResourceSnapshot = {
        schema: 1,
        at: "2026-08-09T00:00:00.000Z",
        uptimeSeconds: 12,
        window: { eventLoop: { delayP99Ms: 4 } },
        daemon: { memory: { rssBytes: 100 } },
        system: {},
        processes: {},
        owners: { turnRuns: { frames: 3 } },
    };
    const sampler: ResourceSampler = { sample: vi.fn(async () => snapshot), stop: vi.fn() };
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: vi.fn(), error: vi.fn() }, intervalMs: 3_600_000, sampler });

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
    expect(sampler.stop).toHaveBeenCalledOnce();
});

test("an empty history root is the explicit persistence opt-out", async () => {
    const sampler: ResourceSampler = { sample: vi.fn(), stop: vi.fn() };
    const metrics = startResourceMetrics({ historyRoot: "", logger: { warn: vi.fn(), error: vi.fn() }, sampler });
    await metrics.sample();
    metrics.stop();
    expect(sampler.sample).not.toHaveBeenCalled();
    expect(sampler.stop).toHaveBeenCalledOnce();
});

// OOM alarm: fires on the delta between samples, never on the first sample after a restart.
const withCgroup = (at: string, kills: number, roles: Record<string, number>): ResourceSnapshot => ({
    schema: 1,
    at,
    uptimeSeconds: 1,
    window: {},
    daemon: {},
    system: { cgroup: { event_oom_kill: kills } },
    processes: { byRole: Object.fromEntries(Object.entries(roles).map(([role, count]) => [role, { count }])) },
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
    const sampler: ResourceSampler = { sample: vi.fn(async () => samples[index++] ?? samples[1]!), stop: vi.fn() };
    const error = vi.fn();
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: vi.fn(), error }, intervalMs: 3_600_000, sampler });

    await metrics.sample();
    // First sample has nothing to diff against; comparing to zero would replay every historical kill.
    expect(error).not.toHaveBeenCalled();

    await metrics.sample();
    metrics.stop();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatchObject({ event_oom_kill: 2, lostByRole: { browser: 4 } });
    // A role that did not shrink is not named.
    expect(error.mock.calls[0]?.[0]?.lostByRole).not.toHaveProperty("terminal");
});

test("a steady OOM counter is silent: the alarm is the delta, not the level", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "resource-metrics-"));
    roots.push(historyRoot);
    // Absolute count stays 5 forever after one historical kill; alarming on the level would fire every minute.
    const snapshot = withCgroup("2026-08-09T00:00:00.000Z", 5, { browser: 2 });
    const sampler: ResourceSampler = { sample: vi.fn(async () => snapshot), stop: vi.fn() };
    const error = vi.fn();
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: vi.fn(), error }, intervalMs: 3_600_000, sampler });

    await metrics.sample();
    await metrics.sample();
    await metrics.sample();
    metrics.stop();
    expect(error).not.toHaveBeenCalled();
});
