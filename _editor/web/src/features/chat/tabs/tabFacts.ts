import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import type { ClientAgentStatus } from "../../agents/fleet/agentStatus";
import type { Conversation } from "../session/conversation";
import { draftPreview } from "../drafts/draftPreview";

// What a card needs to draw a tab, computed by the window drawing the chat and published as `chatStrip`
// (chatEcho.ts) for every other window. Carries a message's first line only, never the message itself.
export interface TabFacts {
    readonly id: string;
    // Whether the fleet has registered this conversation; unregistered means a draft card, drawn from this alone.
    readonly registered: boolean;
    // Where the card stands when no registry entry says otherwise (see standingOf).
    readonly standing: ClientAgentStatus;
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    // Which sandbox the conversation runs in, when not the one the browser is pointed at.
    readonly box?: string;
    readonly title?: string;
    // Only being looked at (Conversation.peek); the card saying so is often in another window (chatEcho.ts).
    readonly peek: boolean;
    // Standing on nothing to restore (Conversation.standIn); the fleet board, usually elsewhere, must ignore it.
    readonly standIn: boolean;
    readonly sessionId?: string;
    // Model the next turn will run on; what a prepared-message card names as its spend.
    readonly model: string;
    // Words in the composer, a staged attachment, or a queued message.
    readonly unsent: boolean;
    // First line of those words, when present: a card's name until something else names it.
    readonly preview?: string;
    // When the composer first held something (Conversation.draftAt), for an age readout.
    readonly draftAt?: number;
    // What this browser knows about an unfiled turn; present only while `starting`.
    readonly turn?: TurnFacts;
}

// A sent turn the registry hasn't filed yet, replaced by the registry's own version once it lands. Zero
// tokens/cost are left off ("nothing counted") until the turn's first usage frame.
export interface TurnFacts {
    readonly effort: string;
    readonly thinking: boolean;
    readonly fast: boolean;
    readonly startedAt?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
}

// The whole strip: focused chat, on-screen panes (column order), and every open tab. `active` is undefined
// only before anything is published.
export interface Strip {
    readonly active: string | undefined;
    readonly panes: readonly string[];
    readonly tabs: readonly TabFacts[];
}

export const EMPTY_STRIP: Strip = { active: undefined, panes: [], tabs: [] };

// Order matters:
// - streaming, no registry row yet: `starting`, not the wire's `running` (which would read as registered)
// - an unfiled error: `failed`
// - messages or a session already exist: `resumed`, not `draft`
// Everything else is an empty `draft`.
const standingOf = (conversation: Conversation): ClientAgentStatus => {
    if (conversation.streaming.value) {
        return `starting`;
    }
    if (conversation.error.value !== null) {
        return `failed`;
    }
    return conversation.messages.value.length > 0 || conversation.session.value !== undefined ? `resumed` : `draft`;
};

const turnFacts = (conversation: Conversation): TurnFacts => ({
    effort: conversation.effort.value,
    thinking: conversation.thinking.value,
    fast: conversation.fast.value,
    startedAt: conversation.turnStartedAt.value,
    ...(conversation.inputTokens.value > 0 ? { inputTokens: conversation.inputTokens.value, outputTokens: conversation.outputTokens.value } : {}),
    ...(conversation.costUsd.value > 0 ? { costUsd: conversation.costUsd.value } : {}),
});

// One live conversation as the board reads it. Undefined fields stay undefined rather than omitted, since
// JSON strips them and a local strip must read the same as a heard one.
export const tabFacts = (conversation: Conversation): TabFacts => {
    const standing = standingOf(conversation);
    return {
        id: conversation.conversationId,
        registered: conversation.registered.value,
        standing,
        provider: conversation.provider.value,
        harness: conversation.harness.value,
        box: conversation.box.value,
        title: conversation.title.value ?? undefined,
        peek: conversation.peek.value,
        standIn: conversation.standIn.value,
        sessionId: conversation.session.value?.id,
        model: conversation.model.value,
        unsent: conversation.unsent.value,
        preview: draftPreview(conversation.draft.value),
        draftAt: conversation.draftAt.value,
        turn: standing === `starting` ? turnFacts(conversation) : undefined,
    };
};

// An untouched "New agent" tab: nothing sent, typed or named. draftConversation and setConversations both use
// this to reuse rather than duplicate it.
export const untouched = (tab: TabFacts): boolean => !tab.registered && tab.standing === `draft` && !tab.unsent && tab.title === undefined;

// A panel's fallback blank (Conversation.standIn) that is still untouched; the board must not draw a card for
// it. Either half changing (a word typed, a turn sent, a name given) turns it into an ordinary draft.
export const unasked = (tab: TabFacts): boolean => tab.standIn && untouched(tab);
