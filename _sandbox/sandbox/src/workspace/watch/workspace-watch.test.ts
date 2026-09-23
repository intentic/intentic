import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import {
    announceUnwatchedWrite,
    createPathBatcher,
    DEBOUNCE_MS,
    isWatchIgnored,
    MAX_PATHS,
    subscribeUnwatchedWrites,
    subscribeWorkspaceChanges,
    watchIgnoreGlobs,
} from "./workspace-watch.js";

// The coalescing rule on its own clock: the integration suite can prove a change is announced, but not how many batches
// a burst becomes, since that depends on runner timing. Batching itself is decided here, on fake timers.

const batchesOf = (): { batches: string[][]; add: (path: string) => void } => {
    const batches: string[][] = [];
    const batcher = createPathBatcher((paths) => batches.push(paths));
    return { batches, add: batcher.add };
};

afterEach(() => {
    jest.useRealTimers();
});

test("a burst inside one window is announced as a single batch", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    add("a.txt");
    add("b.txt");
    // Nothing yet: the window turns an edit storm into one frame instead of one per file.
    jest.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(batches).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(batches).toEqual([["a.txt", "b.txt"]]);
});

test("the window opens on the first path and is not reset by later ones", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    add("a.txt");
    // A late path joins without pushing the deadline out, bounding latency instead of starving the browser.
    jest.advanceTimersByTime(DEBOUNCE_MS - 10);
    add("b.txt");
    jest.advanceTimersByTime(10);
    expect(batches).toEqual([["a.txt", "b.txt"]]);
});

test("a file touched twice in a window is announced once", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    // A single write often arrives as create-then-update; this is the common case, not an edge one.
    add("a.txt");
    add("a.txt");
    jest.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches).toEqual([["a.txt"]]);
});

test("the next change after a flush opens a fresh window", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    add("a.txt");
    jest.advanceTimersByTime(DEBOUNCE_MS);
    add("b.txt");
    jest.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches).toEqual([["a.txt"], ["b.txt"]]);
});

test("a quiet window announces nothing at all", () => {
    jest.useFakeTimers();
    const { batches } = batchesOf();
    jest.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(batches).toHaveLength(0);
});

test("a burst past the path ceiling becomes an empty batch: just refetch the tree", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    for (let index = 0; index <= MAX_PATHS; index += 1) {
        add(`file-${index}.txt`);
    }
    jest.advanceTimersByTime(DEBOUNCE_MS);
    // A branch switch or codegen run isn't worth a frame naming every file it touched.
    expect(batches).toEqual([[]]);
});

test("a burst exactly at the ceiling still names its paths", () => {
    jest.useFakeTimers();
    const { batches, add } = batchesOf();
    for (let index = 0; index < MAX_PATHS; index += 1) {
        add(`file-${index}.txt`);
    }
    jest.advanceTimersByTime(DEBOUNCE_MS);
    expect(batches[0]).toHaveLength(MAX_PATHS);
});

// Every skip rule is a glob (to stop the native backend descending) paired with a predicate (to vet what still
// arrives); these tests fail if a rule ever grows one half without the other. Actual glob pruning is proven in the
// integration suite.

test("every skip glob covers both the directory itself and its subtree", () => {
    const globs = watchIgnoreGlobs();
    // `**/x/**` alone still reports the directory itself; `**/x` alone lets its contents through; both forms are
    // required.
    const bare = globs.filter((glob) => !glob.endsWith("/**"));
    expect(bare).not.toHaveLength(0);
    for (const glob of bare) {
        expect(globs).toContain(`${glob}/**`);
    }
    expect(globs).toHaveLength(bare.length * 2);
});

test("a build's write under a pruned dir reaches browsers only by being announced, and no watcher subscriber", () => {
    const root = WORKSPACE_ROOT;
    // The watcher cannot report this one: a repo that tracks its build output has files no watched batch ever names.
    expect(isWatchIgnored(root, `${root}/app/dist/extension.js`)).toBe(true);
    let announced = 0;
    const watched: string[][] = [];
    const stopAnnounced = subscribeUnwatchedWrites(() => (announced += 1));
    const stopWatched = subscribeWorkspaceChanges((paths) => watched.push(paths));
    announceUnwatchedWrite();
    stopAnnounced();
    stopWatched();
    announceUnwatchedWrite();
    expect(announced).toBe(1);
    // The reconciler reads an unnamed batch as "a manifest may have moved", which a finished check is not.
    expect(watched).toEqual([]);
});

test("the junk-dir globs are generated from the shared list, not restated", () => {
    const globs = watchIgnoreGlobs();
    // Adding a dir to IGNORED_DIRS grays it in the tree and skips it here too, automatically.
    for (const dir of IGNORED_DIRS) {
        expect(globs).toContain(`**/${dir}`);
    }
});

test("each skip rule still silences the path it exists for", () => {
    // One path per rule, so removing a rule fails here instead of silently costing handles on a big checkout.
    const root = WORKSPACE_ROOT;
    for (const relPath of [
        "app/node_modules/dep/index.js",
        `${STATE_DIR}/local/browser/reddit/Default/Cookies`,
        "app/.claude/worktrees/fix/src/main.ts",
        "refs/react/packages/scheduler/index.js",
        `${STATE_DIR}/records/sessions/claude/projects/-work/session.jsonl`,
    ]) {
        expect(isWatchIgnored(root, `${root}/${relPath}`)).toBe(true);
    }
});

test("the skip rules are indifferent to what the workspace root is called", () => {
    // Rules match root-relative paths, so a root path segment that happens to look like a junk dir isn't itself
    // skipped.
    expect(isWatchIgnored("/srv/dist/work", "/srv/dist/work/app/src/main.ts")).toBe(false);
    expect(isWatchIgnored("/srv/dist/work", "/srv/dist/work/app/node_modules/dep/index.js")).toBe(true);
});
