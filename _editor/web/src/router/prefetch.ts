import { viewLoaders } from "../components/asyncView";

/* PULL THE VIEW CHUNKS WHILE NOBODY IS WAITING ON THEM. asyncView made navigation instant and put the download
 * behind an outline, this makes the download itself a non-event: once the shell is up and the browser is
 * idle, every registered view is fetched in the background, so the outline only ever appears on a genuinely
 * slow network or a first click that beats the idle callback.
 *
 * The second effect is the quieter win: a window whose chunks are already IN HAND cannot be stranded by a
 * redeploy. The stale-window recovery (staleChunk.ts) answers a dead chunk with a full page reload, the most
 * expensive navigation the app has, and prefetching is what makes that path rare instead of routine for
 * long-lived windows.
 *
 * SEQUENTIAL, not Promise.all: this is background work, and a dozen parallel fetches on a cold start would
 * compete with the requests the user's actual view is making. Registration order (the route table's own) is
 * the priority order, good enough, since the whole walk finishes in seconds and any click mid-walk starts
 * that view's fetch immediately through the same shared loader (asyncView dedupes; nothing is fetched twice).
 * Failures are swallowed: a background fetch that fails has cost nothing, and the click path has its own
 * recovery. */

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
    // Once per window, the shell remounts on breakpoint crossings and the walk must not restart with it.
    if (started) {
        return;
    }
    started = true;
    // Safari still has no requestIdleCallback; a beat of setTimeout keeps the fallback off the critical path.
    if (typeof requestIdleCallback === `function`) {
        requestIdleCallback(() => void walk(), { timeout: 10_000 });
    } else {
        setTimeout(() => void walk(), 1_500);
    }
};
