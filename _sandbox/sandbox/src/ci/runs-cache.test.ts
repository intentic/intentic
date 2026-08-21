import type { PipelineRun } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRunsCache } from "./runs-cache.js";

const run = (over: Partial<PipelineRun> = {}): PipelineRun => ({
    repo: "web",
    host: "github",
    project: "acme/web",
    runId: 1,
    branch: "main",
    sha: "abc1234def",
    status: "success",
    url: "https://github.com/acme/web/actions/runs/1",
    createdAt: 1000,
    ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a sweep serves within the TTL and reads stale after it", () => {
    const cache = createRunsCache(1000);
    expect(cache.sweep()).toBeUndefined();
    cache.replace([run()]);
    expect(cache.sweep()).toHaveLength(1);
    vi.advanceTimersByTime(1001);
    expect(cache.sweep()).toBeUndefined();
});

test("an upsert replaces the same run in place and does NOT extend sweep freshness", () => {
    const cache = createRunsCache(1000);
    cache.replace([run({ status: "running" }), run({ runId: 2, createdAt: 2000 })]);
    cache.upsert(run({ status: "failed" }));
    const runs = cache.sweep();
    expect(runs?.map((entry) => [entry.runId, entry.status])).toEqual([
        [2, "success"],
        [1, "failed"],
    ]);
    vi.advanceTimersByTime(900);
    cache.upsert(run({ runId: 3, createdAt: 3000 }));
    vi.advanceTimersByTime(200);
    // The upsert 100ms ago says nothing about the whole picture: the sweep is stale regardless.
    expect(cache.sweep()).toBeUndefined();
});
