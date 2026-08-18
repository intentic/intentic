import { type CiRunsResponse, CiSeenResponseSchema } from "@intentic/sandbox-contract";
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { failureStreaks, streakTooltip, unseenStreaks } from "./ciStreaks";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

/* The rail badge's source. Module state owned by activate(), NOT by the view: a badge that only updates while
 * you are already looking at Pipelines would never tell you anything you didn't know.
 *
 * That rules out the view's observer — it stops when the component unmounts — so this keeps its own timer. The
 * timer reads THROUGH the host's vue-query cache, though: the latest badge poll is therefore also the board's
 * first paint, and concurrent reads coalesce instead of opening a second request beside it.
 */

// Slow on purpose. This drives a glance, not a screen: a breakage that surfaces within the minute is timely,
// and the view's own polling is what serves someone actually watching.
const POLL_MS = 60_000;

// Scoped to the sandbox these runs came from: CI belongs to one workspace's repositories, and a red streak
// carried over a switch badges this box for a break in another one.
const runs = sandboxRef<CiRunsResponse>(() => ({ repos: [], runs: [] }));

// Nothing in here may reject: it runs detached on a timer, where a throw becomes an unhandled rejection with
// no one to catch it. That includes reading the host handle — an api shape without a sandbox transport (a test
// harness, a partially wired host) must leave the badge alone, not take the process down with it.
const refresh = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        // Taken before the read, asked after it: an answer for the box the user has just left must not become
        // this box's badge.
        const current = sandboxScopeGuard();
        const next = await api.sandbox.fetch(ciRunsQuery());
        if (!current()) {
            return;
        }
        runs.value = next;
    } catch {
        // A refused or unreachable daemon leaves the last known state standing rather than blanking the badge:
        // "we can't reach CI" is not "CI is fine", and a flapping tile is worse than a slightly stale one.
    }
};

// Started by activate() so the badge is live from login, and disposed with the extension.
export const startCiAttention = (): Disposable => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return { dispose: () => clearInterval(timer) };
};

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
