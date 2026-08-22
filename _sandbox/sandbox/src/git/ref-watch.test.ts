import { afterEach, expect, test, vi } from "vitest";
import { BATCH_MS, createRepoBatcher } from "./ref-watch.js";

/* The batching rule on its own clock. Its sibling .integration.test.ts drives the real watcher over real git
 * repositories, which is the only place that can say a commit, a branch delete or a per-worktree checkout is
 * seen at all, and it is the wrong place to ask HOW MANY batches a burst became: that answer depends on whether
 * a loaded runner got three git subprocesses and their inotify events through inside one 250ms window, and it
 * came back as "the debounce is broken" on a machine that was merely busy. Everything about the coalescing is
 * decided here, where the timers are the test's. */

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
    // Nothing yet: the window is what turns a rebase replaying forty commits into one frame rather than forty
    // round trips to every connected browser.
    vi.advanceTimersByTime(BATCH_MS - 1);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([["other", "root"]]);
});

test("the window opens on the first move and is not reset by later ones", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    add("root");
    // A move landing late in the window joins the batch instead of pushing the deadline out, so a repo that is
    // written continuously still reports within a window rather than only once it goes quiet.
    vi.advanceTimersByTime(BATCH_MS - 10);
    add("root");
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([["root"]]);
});

test("one commit's several writes name the repo once", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    // A single commit writes the loose ref AND the reflog, so the duplicate is the common case, not an edge.
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
