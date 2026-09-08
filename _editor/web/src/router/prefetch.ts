import { viewLoaders } from "../components/asyncView";

// Fetches every registered view chunk in the background once the shell is idle, so a redeploy's
// stale-chunk reload (staleChunk.ts) stays rare. Sequential, not parallel: background work must not
// compete with the current view's own requests. Failures are swallowed; the click path recovers its own.

let started = false;

const walk = async (): Promise<void> => {
    for (const load of viewLoaders) {
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
