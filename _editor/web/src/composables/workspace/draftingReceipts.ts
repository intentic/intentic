import { computed, watch } from "vue";
import { useAgents } from "../agents/useAgents";
import { useReceipts } from "../receipts";

/* "A COMMIT MESSAGE IS BEING WRITTEN FOR THIS WORK" — said once, wherever the user happens to be standing.
 *
 * The sentence a "From" chip files into the commit box is drafted from the landed diff by a model, starting the
 * instant the work reaches the main tree (the daemon's agents/landed-subject.ts). It takes seconds, and those
 * seconds are the only part of the feature anyone experiences as a wait — reliably spent walking from the agent
 * they just watched finish over to the Changes panel, which is precisely where the wait is invisible: a chip
 * with a sentence on its way looks exactly like a chip with nothing coming.
 *
 * MODULE SCOPE, NOT THE PANEL, and that is the whole reason this file exists rather than a watcher inside
 * ReviewPanel.vue. That panel lives behind a v-if — the Files|Changes|History switch destroys it — so a
 * watcher there fires only for a user already looking at the thing it is explaining. The land happens on the
 * /agents board; the report has to outlive the view, the same way the push notice and the receipt host itself
 * do (shell/WorkspaceRuntime.vue mounts this).
 *
 * ONLY THE START IS REPORTED HERE. The arrival is reported by the panel, because only the panel holds the
 * review that says whether a sentence was actually written: the flag clearing means the drafting STOPPED, which
 * is also what a spent model chain and a refusal look like, and "your commit message is ready" over an empty
 * box would be the same broken promise this whole affordance exists to stop making. */

// Live drafts, by agent id. Read off the fleet roster, which is broadcast: this costs no request at all, and no
// workspace rescan — see the daemon's setDraftingSubject for why the flag rides the roster rather than the review.
const drafting = computed(() => useAgents().fleet.value.filter((agent) => agent.draftingSubject === true));

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
    });
};
