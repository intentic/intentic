import type { MessageReceipt, TranscriptRow } from "@intentic/sandbox-contract";
import type { ConversationActors } from "../../../agents/actor/conversation-actors.js";
import { type Holding, turnRunOf } from "../../../agents/actor/conversation-holdings.js";
import type { Services } from "../../../composition.js";

// What became of each message a sender named, per conversation, so the same message sent again after a lost answer is
// met with its first answer instead of a second delivery. Kept in memory for the daemon's life; a daemon that has just
// started reads the tail of the record once per conversation, since a message's row carries its id and its run.

// Far more than a retry needs: a resend comes seconds after the send whose answer it lost.
const KEPT = 256;

// How far back a daemon that has just started reads a conversation's record for the messages it took before.
const SEED_TURNS = 8;

interface Receipts {
    readonly byId: Map<string, MessageReceipt>;
}

export const RECEIPTS: Holding<Receipts> = { name: "message receipts" };

// Each run's first message started it; every later one was said into it.
const receiptsOf = (rows: readonly TranscriptRow[]): Map<string, MessageReceipt> => {
    const byId = new Map<string, MessageReceipt>();
    const opened = new Set<string>();
    for (const row of rows) {
        if (row.role !== "user" || row.messageId === undefined || row.run === undefined) {
            continue;
        }
        byId.set(row.messageId, { delivered: opened.has(row.run) ? "steered" : "started", run: row.run });
        opened.add(row.run);
    }
    return byId;
};

// The conversation's receipts, seeded on first use from its record, from the run live now (which a daemon that has just
// started may have resumed from its journal before the record held any of it), and from what still waits in its queue.
const receiptsFor = async (services: Pick<Services, "conversations" | "transcripts">, conversationId: string): Promise<Receipts> => {
    const holdings = services.conversations.holdings(RECEIPTS);
    const held = holdings.get(conversationId);
    if (held !== undefined) {
        return held;
    }
    const { rows } = await services.transcripts.page({ id: conversationId }, { turns: SEED_TURNS });
    const live = turnRunOf(services.conversations, conversationId)?.rows ?? [];
    // Whatever was kept while the record was read is newer than the record.
    const kept = holdings.get(conversationId);
    if (kept !== undefined) {
        return kept;
    }
    const byId = receiptsOf([...rows, ...live]);
    for (const { id } of services.conversations.queued(conversationId).items) {
        byId.set(id, { delivered: "queued" });
    }
    const seeded: Receipts = { byId };
    holdings.hold(conversationId, conversationId, seeded);
    return seeded;
};

/** What became of the message this conversation took under `messageId`; undefined for one it never took. */
export const receiptOf = async (
    services: Pick<Services, "conversations" | "transcripts">,
    conversationId: string,
    messageId: string,
): Promise<MessageReceipt | undefined> => (await receiptsFor(services, conversationId)).byId.get(messageId);

/** Files what became of a message, replacing what an earlier answer said: a queued message later started, say. */
export const keepReceipt = (conversations: Pick<ConversationActors, "holdings">, conversationId: string, messageId: string, receipt: MessageReceipt): void => {
    const held = conversations.holdings(RECEIPTS).get(conversationId);
    // Only a conversation whose receipts were read has any to keep: every admission reads them before it delivers.
    if (held === undefined) {
        return;
    }
    held.byId.delete(messageId);
    held.byId.set(messageId, receipt);
    for (const oldest of held.byId.keys()) {
        if (held.byId.size <= KEPT) {
            break;
        }
        held.byId.delete(oldest);
    }
};
