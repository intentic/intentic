import { computed, watch } from "vue";
import { useAgents } from "../agents/useAgents";
import { useReceipts } from "../receipts";
import { commitMessageOf } from "./changeOrigins";
import { fillCommitMessage, namedAfter } from "./commitMessage";

/* THE WHOLE LIFE OF A LANDING'S COMMIT MESSAGE, WATCHED FROM OUTSIDE ANY VIEW — it has started, it arrived, or
 * nothing could be written. All three said (or delivered) wherever the user happens to be standing.
 *
 * The sentence a "From" chip files into the commit box is drafted from the landed diff by a model, starting the
 * instant the work reaches the main tree (the daemon's agents/landed-subject.ts). The wait is the only part of
 * the feature anyone experiences, and it is reliably spent walking from the agent they just watched finish over
 * to the Changes panel — which is precisely where the wait is invisible: a chip with a sentence on its way looks
 * exactly like a chip with nothing coming.
 *
 * MODULE SCOPE, NOT THE PANEL, and that is the whole reason this file exists rather than a watcher inside
 * ReviewPanel.vue. That panel lives behind a v-if — the Files|Changes|History switch destroys it — so a
 * watcher there fires only for a user already looking at the thing it is explaining. The land happens on the
 * /agents board; this has to outlive the view, the same way the push notice and the receipt host itself do
 * (shell/WorkspaceRuntime.vue mounts this).
 *
 * IT NOW CARRIES THE ANSWER TOO, not just the promise, and that is a correction. The arrival used to be the
 * panel's to report and the panel's alone to deliver, on the reasoning that only the panel held the review that
 * could tell a written sentence from an unwritten one. The roster carries the sentence itself now
 * (AgentSummary.landedMessage), so that reason is gone — and what it was costing was the feature: a message
 * that arrived after the user had looked away landed nowhere, was announced to nobody, and left them clicking a
 * chip that had nothing behind it. A promise made at module scope has to be KEPT at module scope. */

// Live drafts, by agent id. Read off the fleet roster, which is broadcast: this costs no request at all, and no
// workspace rescan — see the daemon's setDraftingSubject for why the flag rides the roster rather than the review.
const drafting = computed(() => useAgents().fleet.value.filter((agent) => agent.draftingSubject === true));

// The sentence for the session the commit is being named after, as it stands this tick — undefined while it is
// still being written, and for a session nothing was ever written about. The roster only: an ALREADY-written
// message needs no waiting for, and the panel fills the box from the review for the archived agents the roster
// has dropped (ReviewPanel's own filterMessage).
const askedFor = computed(() =>
    namedAfter.value === undefined ? undefined : useAgents().fleet.value.find((agent) => agent.id === namedAfter.value)?.landedMessage,
);

const titleOf = (id: string): string => useAgents().fleet.value.find((agent) => agent.id === id)?.title ?? `an agent`;

// Started once and never stopped, like the module-level watches in useChanges.ts: a report about the workspace
// belongs to the session, not to whichever component happened to be mounted when the work landed.
export const startDraftingReceipts = (): void => {
    const { say } = useReceipts();

    watch(drafting, (now, was) => {
        const started = now.filter((agent) => !was.some((before) => before.id === agent.id));
        // One line per newly-started draft, newest winning the pill — two agents landing together is a real
        // (if uncommon) case, and the second is the one the user is most likely to still be watching.
        for (const agent of started) {
            say(`Writing a commit message for ${agent.title ?? `an agent`}…`);
        }

        /* AND WHAT BECAME OF IT. A draft that stops has produced a sentence or it has not, and until this the
         * two were the same silence over the same empty box — the exact state that reads as a broken feature
         * and sends the user round the loop of toggling the chip, switching views and reloading, none of which
         * could ever have helped. The chain being spent, a provider refusing, the deadline expiring
         * (agent/one-shot.ts) all land here, and all deserve to be said rather than left to be inferred.
         *
         * SAID FOR EVERY LANDING, exactly like the promise above it — that symmetry is the point. The line
         * "writing a commit message for X…" is offered to a user who has asked for nothing, so the answer owes
         * them the same courtesy: it is the cue to go and look, and withholding it is what left people waiting
         * on a sentence with no way of knowing it had arrived. One line per landing either way. */
        for (const agent of was.filter((before) => !now.some((current) => current.id === before.id))) {
            // Read off the roster's CURRENT frame, not the stale summary in `was` — the flag and the sentence
            // are broadcast in that order, so `was` is by construction the frame before the answer existed.
            const written = useAgents().fleet.value.find((entry) => entry.id === agent.id)?.landedMessage !== undefined;
            say(
                written
                    ? `Commit message ready for ${titleOf(agent.id)}`
                    : `Couldn't write a commit message for ${titleOf(agent.id)} — name the commit yourself.`,
            );
        }
    });

    /* THE DELIVERY. Whenever the sentence for the asked-after session exists, it goes into the box: on arrival
     * if the user is waiting, and immediately if it was already written before they asked. `immediate` matters
     * for the second case — a user who clicks a chip whose message landed while they were elsewhere is asking
     * for a value that is not going to change again.
     *
     * fillCommitMessage keeps every ownership rule: a box the user has typed in refuses this, and a fill may
     * only ever replace its own last line. Withdrawal is not handled here — putting the chip out goes through
     * nameCommitAfter, which takes the filed line back at the moment of the gesture rather than a tick later.
     *
     * Silent, deliberately: the arrival is announced above, on the edge where the user actually WAITED for it.
     * A box filling under a message that was already written needs no receipt — the fill is the receipt. */
    watch(
        askedFor,
        (message) => {
            const commit = commitMessageOf(message);
            if (commit !== undefined) {
                fillCommitMessage(commit);
            }
        },
        { immediate: true },
    );
};
