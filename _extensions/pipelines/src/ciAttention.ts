import { type CiRunsResponse, CiSeenResponseSchema } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { failureStreaks, streakTooltip, unseenStreaks } from "./ciStreaks";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

/* The rail badge's source. Module state owned by activate(), NOT by the view: a badge that only updates while
 * you are already looking at Pipelines would never tell you anything you didn't know — which is what the
 * background poll is for (background.ts holds the five rules such a poll has to obey).
 *
 * It reads THROUGH the host's vue-query cache: the latest badge poll is therefore also the board's first paint,
 * and concurrent reads coalesce instead of opening a second request beside it.
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

// Read inside the host's render computed — touching `runs` here is what repaints the tile.
export const ciBadge = (): ViewBadge | undefined => {
    const unseen = unseenStreaks(failureStreaks(runs.value.runs), runs.value.seenAt);
    if (unseen.length === 0) {
        return undefined;
    }
    // The rail's only `danger`: everything else there counts things waiting for you, this one says something
    // is broken. It is worth the distinct colour precisely because nothing else claims it.
    return { count: unseen.length, tone: `danger`, tooltip: streakTooltip(unseen) };
};

// Called when the view is opened. Stamps read state daemon-side and folds the answer straight into the local
// copy, so the badge clears on the spot instead of at the next poll.
export const markPipelinesSeen = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        const { seenAt } = CiSeenResponseSchema.parse(await api.sandbox.json(`/ci/seen`, { method: `POST` }));
        runs.value = { ...runs.value, seenAt };
    } catch {
        // Best-effort, like the agents board's markSeen: a failed write only means the badge returns on the
        // next poll, which is a far smaller harm than an error surfacing for a background bookkeeping call.
    }
};
