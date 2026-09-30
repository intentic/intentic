// Background half of 'navigation never waits': walks every view registered through asyncView and pulls its chunk via
// the same loader, once per window no matter how often the shell remounts. A failing chunk does not stop the rest.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { h } from "vue";
import { asyncView, type ViewLoader } from "../components/asyncView";
import { prefetchOrder, prefetchViewsAtIdle } from "./prefetch";

it(`pulls every registered view once, at idle, and survives a loader that fails`, async () => {
    jest.useFakeTimers();
    const first = jest.fn(() => Promise.resolve({ default: { render: () => h(`div`) } }));
    const failing = jest.fn(() => Promise.reject(new Error(`offline`)));
    const last = jest.fn(() => Promise.resolve({ default: { render: () => h(`div`) } }));
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

// A phone walks where its next tap goes first and never fetches a view it cannot draw; a desktop keeps route order.
it(`orders a phone's walk by what its next tap opens and drops what it cannot draw`, () => {
    const load = (): Promise<void> => Promise.resolve();
    const loaders: ViewLoader[] = [{ load }, { load, mobile: `skip` }, { load }, { load, mobile: `first` }, { load, mobile: `first` }];
    const names = (order: readonly ViewLoader[]): number[] => order.map((loader) => loaders.indexOf(loader));

    expect(names(prefetchOrder(loaders, true))).toEqual([3, 4, 0, 2]);
    expect(names(prefetchOrder(loaders, false))).toEqual([0, 1, 2, 3, 4]);
});
