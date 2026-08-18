import type { ViewBadge } from "@intentic/extension-api";
import { sandboxLedger, sandboxPoll } from "@intentic/extension-api";
import { host } from "./host.js";
import { SEEN_PATH, stagingKey } from "./paths.js";
import { listStagedTails } from "./stagedTree.js";

/* THE RAIL BADGE, and the one thing it is deliberately NOT.
 *
 * It is not a coverage count. "38 packages undocumented" would be lit every day for months, and the extension API
 * is explicit about why that is a bug rather than information: a badge "must mean something happened here that you
 * don't already know about, never here is a statistic", because a tile that is always lit teaches the eye to stop
 * seeing the rail. Staleness is the same shape — in an active repo something is always drifting — so it lives
 * inside the view, as a number next to the thing it describes.
 *
 * What it counts instead is a document set that has been GENERATED AND NOT YET REVIEWED: a run finished, drafts are
 * sitting in staging, and nobody has looked. That is an event, it is addressed to the person seeing it, and it
 * clears by acting — reviewing, publishing or discarding — rather than by waiting. */

/* A PRESENCE LEDGER, unlike Maintenance's: what matters is whether this repo's staged set has been looked at at
 * all, not whether its contents have moved since. So the mark is never compared — it records WHEN, which nothing
 * reads and a human opening the file is glad of. */
const seen = sandboxLedger(host, SEEN_PATH);

/* Repos whose staged set is present and unacknowledged, kept current while the view is closed (background.ts) —
 * a badge that only updated while you were already looking at Documentation could never tell you anything you
 * did not know.
 *
 * Sandbox-scoped, and here that is not merely tidiness: repo names repeat across workspaces, so carrying this
 * over a switch would not show a stale number, it would name repositories that exist in the new box too and say
 * something untrue about them.
 *
 * Slow on purpose. This drives a glance; the view's own reads serve anyone actually watching a run. */
const { state: pending, start: startDocumentationAttention } = sandboxPoll<readonly string[]>({
    host,
    everyMs: 60_000,
    initial: () => [],
    read: async (api) => {
        const acknowledged = await seen.read();
        const staged = await Promise.all(
            api.workspace.repos().map(async ({ repo }) => {
                const tails = await listStagedTails(api, repo);
                // A `repo.json` is the marker that a set is worth reviewing: a run that has only just started has
                // a run manifest but no map yet, and lighting the rail for that would badge the user's own click
                // back at them.
                return tails.includes(`repo.json`) && acknowledged[stagingKey(repo)] === undefined ? repo : undefined;
            }),
        );
        return staged.filter((repo): repo is string => repo !== undefined);
    },
});

export { startDocumentationAttention };

export const documentationBadge = (): ViewBadge | undefined => {
    const count = pending.value.length;
    if (count === 0) {
        return undefined;
    }
    return {
        count,
        // `info` is the resting tone every core count uses. Nothing is broken and nothing is at risk — there is
        // reading waiting, which is the mildest possible claim on attention.
        tone: `info`,
        tooltip: `${count} repositor${count === 1 ? `y has` : `ies have`} newly generated documentation waiting to be reviewed`,
    };
};

/* Acknowledge a repo's staged set — called when the owner actually opens it. Written to a file rather than held in
 * memory or in an extension setting: the badge is derived from files, so its acknowledgement belongs in the same
 * tree, where it survives a reload and is shared across the owner's browsers without adding a setting no user
 * would ever type. */
export const acknowledgeStaged = async (repo: string): Promise<void> => {
    const key = stagingKey(repo);
    pending.value = pending.value.filter((entry) => entry !== repo);
    /* Only the FIRST look writes. The view calls this on every open, and a mark that is a fresh timestamp each
     * time would rewrite the file every time — which the daemon pushes to every connected browser as a change,
     * costing them all a refetch for a fact that did not move. Presence is the signal; the time is a courtesy to
     * whoever reads the file. */
    if ((await seen.read())[key] === undefined) {
        await seen.mark({ [key]: new Date().toISOString() });
    }
};
