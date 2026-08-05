import { parsePinned } from "@intentic/sandbox-contract";
import { computed, shallowRef } from "vue";
import { Conversation } from "../chat/conversation";
import { adoptConversation } from "../chat/useChat";
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
 * TWO HOSTS, ONE COMPOSITION. `composeSession` + `startSession` are the whole mechanism and hold no state, so a
 * surface that already owns a dialog can host the box inline (the push flow's check dialog, which has to keep
 * "Push anyway" beside it). Everything else raises `suggestSession` and gets the app-wide dialog for free. */

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

// …plus how the proposal is put to the user. Only the app-wide dialog reads these; an inline host writes its
// own framing, because it already has one.
export interface SessionSuggestion extends SessionDraft {
    // The dialog's header — what is being proposed, in the user's terms ("Checks failed").
    readonly title: string;
    // One line above the composer: why this is being suggested. The evidence's summary, not the evidence.
    readonly why: string;
    /* The raw material the prompt was written from — a failing suite's output — shown in a scrollable monospace
     * block. Separate from `prompt` on purpose: the agent gets it either way (the prompt quotes it), and the
     * user needs to SEE it to judge whether an agent is the right answer at all, which is the one decision this
     * is asking them to make. Folding it into an editable textarea would bury the question under a screenful of
     * stack traces. */
    readonly evidence?: string;
    // The primary button's label — a verb naming the work, never "OK".
    readonly action: string;
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

/* Accept: the draft becomes a real tab, in the same place and the same state "New agent" would have left it,
 * and its composed text goes out as an ORDINARY first message. `enqueue` and not a bespoke send, so the prompt
 * sits in the transcript to be read and argued with, the caret is in the composer to steer it, and Stop works
 * on it like anything else. Not awaited — enqueue settles when the TURN does, and the turn reports itself.
 *
 * An emptied box starts nothing: the user deleted the proposal rather than editing it, and minting a tab for a
 * turn with no message would leave them staring at a blank agent they did not ask for. */
export const startSession = (conversation: Conversation): void => {
    const prompt = conversation.draft.value.trim();
    if (prompt === ``) {
        return;
    }
    conversation.draft.value = ``;
    adoptConversation(conversation);
    revealConversation(conversation);
    void conversation.enqueue(prompt);
};

/* ---- the app-wide dialog's state ----
 *
 * ONE AT A TIME. A second suggestion replaces the first: these are raised by an action the user just took, so
 * the newest is the one they are standing in front of, and a queue would surface a dialog about something they
 * have since moved on from. */

// shallowRef, like the tab list itself: a Conversation owns its own refs, and letting `ref` deep-unwrap a class
// instance both rewrites its type and reaches into private state it has no business proxying.
const state = shallowRef<{ suggestion: SessionSuggestion; draft: Conversation } | undefined>(undefined);

export const pendingSuggestion = computed(() => state.value);

// Raise a suggestion in the app-wide dialog (SuggestedSessionDialog.vue, mounted in App.vue) — a module call
// from anywhere, with no wiring at the call site.
export const suggestSession = (suggestion: SessionSuggestion): void => {
    state.value = { suggestion, draft: composeSession(suggestion) };
};

// Dismiss without starting anything. The draft is dropped whole — it was never in the strip, so there is no tab
// to close and no turn to detach from.
export const dismissSuggestion = (): void => {
    state.value = undefined;
};

export const startSuggestedSession = (): void => {
    const pending = state.value;
    if (pending === undefined) {
        return;
    }
    state.value = undefined;
    startSession(pending.draft);
};
