import { STATE_DIR } from "@intentic/constants";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { afterEach, expect, test, vi } from "vitest";
import { createPathBatcher, DEBOUNCE_MS, isWatchIgnored, MAX_PATHS, watchIgnoreGlobs } from "./workspace-watch.js";

/* The coalescing rule on its own clock. Its sibling .integration.test.ts drives the real watcher over a real
 * temp tree, which can say that a change is announced and that node_modules never is — but it cannot say how
 * many batches a burst became, because that answer depends on whether the runner delivered two filesystem
 * events inside the same 250ms window. Everything about the batching itself is decided here, where the timers
 * are the test's. */

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
    // A single write arrives as create-then-update often enough that this is the common case, not an edge.
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

/* THE TWO HALVES OF EVERY SKIP RULE, PINNED TO EACH OTHER. The watcher skips a path twice over: a glob keeps
 * the native backend from ever descending into the directory, and the predicate vets whatever still arrives.
 * Both halves are declared on one line per rule so they cannot drift — and these tests are what make that
 * structural intent enforceable, by failing if a rule ever grows one half without the other.
 *
 * Asserted through the two exported functions rather than the rule table behind them: the table is an
 * implementation detail, and a test that reaches for it would keep passing after a refactor that broke what
 * callers actually see. That a glob genuinely PRUNES (rather than merely appearing in the list) is a question
 * only a real filesystem answers, so it lives in the sibling .integration.test.ts. */

test("every skip glob covers both the directory itself and its subtree", () => {
    const globs = watchIgnoreGlobs();
    // A glob matching only `**/node_modules/**` would still let the directory ITSELF be reported; one matching
    // only `**/node_modules` would let everything inside through. Both forms, always.
    const bare = globs.filter((glob) => !glob.endsWith("/**"));
    expect(bare).not.toHaveLength(0);
    for (const glob of bare) {
        expect(globs).toContain(`${glob}/**`);
    }
    expect(globs).toHaveLength(bare.length * 2);
});

test("the junk-dir globs are generated from the shared list, not restated", () => {
    const globs = watchIgnoreGlobs();
    // The point of generating them: a dir added to IGNORED_DIRS (so the tree grays it) is descent-skipped too,
    // with nobody having to remember this file exists.
    for (const dir of IGNORED_DIRS) {
        expect(globs).toContain(`**/${dir}`);
    }
});

test("each skip rule still silences the path it exists for", () => {
    // One representative path per rule, so deleting a rule fails here rather than silently costing handles on a
    // big checkout. Their glob counterparts are proven to prune in the integration suite.
    const root = "/work";
    for (const relPath of [
        "app/node_modules/dep/index.js",
        `${STATE_DIR}/browser/reddit/Default/Cookies`,
        "app/.claude/worktrees/fix/src/main.ts",
        "refs/react/packages/scheduler/index.js",
        `${STATE_DIR}/sessions/claude/projects/-work/session.jsonl`,
    ]) {
        expect(isWatchIgnored(root, `${root}/${relPath}`)).toBe(true);
    }
});

test("the skip rules are indifferent to what the workspace root is called", () => {
    // The rules read root-RELATIVE paths, so a checkout that happens to live under a directory named like a junk
    // dir stays fully watched. Matching absolute segments used to mean a root such as /srv/dist/work silenced
    // the entire workspace.
    expect(isWatchIgnored("/srv/dist/work", "/srv/dist/work/app/src/main.ts")).toBe(false);
    expect(isWatchIgnored("/srv/dist/work", "/srv/dist/work/app/node_modules/dep/index.js")).toBe(true);
});
