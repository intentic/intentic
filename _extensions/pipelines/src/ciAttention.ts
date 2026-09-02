import type { CiRunsResponse } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { failureStreaks, streakTooltip } from "./ciStreaks";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

/* The rail badge's source. Module state owned by activate(), NOT by the view: a badge that only updates while
 * you are already looking at Pipelines would never tell you anything you didn't know, which is what the
 * background poll is for (background.ts holds the five rules such a poll has to obey).
 *
 * It reads THROUGH the host's vue-query cache: the latest badge poll is therefore also the board's first paint,
 * and concurrent reads coalesce instead of opening a second request beside it.
 *
 * A TIMER BECAUSE THERE IS NOTHING TO PUSH. Every other badge in the workspace derives from workspace files and
 * so wakes on the write (background.ts); this one's subject is a CI provider's API, which nothing local observes,
 * so an interval is the whole feed rather than a backstop. Declaring a file binding here would be a declaration
 * over nothing.
 *
 * Slow on purpose. This drives a glance, not a screen: a breakage that surfaces within the minute is timely,
 * and the view's own polling is what serves someone actually watching. */
const { state: runs, start: startCiAttention } = sandboxPoll<CiRunsResponse>({
    host,
    everyMs: 60_000,
    initial: () => ({ repos: [], runs: [] }),
    read: async (api) => api.sandbox.fetch(ciRunsQuery()),
});

// Started by activate() so the badge is live from login, and disposed with the extension.
export { startCiAttention };

/* Read inside the host's render computed, touching `runs` here is what repaints the tile.
 *
 * BROKEN BRANCHES, and it stays lit for as long as they are broken. There is no read marker: opening the view
 * is not a fix, and a rail that goes quiet on a glance leaves the one surface that could say "main is still
 * red" saying nothing for the rest of the day. It clears when CI does, a later commit that passes (ciStreaks
 * has the full argument, and the shape that keeps the number from becoming noise). */
export const ciBadge = (): ViewBadge | undefined => {
    const streaks = failureStreaks(runs.value.runs);
    if (streaks.length === 0) {
        return undefined;
    }
    // The rail's only `danger`: everything else there counts things waiting for you, this one says something
    // is broken. It is worth the distinct colour precisely because nothing else claims it.
    return { count: streaks.length, tone: `danger`, tooltip: streakTooltip(streaks) };
};
