import { liveTurnConversations } from "../agent/turn-runs.js";
import type { InvariantCheck } from "../invariants/invariants.js";
import type { AgentsRegistry } from "./agents-registry.js";

/* TWO RECORDS OF "IS THIS CONVERSATION RUNNING", AND THEY MUST AGREE.
 *
 * The turn path keeps one (turn-runs.ts's map of live runs) and the fleet registry keeps another (its own runtime
 * map, behind `running`). Neither is derived from the other: the turn path CALLS the registry at begin and finish,
 * which is a different thing from reading it, and a call that does not happen leaves the two describing different
 * worlds with nothing to reconcile them.
 *
 * The user sees the registry. So the failure that matters is the registry reading idle while a turn is live: the
 * board shows a conversation at rest while it spends the owner's allowance, the reaper's `ownerLive` test, which
 * asks the TURN side, keeps its processes alive, and every surface that decides what to offer from `running`
 * offers the wrong thing. It is also the direction that can be checked honestly, because the live run knows when
 * it started and the grace below can tell "not begun yet" from "never begun".
 */

// Long enough that no ordinary begin is still in flight, short enough that a stuck card is caught within a sweep.
// The same reasoning as the journal's grace: the failure being looked for is permanent, never slow.
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
                    `${idle.length} live turn(s) read as not running on the fleet board — the card shows idle while the turn spends: ${idle.join(", ")}`,
                );
            }
        },
    },
];

/* DEFERRED: the mirror direction, the registry holding `running` for a conversation with no live turn, which is
 * the card that spins forever. It is not checked here because the registry records no moment at which it marked a
 * conversation running, so a mismatch cannot be told apart from a turn that is one tick from registering. The
 * registry's runtime state would have to carry that stamp; that is a change to the registry, not to its diagnostics. */
