import { useDevice } from "@intentic/ui";
import { type ViewLoader, viewLoaders } from "../components/asyncView";

// Fetches every registered view chunk in the background once the shell is idle, so a redeploy's
// stale-chunk reload (staleChunk.ts) stays rare. Sequential, not parallel: background work must not
// compete with the current view's own requests. Failures are swallowed; the click path recovers its own.

let started = false;

// The walk's order: route order on a desktop. A phone takes the views its next tap opens first (an agent's page, the
// menu) and never the ones it cannot draw (asyncView's `mobile`): each is a chunk fetched over a phone's connection and
// then evaluated on its CPU, and the walk ran the whole table, preview and full-screen chat included, before the page
// a card opens.
export const prefetchOrder = (loaders: readonly ViewLoader[], mobile: boolean): readonly ViewLoader[] =>
    mobile
        ? [...loaders.filter((loader) => loader.mobile === `first`), ...loaders.filter((loader) => loader.mobile === undefined)]
        : loaders;

const walk = async (): Promise<void> => {
    for (const { load } of prefetchOrder(viewLoaders, useDevice().mobile.value)) {
        try {
            await load();
        } catch {
            // Background work; the click path surfaces and recovers its own failures.
        }
    }
};

export const prefetchViewsAtIdle = (): void => {
    // The shell remounts on breakpoint crossings; the walk must not restart with it.
    if (started) {
        return;
    }
    started = true;
    // Safari lacks requestIdleCallback; setTimeout keeps the fallback off the critical path.
    if (typeof requestIdleCallback === `function`) {
        requestIdleCallback(() => void walk(), { timeout: 10_000 });
    } else {
        setTimeout(() => void walk(), 1_500);
    }
};
