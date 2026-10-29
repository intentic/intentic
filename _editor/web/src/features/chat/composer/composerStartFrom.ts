import { computed, ref } from "vue";
import { useChanges } from "../../../models/changes/useChanges";
import type { Conversation } from "../../../models/conversations/session/conversation";
import { startFromFacts } from "../../../models/fleet/branches/branchStart";

// WHERE A NEW AGENT STARTS, as the composer's "Start from" control reads it (composerMore.ts `startFrom`): the main line
// (a fresh copy of the shared workspace, the default), a branch of one repository (Conversation.pendingFromBranch), or
// another agent's copy taken as the reader's own ask (Conversation.pendingFreshOf, kind `ask`). A draft's to choose
// alone: once the first turn is taken the start is the card's to say. A fork, or a fresh session for a check, is a
// start of its own, with a strip of its own, and leaves this control out.

/** One pane's Start from: its open flag, and its part of the composer's situation. */
export const useStartFrom = (conversation: () => Conversation) => {
    const { repos } = useChanges();
    // The workspace's own repository's main line, else the first one's: what a new agent starts from by default.
    const mainLine = computed(() => {
        const row = repos.value.find((repo) => repo.repo === `root`) ?? repos.value[0];
        return row?.mainBranch ?? row?.branch;
    });
    return {
        open: ref(false),
        mainLine,
        situation: computed(() => ({ ...startFromFacts(conversation()), mainLine: mainLine.value })),
    };
};
