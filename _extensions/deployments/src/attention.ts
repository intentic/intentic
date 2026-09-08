import { type DeployOverviewResponse, DeployOverviewResponseSchema, DeploySeenResponseSchema, DEPLOYMENTS_BASE } from "./contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll, sandboxValue } from "@intentic/extension-api";
import { incidents, incidentTooltip, topTier, unseenIncidents } from "./incidents";
import { host } from "./host";

// Rail badge source: module state owned by activate(), not the view, so it updates even while nobody is looking at
// Deployments. Polled per connection, since a sandbox can hold multiple Komodo capabilities, each its own rail tile.
// Which connections exist isn't this module's concern: the host's detect() call hands each key straight to badge().

// Not a sandboxRef: written from inside the render computed, so a reactive ref here would self-loop.
const watched = sandboxValue<readonly string[]>(() => []);

// Accumulates onto `previous`: one unreachable Komodo must not clear another's last-known board.
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
                // Failed fetch: this connection keeps its last known board.
            }
        }
        return next;
    },
});

export { startDeployAttention };

// Called from detect(), the host's per-facts-poll callback; the only place that knows which Komodo capabilities are
// connected.
export const watchConnections = (capabilities: readonly string[]): void => {
    const added = capabilities.filter((capability) => !watched.value.includes(capability));
    watched.value = capabilities;
    // A newly connected Komodo should badge immediately, not after a full poll interval.
    if (added.length > 0) {
        refresh();
    }
};

// A deploy actually in progress, which is `deploying` alone: Komodo's `running` is a container that is UP, the resting
// state of a healthy board, and a mark lit by that would never go out. Not seen-gated like the incident count below —
// there is nothing to acknowledge, it clears itself when the deploy lands — and never suppressed by an incident, since
// "the fix is already going out" is exactly what the reader wants to know while looking at a red board.
const deployingNote = (board: DeployOverviewResponse): string | undefined => {
    const deploying = board.resources.filter((resource) => resource.state === `deploying`).length;
    return deploying === 0 ? undefined : `${deploying} deploying`;
};

// Unreachable gets a `warning` mark, never `danger`: a network blip reading as "production is down" would burn the
// rail's one truly urgent colour. Seen-gated like everything else, so it stops once the view has been opened.
export const deployBadge = (capability: string): ViewBadge | undefined => {
    const board = boards.value.get(capability);
    if (board === undefined) {
        return undefined;
    }
    if (!board.reachable) {
        // No running mark on this path: the last known board is a memory, and a deploy it remembers may well be over.
        return board.seenAt === undefined ? { mark: `exclamation-circle`, tone: `warning`, tooltip: `can't reach Komodo` } : undefined;
    }
    const running = deployingNote(board);
    const unseen = topTier(unseenIncidents(incidents(board.alerts), board.seenAt));
    if (unseen.length === 0) {
        return running === undefined ? undefined : { running };
    }
    return {
        count: unseen.length,
        tone: unseen[0]?.tone ?? `info`,
        tooltip: incidentTooltip(unseen),
        ...(running === undefined ? {} : { running }),
    };
};

// Stamps read state daemon-side and folds the answer into the local board, so the badge clears immediately instead of
// at the next poll.
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
        // Best-effort: a failed write only means the badge returns on the next poll.
    }
};
