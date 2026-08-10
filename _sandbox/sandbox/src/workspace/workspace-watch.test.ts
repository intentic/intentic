import { afterEach, expect, test, vi } from "vitest";
import { createPathBatcher, DEBOUNCE_MS, MAX_PATHS } from "./workspace-watch.js";

/* The coalescing rule on its own clock. Its sibling .integration.test.ts drives real chokidar over a real temp
 * tree, which can say that a change is announced and that node_modules never is — but it cannot say how many
 * batches a burst became, because that answer depends on whether the runner delivered two inotify events
 * inside the same 250ms window. Everything about the batching itself is decided here, where the timers are the
 * test's. */

const batchesOf = (): { batches: string[][]; add: (path: string) => void } => {
    const batches: string[][] = [];
    const batcher = createPathBatcher((paths) => batches.push(paths));
    return { batches, add: batcher.add };
};

afterEach(() => {
    vi.useRealTimers();
});

test("a burst inside one window is announced as a single batch", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    add("a.txt");
    add("b.txt");
    // Nothing yet: the window is what turns an agent's edit storm into one frame instead of one per file.
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([["a.txt", "b.txt"]]);
});

test("the window opens on the first path and is not reset by later ones", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    add("a.txt");
    // A path arriving late in the window joins the batch without pushing the deadline out — that is what bounds
    // latency to ~250ms while an agent keeps editing, rather than starving the browser until it stops.
    vi.advanceTimersByTime(DEBOUNCE_MS - 10);
    add("b.txt");
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([["a.txt", "b.txt"]]);
});

test("a file touched twice in a window is announced once", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    // chokidar reports a single write as add-then-change often enough that this is the common case, not an edge.
    add("a.txt");
    add("a.txt");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches).toEqual([["a.txt"]]);
});

test("the next change after a flush opens a fresh window", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    add("a.txt");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    add("b.txt");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches).toEqual([["a.txt"], ["b.txt"]]);
});

test("a quiet window announces nothing at all", () => {
    vi.useFakeTimers();
    const { batches } = batchesOf();
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(batches).toHaveLength(0);
});

test("a burst past the path ceiling becomes an empty batch — just refetch the tree", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    for (let index = 0; index <= MAX_PATHS; index += 1) {
        add(`file-${index}.txt`);
    }
    vi.advanceTimersByTime(DEBOUNCE_MS);
    // A branch switch or a codegen run is not worth a frame listing every file it touched.
    expect(batches).toEqual([[]]);
});

test("a burst exactly at the ceiling still names its paths", () => {
    vi.useFakeTimers();
    const { batches, add } = batchesOf();
    for (let index = 0; index < MAX_PATHS; index += 1) {
        add(`file-${index}.txt`);
    }
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches[0]).toHaveLength(MAX_PATHS);
});
