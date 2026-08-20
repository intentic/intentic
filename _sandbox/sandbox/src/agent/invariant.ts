import type { InvariantCheck } from "../invariants/invariants.js";
import type { TurnJournal } from "./turn-journal.js";
import { liveTurnConversations } from "./turn-runs.js";

/* EVERY LIVE TURN IS WRITTEN DOWN — or it dies with the container and nobody finds out until it has.
 *
 * The journal exists because intentic's own flows kill turns: every update, every environment approval and every
 * dev swap recreates the container. A turn in the journal comes back; a turn that is not simply ends, mid-answer,
 * with the fleet card reading `interrupted` and forty minutes of work gone.
 *
 * The write is deliberately best-effort — turn-runs.ts states the trade in as many words: "A journal write that
 * fails changes nothing else: the turn is the thing that matters, and the cost is one turn that will not come
 * back from a restart." That trade is right. Its SILENCE is not: the failure is swallowed, nothing re-reads the
 * directory, and the bill arrives at a restart days later looking like an unrelated bug.
 *
 * So the promise is checked from the other side. The journal directory and the live-run map are two independent
 * records of one fact, and a disagreement between them is exactly the window in which a container recreate
 * silently costs a user their run.
 */

/* How long a turn may be live before its entry is expected on disk. The write is queued behind at most a couple
 * of others and is one small file, so this is generous by orders of magnitude on purpose: the failure being
 * looked for is permanent (a write that threw and was swallowed), never slow, and a check that races the thing
 * it observes teaches everyone to ignore it. */
const JOURNAL_GRACE_MS = 10_000;

export interface TurnJournalDeps {
    readonly turnJournal: TurnJournal;
    // Overridden by tests; production reads the process's own live-run map.
    readonly live?: () => readonly { readonly conversationId: string; readonly startedAt: number }[];
    readonly now?: () => number;
}

export const owner = "agent";

export const checks = ({ turnJournal, live = liveTurnConversations, now = Date.now }: TurnJournalDeps): readonly InvariantCheck[] => [
    {
        name: "live-turns-are-journalled",
        /* Not `boot`: at boot the journal holds the PREVIOUS life's turns and the live map is empty, which is
         * the entire point of it — the two disagreeing there is correct, not broken. `turn-settled` as well as
         * the sweep, because a turn ending is the moment the OTHER live turns' entries matter most: it is when
         * a container recreate is most likely to be seconds away (an update, an approval, a swap). */
        on: ["sweep", "turn-settled"],
        run: async ({ fail }) => {
            const due = live().filter((run) => now() - run.startedAt > JOURNAL_GRACE_MS);
            if (due.length === 0) {
                return;
            }
            const journalled = new Set((await turnJournal.list()).flatMap((entry) => (entry.kind === "turn" ? [entry.turn.conversationId] : [])));
            const missing = due.filter((run) => !journalled.has(run.conversationId)).map((run) => run.conversationId);
            if (missing.length > 0) {
                fail(`${missing.length} live turn(s) have no journal entry and will not survive a container recreate: ${missing.join(", ")}`);
            }
        },
    },
];

/* DEFERRED: the other direction — a journal entry for a turn that already settled, which the next boot would
 * dutifully re-run and bill to the owner's allowance unwatched. It is a real risk and it is deliberately not
 * checked here, because the daemon records no moment at which a turn settled: the clear is queued, the settled
 * notification fires without awaiting it, and an entry seen with no live run is indistinguishable between "leaked"
 * and "clearing right now". Checking it needs a settled-at stamp on the run, which is a change to the turn path
 * rather than to its diagnostics. */
