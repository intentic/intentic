import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { Run } from "./run.js";
import type { StoredConversation } from "./store.js";

// A CONVERSATION'S CARD, as the board and the chat's header read one (the contract's AgentSummary): the record's facts,
// and while a turn runs, that turn's. A conversation here works straight in the reader's folder, so nothing on its card
// speaks of a branch, a private copy or landing.

// What a running turn adds to its conversation's card.
export interface LiveTurn {
    readonly run: Run;
    // The cards the turn is parked on, by kind, for the board's "needs you".
    readonly waiting: { readonly permission: boolean; readonly question: boolean };
    readonly stopping: boolean;
    // What the reader said while it ran, in the order it goes out as the next turn.
    readonly queue: readonly WaitingMessage[];
    // Moves with every change to `queue`.
    readonly queueRevision: number;
}

// One message waiting for the turn after this one.
export interface WaitingMessage {
    readonly id: string;
    readonly prompt: string;
    readonly attachments: readonly string[];
    readonly queuedAt: number;
    readonly revision: number;
}

// The waiting messages as the chat draws them under the running turn (the contract's ConversationQueue). Nothing here
// holds them back: they go out, as one turn, the moment this one ends.
const queueOf = (live: LiveTurn): NonNullable<AgentSummary[`queue`]> => ({
    revision: live.queueRevision,
    items: live.queue.map((message) => {
        const item: NonNullable<AgentSummary[`queue`]>[`items`][number] = {
            id: message.id,
            text: message.prompt,
            voice: `person`,
            queuedAt: message.queuedAt,
            revision: message.revision,
        };
        if (message.attachments.length > 0) {
            item.attachments = [...message.attachments];
        }
        return item;
    }),
});

const liveStatus = (live: LiveTurn): AgentSummary[`status`] => {
    if (live.stopping) {
        return `stopping`;
    }
    return live.waiting.permission || live.waiting.question ? `awaiting` : `running`;
};

export const cardOf = (record: StoredConversation, live: LiveTurn | undefined): AgentSummary => {
    const card: AgentSummary = {
        id: record.id,
        status: live === undefined ? record.status : liveStatus(live),
        provider: record.provider,
        harness: `native`,
        updatedAt: record.updatedAt,
        attention: {
            plan: false,
            question: live?.waiting.question === true,
            permission: live?.waiting.permission === true,
            capability: false,
            credential: false,
            conflict: false,
            need: false,
        },
        turns: record.turns,
        toolUses: record.toolUses,
    };
    if (record.title !== undefined) {
        card.title = record.title;
    }
    if (record.sessionId !== undefined) {
        card.sessionId = record.sessionId;
    }
    if (record.model !== undefined) {
        card.model = record.model;
    }
    if (record.effort !== undefined) {
        card.effort = record.effort;
    }
    if (record.failure !== undefined && live === undefined) {
        card.failure = record.failure;
    }
    if (record.seenAt !== undefined) {
        card.seenAt = record.seenAt;
    }
    if (record.archivedAt !== undefined) {
        card.archivedAt = record.archivedAt;
    }
    if (record.inputTokens !== undefined) {
        card.inputTokens = record.inputTokens;
    }
    if (record.outputTokens !== undefined) {
        card.outputTokens = record.outputTokens;
    }
    if (record.contextTokens !== undefined) {
        card.contextTokens = record.contextTokens;
    }
    if (record.contextWindow !== undefined) {
        card.contextWindow = record.contextWindow;
    }
    if (live !== undefined) {
        card.startedAt = live.run.startedAt;
        card.run = live.run.id;
        // Said for as long as the turn has ever had one, the drained one included: a reader replaces its copy by
        // revision and keeps the last it heard when a card names none, so an empty queue has to be said to be seen.
        if (live.queueRevision > 0) {
            card.queue = queueOf(live);
        }
    }
    return card;
};
