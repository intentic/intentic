import { HISTORY_ROOT } from "@intentic/constants";
import { createCheckoutFollow, type DirWatchEvents, type WatchDir } from "./checkout-follow.js";

// The follow registry's rules on its own clock and a stand-in for the platform's watch: how long a lease holds, that a
// folder is watched once whoever asks, how a burst becomes one frame, the cap, and what is never told. The real
// inotify watch is checkout-follow.integration.test.ts.

const ROOT = `${HISTORY_ROOT}/worktrees/c-1`;

// Every folder watched, by absolute path, with what it can report and whether it was stopped.
const fakeWatches = () => {
    const live = new Map<string, DirWatchEvents>();
    const started: string[] = [];
    const watchDir: WatchDir = (abs, events) => {
        if (abs.endsWith("/missing")) {
            throw new Error("ENOENT");
        }
        started.push(abs);
        live.set(abs, events);
        return () => live.delete(abs);
    };
    return { live, started, watchDir };
};

const setup = (options: { maxDirs?: number } = {}) => {
    const watches = fakeWatches();
    const follow = createCheckoutFollow({ leaseMs: 1000, debounceMs: 100, watchDir: watches.watchDir, ...options });
    const frames: { agent: string; paths: string[] }[] = [];
    follow.subscribe((agent, paths) => frames.push({ agent, paths }));
    return { ...watches, follow, frames };
};

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

test("a followed folder is watched for one lease, and let go when nobody renews it", () => {
    const { follow, live } = setup();
    expect(follow.follow("c-1", ROOT, ["docs"])).toBe(1000);
    expect([...live.keys()]).toEqual([`${ROOT}/docs`]);
    jest.advanceTimersByTime(999);
    expect(follow.watched()).toBe(1);
    jest.advanceTimersByTime(1);
    expect(follow.watched()).toBe(0);
    expect(live.size).toBe(0);
});

test("a renewal extends the lease rather than starting a second watch", () => {
    const { follow, started } = setup();
    follow.follow("c-1", ROOT, ["docs"]);
    jest.advanceTimersByTime(800);
    // A second reader of the same folder, or the first renewing: the same one watch, held for another lease.
    follow.follow("c-1", ROOT, ["docs", "docs"]);
    jest.advanceTimersByTime(800);
    expect(follow.watched()).toBe(1);
    expect(started).toEqual([`${ROOT}/docs`]);
    jest.advanceTimersByTime(200);
    expect(follow.watched()).toBe(0);
});

test("changes inside one window go out as one frame per conversation, each path once", () => {
    const { follow, live, frames } = setup();
    follow.follow("c-1", ROOT, ["docs", ""]);
    follow.follow("c-2", `${HISTORY_ROOT}/worktrees/c-2`, ["notes"]);
    live.get(`${ROOT}/docs`)?.changed("a.md");
    live.get(`${ROOT}/docs`)?.changed("a.md");
    live.get(ROOT)?.changed("README.md");
    live.get(`${HISTORY_ROOT}/worktrees/c-2/notes`)?.changed("b.md");
    jest.advanceTimersByTime(99);
    expect(frames).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(frames).toEqual([
        { agent: "c-1", paths: ["docs/a.md", "README.md"] },
        { agent: "c-2", paths: ["notes/b.md"] },
    ]);
});

test("a nameless change stands for its folder, and the checkout's own root names nothing", () => {
    const { follow, live, frames } = setup();
    follow.follow("c-1", ROOT, ["docs", ""]);
    live.get(`${ROOT}/docs`)?.changed(undefined);
    live.get(ROOT)?.changed(undefined);
    jest.advanceTimersByTime(100);
    expect(frames).toEqual([{ agent: "c-1", paths: ["docs"] }]);
});

test("what the shared watcher never tells is not told from a checkout either", () => {
    const { follow, live, frames } = setup();
    follow.follow("c-1", ROOT, ["app"]);
    live.get(`${ROOT}/app`)?.changed("node_modules");
    jest.advanceTimersByTime(100);
    expect(frames).toEqual([]);
});

test("past the cap a new folder is refused, and the ones already watched keep their watch", () => {
    const { follow, live } = setup({ maxDirs: 2 });
    follow.follow("c-1", ROOT, ["a", "b", "c"]);
    expect([...live.keys()]).toEqual([`${ROOT}/a`, `${ROOT}/b`]);
    // Room again once a lease lapses.
    jest.advanceTimersByTime(1000);
    follow.follow("c-1", ROOT, ["c"]);
    expect([...live.keys()]).toEqual([`${ROOT}/c`]);
});

test("a folder that cannot be watched is skipped, and one whose watch ends is let go", () => {
    const { follow, live, frames } = setup();
    follow.follow("c-1", ROOT, ["missing", "docs"]);
    expect(follow.watched()).toBe(1);
    const events = live.get(`${ROOT}/docs`);
    events?.ended();
    expect(follow.watched()).toBe(0);
    // Whatever a dead watch still says afterwards is not told.
    events?.changed("late.md");
    jest.advanceTimersByTime(100);
    expect(frames).toEqual([]);
});

test("closing lets every folder go and announces nothing more", () => {
    const { follow, live, frames } = setup();
    follow.follow("c-1", ROOT, ["docs"]);
    live.get(`${ROOT}/docs`)?.changed("a.md");
    follow.close();
    jest.advanceTimersByTime(1000);
    expect(live.size).toBe(0);
    expect(frames).toEqual([]);
});
