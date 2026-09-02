import { liveTurnConversations } from "../agent/turn-runs.js";
import type { InvariantCheck } from "../invariants/invariants.js";
import { childLedger } from "./children.js";

/* THE LEDGER'S IDEA OF A RUNNING CHILD AND THE TURN PATH'S, WHICH MUST AGREE.
 *
 * A spawned child is an ordinary conversation (children.ts): its turn runs through turn-runs.ts like any
 * other, and that map is the one record of "is a turn live" the whole daemon shares. This subsystem keeps a
 * SECOND record, the child ledger, because a parent asks questions the turn map cannot answer: whose child is
 * this, may I steer it, has my budget been spent. `running` on the ledger flips when the pump that follows the
 * turn ends, which is a different thing from reading the turn, and the two can describe different worlds with
 * nothing to reconcile them.
 *
 * The direction checked is the one that spends: a turn that is live while its ledger entry reads settled is a
 * child the parent has been told is finished, whose report it has already read, and which goes on running
 * against the owner's allowance with nobody supervising it. That is what a pump that stopped following
 * (an error in its own reduction, say) leaves behind, and it is exactly the case that reads as "done" from
 * every surface the parent has. */

// The pump marks the ledger BEFORE it starts the run, so there is no honest window in this direction at all;
// the grace exists so a check can never be the thing that races a start, and is generous on purpose.
const LEDGER_GRACE_MS = 10_000;

export interface ChildLedgerDeps {
    // Overridden by tests; production reads the module ledgers.
    readonly children?: typeof childLedger;
    readonly live?: () => readonly { readonly conversationId: string; readonly startedAt: number }[];
    readonly now?: () => number;
}

export const owner = "children";

export const checks = ({ children = childLedger, live = liveTurnConversations, now = Date.now }: ChildLedgerDeps = {}): readonly InvariantCheck[] => [
    {
        name: "settled-children-have-no-live-turn",
        // The moments a child settles at, and the standing patrol. Not boot: the ledger is empty then, a daemon
        // death ends every turn it was tracking.
        on: ["sweep", "turn-settled"],
        run: ({ fail }) => {
            const settled = new Map(children().flatMap((kid) => (kid.running ? [] : [[kid.conversationId, kid.parent] as const])));
            const unsupervised = live()
                .filter((run) => settled.has(run.conversationId) && now() - run.startedAt > LEDGER_GRACE_MS)
                .map((run) => `${run.conversationId} (parent ${settled.get(run.conversationId)})`);
            if (unsupervised.length > 0) {
                fail(
                    `${unsupervised.length} spawned child turn(s) are live while their record reads settled (${unsupervised.join(", ")}): the parent was told they finished and they are still spending`,
                );
            }
        },
    },
];

/* DEFERRED: the mirror direction, a ledger entry running with no turn behind it, which parks the parent's
 * `wait` forever and keeps one of its `subagentsAtOnce` slots spent. It is not checked here because the pump
 * settles the ledger in a `finally` one tick AFTER the turn is marked done, and the turn path records no
 * moment at which that happened: at every `turn-settled` the two records legitimately disagree for that tick,
 * and a check reading it as a violation would fire on every child that ever finished. It needs a settled-at
 * stamp on the run (agent/turn-runs.ts), the same change agents/invariant.ts is waiting on. */
