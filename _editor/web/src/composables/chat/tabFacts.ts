import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import type { ClientAgentStatus } from "../agents/agentStatus";
import type { Conversation } from "./conversation";
import { draftPreview } from "./draftPreview";

/* THE CHAT'S STRIP, AS EVERYTHING OUTSIDE THE PANEL READS IT.
 *
 * The chat is drawn by one window at a time, and the fleet board is usually in another one, so the board's
 * account of a chat (is it open, what is it called, does it hold words nobody has sent) cannot be read off
 * this window's own tab objects: while the chat is popped out those are a frozen copy of a strip that is
 * changing somewhere else. It is read off THIS instead, one projection of one tab, computed by the window
 * drawing the chat, published to the rest (chatEcho.ts), and handed to every reader as `chatStrip`
 * (useChat.ts) whichever window they are in. A reader never chooses between the copy and the echo, because
 * every popped-out bug so far was a reader choosing wrong.
 *
 * It carries what a CARD needs and nothing a card does not. In particular it carries the first line of an
 * unsent message and not the message: a half-written message is the most private thing this app holds, and
 * a card only ever needs a name. */
export interface TabFacts {
    readonly id: string;
    // Whether the fleet has ever registered this conversation (Conversation.registered): a tab it has not is a
    // DRAFT card, drawn by the board from this alone.
    readonly registered: boolean;
    // Where the card stands when no registry entry says otherwise (standingOf, below).
    readonly standing: ClientAgentStatus;
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    // Which sandbox the conversation runs in, when that is not the one the browser is pointed at (Conversation.box).
    readonly box?: string;
    readonly title?: string;
    readonly sessionId?: string;
    // The model the next turn will run on: what a card for a prepared message names as its spend.
    readonly model: string;
    // Words in the composer, a staged attachment or a queued message (Conversation.unsent)...
    readonly unsent: boolean;
    // ...the first line of those words, when they are words (a card's name while nothing else has named it)...
    readonly preview?: string;
    // ...and when the composer first held something (Conversation.draftAt), so a mark can say how long.
    readonly draftAt?: number;
    // What this browser knows about a turn the daemon has not filed yet: present exactly while `starting`.
    readonly turn?: TurnFacts;
}

/* A sent turn the registry has no row for yet, as the sending window sees it. Such a card used to be a title
 * under a spinner and nothing else; every fact it was missing sat on the conversation that sent the turn. The
 * settings are the ones the send went out under, the start is the send itself, and the counts are the tab's own
 * running total, each replaced by the registry's version the moment it lands. Zero tokens and zero cost are
 * "nothing counted yet" rather than measurements, so they are left off until the turn's first usage frame. */
export interface TurnFacts {
    readonly effort: string;
    readonly thinking: boolean;
    readonly fast: boolean;
    readonly startedAt?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
}

/* The whole strip: which chat has the focus, which are on screen at once (the panes, in column order), and
 * every open tab. `active` is undefined only for a strip nobody has published yet. */
export interface Strip {
    readonly active: string | undefined;
    readonly panes: readonly string[];
    readonly tabs: readonly TabFacts[];
}

export const EMPTY_STRIP: Strip = { active: undefined, panes: [], tabs: [] };

/* WHERE A TAB WITH NO REGISTRY ENTRY STANDS. Three answers, and the order of the tests is the whole of it:
 *   · streaming, a turn has gone but the daemon has not filed it yet, which is `starting`. NOT the wire's
 *     `running`, which claims the registry's account of an agent the registry has never heard of: every guard
 *     that asks "does the daemon know this card" would then say yes, so clicking one latched the tab as
 *     registered and the card left the board with nothing to replace it (agentStatus.ts has the standing);
 *   · an error, the refusal that kept it off the roster in the first place: not a draft waiting to be typed
 *     into but a card for work that never started, which is what `failed` says;
 *   · a TRANSCRIPT or a session, this conversation has a past, so it was reopened from History rather than
 *     newly made. `resumed`: it used to answer `draft` here, which put a three-week-old chat at the head of the
 *     Active lane dressed as work about to begin.
 * Everything left is what "draft" was always meant to mean, an empty tab the user is about to type into. */
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

/* One live conversation, as the board reads it. Undefined fields are left undefined rather than omitted: the
 * strip crosses the channel as JSON, which drops them, so a local strip and a heard one read identically. */
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
        sessionId: conversation.session.value?.id,
        model: conversation.model.value,
        unsent: conversation.unsent.value,
        preview: draftPreview(conversation.draft.value),
        draftAt: conversation.draftAt.value,
        turn: standing === `starting` ? turnFacts(conversation) : undefined,
    };
};

/* An untouched "New agent" tab, as the strip tells it: nothing sent, nothing typed, nothing named. The board's
 * "New agent" press hands such a tab back rather than minting a twin (useChat.draftConversation), and the strip
 * writer sweeps one the moment the focus leaves it (useChat.setConversations); both ask this. */
export const untouched = (tab: TabFacts): boolean => !tab.registered && tab.standing === `draft` && !tab.unsent && tab.title === undefined;
