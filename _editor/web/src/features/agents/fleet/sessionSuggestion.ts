import { parsePinned } from "@intentic/sandbox-contract";
import { Conversation } from "../../chat/session/conversation";
import { summonChat } from "../../chat/run/summon";
import { openConversation, revealConversation } from "./agentActions";

// Suggests a specific piece of work with the turn already composed, so the app decides WHAT and the user decides IF:
// nothing runs until send is pressed. Not in the tab strip while pending, so a dismissed proposal leaves no trace;
// accepted, it lands exactly where "New agent" would. No dialog of its own: hosted by whichever surface raised the
// question.

// The turn, composed: everything that decides what actually runs.
export interface SessionDraft {
    // The composed first turn. Lands in the draft's composer, editable to the last character.
    readonly prompt: string;
    // `${provider}:${model}` and the effort beside it; empty or absent keeps the composer's own defaults, the model the
    // user already chose to work with.
    readonly model?: string;
    readonly effort?: string;
    // Isolated: the agent gets its own worktree and lands as a reviewable diff, like any other fleet agent.
    readonly isolated: boolean;
    // A derived id, for a proposal that answers a specific failure rather than a specific press; present, this proposal
    // IS its subject, so pressing twice about the same subject adds a turn to the same conversation rather than
    // starting a second one.
    readonly conversationId?: string;
}

// Composition lives here so a caller states what it wants and never configures a Conversation itself. A pinned model
// without a credential still applies; the composer's connect gate takes over rather than silently falling back.
export const composeSession = (draft: SessionDraft): Conversation => {
    // A derived id that's already open IS that conversation, not a second object wearing its name: the registry decides
    // whether this is new.
    const open = draft.conversationId === undefined ? undefined : openConversation(draft.conversationId);
    const conversation = open ?? new Conversation(draft.conversationId);
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

// Accept: the draft becomes a real tab exactly where "New agent" would leave it, its text sent as an ordinary first
// message. An emptied box starts nothing, since the user deleted the proposal rather than editing it.
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
