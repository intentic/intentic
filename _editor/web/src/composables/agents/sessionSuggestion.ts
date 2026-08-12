import { parsePinned } from "@intentic/sandbox-contract";
import { Conversation } from "../chat/conversation";
import { summonChat } from "../chat/summon";
import { revealConversation } from "./agentActions";

/* SUGGESTING A SESSION — the app proposing a specific piece of agent work, with the turn already composed, and
 * the user deciding whether and how to spend it.
 *
 * The shape exists because "the app knows what should happen next" and "the user owns what gets spent" are both
 * true, and a design that picks one loses. Starting the turn outright (what the landing gate's auto-fix did)
 * spends a frontier model on a prompt nobody read, on a schedule nobody chose. Merely REPORTING the problem
 * leaves the user to retype a prompt the app had already written perfectly well. So: the app composes the whole
 * turn — the text, the model, the effort, the isolation — and hands it over as a draft to be edited, re-pointed
 * or thrown away. Nothing runs until the user presses the button.
 *
 * THE DRAFT IS A REAL Conversation, not a settings bag, and that is what lets the proposal reuse the chat
 * composer's own controls rather than re-implement them: the model picker, the effort segments and the send
 * button all edit a Conversation, so pointing them at this one costs nothing (SuggestedSessionBox.vue). It is
 * deliberately NOT in the tab strip while it is being decided — a proposal the user dismisses must leave no
 * trace, and one they accept has to arrive exactly where "New agent" would have put it.
 *
 * NO DIALOG OF ITS OWN. `composeSession` + `startSession` are the whole mechanism and hold no state, so the box
 * is hosted by whichever surface raised the question — today the push flow's check dialog, which has to keep
 * "Push anyway" beside it. There was an app-wide dialog here as well, for callers with nowhere to put the box;
 * it never acquired one, and what it did acquire was a `<pre>` of the failing suite's OUTPUT, which is the
 * terminal's job (see composables/terminal/useTerminalPanel.ts for the rule). A host that already knows what it
 * is asking about writes better framing than a generic dialog can, so the generic one is gone rather than
 * waiting for a second caller to justify it. */

// The turn, composed — everything that decides what actually runs.
export interface SessionDraft {
    // The composed first turn. Lands in the draft's composer, editable to the last character.
    readonly prompt: string;
    // `${provider}:${model}` (quickModelKey) and the effort beside it, both normally from settings. Empty or
    // absent ⇒ the draft keeps whatever the composer's own defaults are, which is the right floor: it is the
    // model the user already chose to work with.
    readonly model?: string;
    readonly effort?: string;
    // Isolated ⇒ the agent gets its own worktree and lands as a reviewable diff, like any other fleet agent.
    readonly isolated: boolean;
}

/* Build the draft. Composition lives here rather than at each call site so a caller states what it wants done
 * and never has to know how a Conversation is configured.
 *
 * A model the settings pin but this sandbox has no credential for still applies: the picker shows it as locked
 * and the composer's connect gate takes over, which is the same handshake choosing it by hand would produce.
 * Quietly falling back to another model would spend an account the user did not pick. */
export const composeSession = (draft: SessionDraft): Conversation => {
    const conversation = new Conversation();
    conversation.isolated.value = draft.isolated;
    const pinned = draft.model === undefined ? undefined : parsePinned(draft.model);
    if (pinned !== undefined) {
        conversation.selectModel({ provider: pinned.provider, value: pinned.model });
    }
    if (draft.effort !== undefined && draft.effort !== ``) {
        conversation.setEffort(draft.effort);
    }
    conversation.draft.value = draft.prompt;
    return conversation;
};

/* Accept: the draft becomes a real tab, in the same place and the same state "New agent" would have left it —
 * a SUMMONS, so the chat panel showing it may be any window's (summon.ts) — and its composed text goes out as
 * an ORDINARY first message. `enqueue` and not a bespoke send, so the prompt sits in the transcript to be read
 * and argued with, the caret is in the composer to steer it, and Stop works on it like anything else. Not
 * awaited — enqueue settles when the TURN does, and the turn reports itself. Enqueued here only, never through
 * the summons: the turn it becomes reaches the other windows from the daemon.
 *
 * An emptied box starts nothing: the user deleted the proposal rather than editing it, and minting a tab for a
 * turn with no message would leave them staring at a blank agent they did not ask for. */
export const startSession = (conversation: Conversation): void => {
    const prompt = conversation.draft.value.trim();
    if (prompt === ``) {
        return;
    }
    conversation.draft.value = ``;
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
    void conversation.enqueue(prompt);
};
