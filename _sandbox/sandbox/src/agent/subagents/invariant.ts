import { liveTurnConversations } from "../run/turn/turn-runs.js";
import type { InvariantCheck } from "../../invariants/invariants.js";
import { childLedger } from "./children.js";

// Checks that the child ledger's `running` and the turn-runs map agree. The dangerous direction is turn live plus
// ledger settled: a child that reads as finished everywhere but keeps spending against the owner's allowance
// unsupervised.

// The ledger is marked before the run starts, so grace only guards a check racing that start; kept generous.
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
        // Checked at settle and the standing patrol, not boot: the ledger is empty then, a daemon death ends every
        // turn.
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

// Deferred: the mirror direction (ledger running, no turn) isn't checked, since the ledger settles one tick after the
// turn, and every settle would falsely disagree. Needs a settled-at stamp on the run first.
