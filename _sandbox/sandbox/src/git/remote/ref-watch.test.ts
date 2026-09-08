import { afterEach, expect, test, vi } from "vitest";
import { BATCH_MS, createRepoBatcher } from "./ref-watch.js";

// The batching rule on owned fake timers; .integration.test.ts covers real git/inotify timing, which is too flaky to
// assert batch counts against.

const batchesOf = (): { batches: string[][]; add: (repo: string) => void } => {
    const batches: string[][] = [];
    const batcher = createRepoBatcher((repos) => batches.push(repos));
    return { batches, add: batcher.add };
};

afterEach(() => {
    vi.useRealTimers();
});

test("a burst of moves inside one window is announced as a single batch", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    add("root");
    add("other");
    vi.advanceTimersByTime(BATCH_MS - 1);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([["other", "root"]]);
});

test("the window opens on the first move and is not reset by later ones", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    add("root");
    vi.advanceTimersByTime(BATCH_MS - 10);
    add("root");
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([["root"]]);
});

test("one commit's several writes name the repo once", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    // A single commit writes both the loose ref and the reflog, so a duplicate add is the common case.
    add("root");
    add("root");
    vi.advanceTimersByTime(BATCH_MS);
    expect(batches).toEqual([["root"]]);
});

test("the next move after a flush opens a fresh window", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    add("root");
    vi.advanceTimersByTime(BATCH_MS);
    add("other");
    vi.advanceTimersByTime(BATCH_MS);
    expect(batches).toEqual([["root"], ["other"]]);
});

test("a quiet window announces nothing at all", () => {
    vi.useFakeTimers();
    const { batches } = batchesOf();
    vi.advanceTimersByTime(BATCH_MS * 4);
    expect(batches).toHaveLength(0);
});
