import { type DeployOverviewResponse, DeployOverviewResponseSchema, DeploySeenResponseSchema, DEPLOYMENTS_BASE } from "./contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll, sandboxRef } from "@intentic/extension-api";
import { incidents, incidentTooltip, topTier, unseenIncidents } from "./incidents";
import { host } from "./host";

/* The rail badge's source. Module state owned by activate(), NOT by the view: a badge that only updated while
 * you were already looking at Deployments could never tell you anything you did not know (background.ts).
 *
 * Polled PER CONNECTION, because a sandbox can hold two Komodo capabilities and each is its own rail tile.
 * Which connections exist is not this module's question: the host calls detect() on every facts poll and hands
 * each activation's key straight back to badge(), so this only has to keep a map and fill it. */

// Which capabilities to poll. Written by detect() on every facts poll, so a connection added or removed in
// /capabilities starts or stops being watched without a reload. Sandbox-scoped and so emptied on a switch: a
// Komodo capability belongs to the box it is configured in, so the first poll after a switch has to ask about
// this box's connections rather than the last box's.
const watched = sandboxRef<readonly string[]>(() => []);

/* Slow on purpose, the ciAttention budget. This drives a glance, not a screen: a breakage that surfaces within
 * the minute is timely, and the view's own faster polling is what serves someone actually watching.
 *
 * NO OPENING READ (`immediate: false`), unlike every other badge here: at activation this knows of no
 * connections, so the first read would be a round of nothing. `watchConnections` below is what starts it, at
 * the moment there is something to ask.
 *
 * The round ACCUMULATES onto what it already holds, which is why it takes `previous`: one unreachable Komodo
 * must leave the others' boards standing, and its OWN last known board too. A flapping tile is worse than a
 * slightly stale one, and "we could not ask" is not "nothing is wrong". */
const {
    state: boards,
    start: startDeployAttention,
    refresh,
} = sandboxPoll({
    host,
    everyMs: 60_000,
    immediate: false,
    initial: () => new Map<string, DeployOverviewResponse>(),
    read: async (api, previous) => {
        const next = new Map(previous);
        for (const capability of watched.value) {
            try {
                next.set(capability, DeployOverviewResponseSchema.parse(await api.sandbox.json(`${DEPLOYMENTS_BASE}/komodo/${capability}/overview`)));
            } catch {
                // See above: this connection keeps whatever board it had.
            }
        }
        return next;
    },
});

export { startDeployAttention };

// Called from detect() — the host's own per-facts-poll callback, which is the only place that knows which
// Komodo capabilities are currently connected.
export const watchConnections = (capabilities: readonly string[]): void => {
    const added = capabilities.filter((capability) => !watched.value.includes(capability));
    watched.value = capabilities;
    // A newly connected Komodo should badge on its first render, not a minute later.
    if (added.length > 0) {
        refresh();
    }
};

/* What the tile says. Read inside the host's render computed — touching `boards` here is what repaints it.
 *
 * UNREACHABLE IS NOT BROKEN. A Komodo we cannot talk to gets a `warning` mark and no count: one fact, one
 * click, and the amount goes in the tooltip (the ViewBadge.mark case). It is emphatically not `danger` —
 * reading a network blip as "production is down" is how a rail earns its colour back into meaninglessness,
 * and the whole value of `danger` here is that only one other tile in the app claims it.
 *
 * It is still SEEN-GATED like everything else: once you have opened the view and read "cannot reach Komodo",
 * you know, and the rail stops saying it. */
export const deployBadge = (capability: string): ViewBadge | undefined => {
    const board = boards.value.get(capability);
    if (board === undefined) {
        return undefined;
    }
    if (!board.reachable) {
        return board.seenAt === undefined ? { mark: `exclamation-circle`, tone: `warning`, tooltip: `can't reach Komodo` } : undefined;
    }
    const unseen = topTier(unseenIncidents(incidents(board.alerts), board.seenAt));
    if (unseen.length === 0) {
        return undefined;
    }
    return { count: unseen.length, tone: unseen[0]?.tone ?? `info`, tooltip: incidentTooltip(unseen) };
};

// Called when a connection's view is opened. Stamps read state daemon-side and folds the answer straight into
// the local board, so the badge clears on the spot instead of at the next poll.
export const markDeploymentsSeen = async (capability: string): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        const { seenAt } = DeploySeenResponseSchema.parse(
            await api.sandbox.json(`${DEPLOYMENTS_BASE}/komodo/${capability}/seen`, { method: `POST` }),
        );
        const board = boards.value.get(capability);
        if (board !== undefined) {
            boards.value = new Map(boards.value).set(capability, { ...board, seenAt });
        }
    } catch {
        // Best-effort, like markPipelinesSeen: a failed write only means the badge returns on the next poll,
        // a far smaller harm than an error surfacing for background bookkeeping.
    }
};
