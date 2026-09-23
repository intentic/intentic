import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import type { ClientAgentStatus } from "../../agents/fleet/agentStatus";
import type { Conversation } from "../session/conversation";
import type { ChatRunView } from "../run/chatRun";

// What a card needs to draw a tab, computed by the window drawing the chat and published as `chatStrip`
// (chatEcho.ts) for every other window.
//
// Deliberately carries no composer text. Everything here changes at the rate a tab opens, sends or is named; the
// words being typed change per character, and a field of them here would rebuild `useAgents-fleet.fleet` — which
// `agentById` answers from — on every keystroke. They travel on their own channel instead (chatPreviews), read
// only by the components that draw them. `unsent` is the low-frequency half and stays: it says a card HAS words.
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
    readonly run?: ChatRunView;
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
export const standingOf = (conversation: Conversation): ClientAgentStatus => {
    if (conversation.turn.streaming.value) {
        return `starting`;
    }
    if (conversation.error.value !== null) {
        return `failed`;
    }
    return conversation.transcript.messages.value.length > 0 || conversation.session.value !== undefined ? `resumed` : `draft`;
};

const turnFacts = (conversation: Conversation): TurnFacts => ({
    effort: conversation.selection.effort.value,
    thinking: conversation.selection.thinking.value,
    fast: conversation.selection.fast.value,
    startedAt: conversation.turn.turnStartedAt.value,
    ...(conversation.transcript.inputTokens.value > 0 ? { inputTokens: conversation.transcript.inputTokens.value, outputTokens: conversation.transcript.outputTokens.value } : {}),
    ...(conversation.transcript.costUsd.value > 0 ? { costUsd: conversation.transcript.costUsd.value } : {}),
});

// One live conversation as the board reads it. Undefined fields stay undefined rather than omitted, since
// JSON strips them and a local strip must read the same as a heard one.
export const tabFacts = (conversation: Conversation): TabFacts => {
    const standing = standingOf(conversation);
    return {
        id: conversation.conversationId,
        registered: conversation.registered.value,
        standing,
        provider: conversation.selection.provider.value,
        harness: conversation.selection.harness.value,
        box: conversation.box.value,
        title: conversation.title.value ?? undefined,
        peek: conversation.peek.value,
        standIn: conversation.standIn.value,
        sessionId: conversation.session.value?.id,
        model: conversation.selection.model.value,
        unsent: conversation.unsent.value,
        draftAt: conversation.draftAt.value,
        turn: standing === `starting` ? turnFacts(conversation) : undefined,
    };
};

// An untouched "New agent" tab: nothing sent, typed or named. draftConversation and setConversations both use
// this to reuse rather than duplicate it. Takes the four fields it reads rather than a whole TabFacts, so a
// conversation can answer without building one (see untouchedDraft).
export const untouched = (tab: Pick<TabFacts, "registered" | "standing" | "unsent" | "title">): boolean =>
    !tab.registered && tab.standing === `draft` && !tab.unsent && tab.title === undefined;

// The same question asked of a live conversation. Deliberately not `untouched(tabFacts(conversation))`: the whole
// projection reads a streaming turn's token and cost counters, so building one here would make every reader of the
// answer — the lane counts, the close sets, the tab sweep — wake on each usage frame of any open turn.
export const untouchedDraft = (conversation: Conversation): boolean =>
    untouched({
        registered: conversation.registered.value,
        standing: standingOf(conversation),
        unsent: conversation.unsent.value,
        title: conversation.title.value ?? undefined,
    });

// A panel's fallback blank (Conversation.standIn) that is still untouched; the board must not draw a card for
// it. Either half changing (a word typed, a turn sent, a name given) turns it into an ordinary draft.
export const unasked = (tab: Pick<TabFacts, "standIn" | "registered" | "standing" | "unsent" | "title">): boolean =>
    tab.standIn && untouched(tab);

// The same question asked of a live conversation, for the same reason as untouchedDraft.
export const unaskedDraft = (conversation: Conversation): boolean => conversation.standIn.value && untouchedDraft(conversation);
