import type { InvariantCheck } from "../invariants/invariants.js";
import type { TurnJournal } from "./run/turn/turn-journal.js";
import { liveTurnConversations } from "./run/turn/turn-runs.js";

// Ensures every live turn is journaled: intentic's own flows (updates, approvals, dev swaps) recreate the container,
// and a turn missing from the journal simply ends, work lost. Journal writes are deliberately best-effort; this checks
// for one that failed silently, from the other side, comparing two independent records: the journal directory and the
// live-run map.

// How long before a journal entry is expected; kept generous, since the failure sought is permanent, not slow.
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
        // Not `boot`: the journal holds the previous life's turns while the live map is empty there, by design. Also
        // `turn-settled`, since a turn ending is when a container recreate is most likely imminent.
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

// Deferred: the reverse leak (a settled turn's journal entry surviving to be re-run and billed at the next boot) isn't
// checked here, since there's no settled-at stamp to tell "leaked" from "clearing right now" — that needs a change to
// the turn path, not to diagnostics.
