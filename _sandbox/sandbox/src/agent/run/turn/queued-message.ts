import { randomUUID } from "node:crypto";
import type { QueuedItem } from "../../../conversations/actor/conversation-queue.js";
import { opt } from "../../../opt.js";
import type { Said, TurnInput } from "../../../seams/turn-starter.js";

// A message between admission and the conversation's queue: the item the queue keeps, and the turn request it makes
// again when it is taken off. The two directions in one place, so what one drops the other cannot forget to restore.

type Turn = TurnInput & { readonly conversationId: string };

// The message as the queue keeps it, named: a sender that gave no id gets one, since the queue and a rewind name it.
export const queuedMessageOf = (said: Said): Omit<QueuedItem, "revision"> => {
    // The booking is the admission's to act on (bookingFor), never a field the started turn carries.
    const { actor, owner, areas, unseenRuns: _unseen, speaker, sendAt: _at, sendAfter: _after, sendAtReopen: _reopen, ...turn } = said.turn;
    const id = turn.messageId ?? randomUUID();
    return {
        id,
        voice: said.voice,
        ...opt("actor", actor),
        // The sandbox's own words are the sandbox's whoever queued them, so the row they open never reads as the owner's.
        ...opt("speaker", speaker ?? (said.voice === "sandbox" ? { kind: "sandbox" as const } : undefined)),
        ...opt("owner", owner),
        ...opt("areas", areas),
        ...opt("outside", said.outside),
        queuedAt: Date.now(),
        turn: { ...turn, messageId: id },
    };
};

// The request a queued message makes, with whoever sent it attributed again, and the taint its outside words carry.
export const requestOf = (item: Omit<QueuedItem, "revision">): Turn => ({
    ...item.turn,
    ...opt("speaker", item.speaker),
    ...opt("actor", item.actor),
    ...opt("owner", item.owner),
    ...opt("areas", item.areas),
    ...opt("outsideWake", item.outside),
});
