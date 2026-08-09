import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
    RESOURCE_METRICS_FILE,
    type ResourceSampler,
    type ResourceSnapshot,
    startResourceMetrics,
} from "./resource-metrics.js";

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
    const metrics = startResourceMetrics({ historyRoot, logger: { warn: vi.fn() }, intervalMs: 3_600_000, sampler });

    // The explicit sample joins the eager one when it is still in flight, making startup deterministic without
    // a polling sleep in the test (and proving overlapping timer fires cannot append duplicate snapshots).
    await metrics.sample();
    metrics.stop();

    const text = await readFile(join(historyRoot, "logs", RESOURCE_METRICS_FILE), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim().split("\n").map((line) => JSON.parse(line))).toEqual([snapshot]);
    expect(sampler.stop).toHaveBeenCalledOnce();
});

test("an empty history root is the explicit persistence opt-out", async () => {
    const sampler: ResourceSampler = { sample: vi.fn(), stop: vi.fn() };
    const metrics = startResourceMetrics({ historyRoot: "", logger: { warn: vi.fn() }, sampler });
    await metrics.sample();
    metrics.stop();
    expect(sampler.sample).not.toHaveBeenCalled();
    expect(sampler.stop).toHaveBeenCalledOnce();
});
