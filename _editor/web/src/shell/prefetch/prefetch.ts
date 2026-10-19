import { useDevice } from "@intentic/ui";
import { type ViewLoader, viewLoaders } from "../../components/asyncView";

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

// Safari lacks requestIdleCallback; a timeout keeps the fallback off the critical path: the first one long enough for the
// mounting view's own requests, the ones between views a yield.
const IDLE_TIMEOUT_MS = 10_000;
const FIRST_FALLBACK_MS = 1_500;
const NEXT_FALLBACK_MS = 100;

const whenIdle = (fallbackMs: number): Promise<void> =>
    new Promise((resolve) => {
        if (`requestIdleCallback` in globalThis) {
            requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
        } else {
            setTimeout(resolve, fallbackMs);
        }
    });

// ONE VIEW PER IDLE MOMENT, not the whole table in one go. Each view's chunk is evaluated when it lands, and right after
// a reload the walk used to take the first idle moment and keep it: a dev server answered ~1,000 module requests for it
// in the seconds the reader was starting to work, and production evaluated chunk after chunk on the same thread their
// first presses ran on. Every view is still warmed, so a later navigation is as quick as before.
const walk = async (): Promise<void> => {
    let fallbackMs = FIRST_FALLBACK_MS;
    for (const { load } of prefetchOrder(viewLoaders, useDevice().mobile.value)) {
        await whenIdle(fallbackMs);
        fallbackMs = NEXT_FALLBACK_MS;
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
    void walk();
};
