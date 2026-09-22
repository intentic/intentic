// Background half of 'navigation never waits': walks every view registered through asyncView and pulls its chunk via
// the same loader, once per window no matter how often the shell remounts. A failing chunk does not stop the rest.
import "@intentic/testing/dom";
import { it, expect, mock, jest } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { h } from "vue";
import { asyncView } from "../components/asyncView";
import { prefetchViewsAtIdle } from "./prefetch";

it(`pulls every registered view once, at idle, and survives a loader that fails`, async () => {
    jest.useFakeTimers();
    const first = mock(() => Promise.resolve({ default: { render: () => h(`div`) } }));
    const failing = mock(() => Promise.reject(new Error(`offline`)));
    const last = mock(() => Promise.resolve({ default: { render: () => h(`div`) } }));
    asyncView(first);
    asyncView(failing);
    asyncView(last);

    prefetchViewsAtIdle();
    // Nothing before idle: the walk must not compete with whatever the mounting view is fetching.
    expect(first).not.toHaveBeenCalled();

    // jsdom has no requestIdleCallback, so the setTimeout fallback is the scheduled path.
    await advanceTimersByTimeAsync(2_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);

    // A shell remount calls again; the walk is once per window and the loaders stay fetched-once.
    prefetchViewsAtIdle();
    await advanceTimersByTimeAsync(2_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
});
