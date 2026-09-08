import { liveTurnConversations } from "../agent/run/turn/turn-runs.js";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { AgentsRegistry } from "./registry/agents-registry.js";

// Two independent records of whether a conversation is running (turn-runs.ts's live-run map, the registry's own
// `running` map) that must agree. Checks only registry-idle-while-turn-live, the direction a live run's own start time
// can verify.

// Long enough that no ordinary begin is still in flight; short enough to catch a stuck card within one sweep.
const REGISTRY_GRACE_MS = 10_000;

export interface FleetRegistryDeps {
    readonly agents: AgentsRegistry;
    readonly live?: () => readonly { readonly conversationId: string; readonly startedAt: number }[];
    readonly now?: () => number;
}

export const owner = "agents";

export const checks = ({ agents, live = liveTurnConversations, now = Date.now }: FleetRegistryDeps): readonly InvariantCheck[] => [
    {
        name: "live-turns-are-running-on-the-board",
        on: ["sweep", "turn-settled"],
        run: ({ fail }) => {
            const due = live().filter((run) => now() - run.startedAt > REGISTRY_GRACE_MS);
            const known = new Set(agents.ids());
            const unknown = due.filter((run) => !known.has(run.conversationId)).map((run) => run.conversationId);
            if (unknown.length > 0) {
                return fail(`${unknown.length} live turn(s) belong to conversations the fleet registry has no entry for: ${unknown.join(", ")}`);
            }
            const idle = due.filter((run) => !agents.running(run.conversationId)).map((run) => run.conversationId);
            if (idle.length > 0) {
                fail(
                    `${idle.length} live turn(s) read as not running on the fleet board, the card shows idle while the turn spends: ${idle.join(", ")}`,
                );
            }
        },
    },
];

// Deferred: the mirror direction, a registry `running` with no live turn, isn't checked, since the registry keeps no
// timestamp of when it started, so a mismatch can't be told from a turn one tick from registering.
