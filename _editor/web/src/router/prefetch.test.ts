// @vitest-environment jsdom
//
// The background half of "navigation never waits": once invoked, the prefetcher walks every view registered
// through asyncView and pulls its chunk: through the SAME loader the wrapper uses, so nothing is ever fetched
// twice, and it walks once per window no matter how often the shell remounts. A failing chunk costs the walk
// nothing: the views after it still arrive.
import { expect, it, vi } from "vitest";
import { h } from "vue";
import { asyncView } from "../components/asyncView";
import { prefetchViewsAtIdle } from "./prefetch";

it(`pulls every registered view once, at idle, and survives a loader that fails`, async () => {
    vi.useFakeTimers();
    const first = vi.fn(() => Promise.resolve({ default: { render: () => h(`div`) } }));
    const failing = vi.fn(() => Promise.reject(new Error(`offline`)));
    const last = vi.fn(() => Promise.resolve({ default: { render: () => h(`div`) } }));
    asyncView(first);
    asyncView(failing);
    asyncView(last);

    prefetchViewsAtIdle();
    // Nothing before idle: the walk must not compete with whatever the mounting view is fetching.
    expect(first).not.toHaveBeenCalled();

    // jsdom has no requestIdleCallback, so the setTimeout fallback is the scheduled path.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    // The failure above did not end the walk.
    expect(last).toHaveBeenCalledTimes(1);

    // A shell remount calls again; the walk is once per window and the loaders stay fetched-once.
    prefetchViewsAtIdle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
});
