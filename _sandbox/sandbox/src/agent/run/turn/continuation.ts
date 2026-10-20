import { randomUUID } from "node:crypto";
import { type MessageReceipt, profileOf } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../composition.js";
import type { QueuedItem } from "../../../conversations/actor/conversation-queue.js";
import { conversationProfile } from "../../../conversations/registry/agents-store.js";
import { opt } from "../../../opt.js";
import type { ContinueAsk, ContinueBooked, TurnInput } from "../../../seams/turn-starter.js";
import { bookingOfAsk, unbookable } from "./booking-ask.js";
import { carryOnTurn } from "./turn-resume.js";

/* A CONTINUE CAN WAIT IN THE QUEUE, AS A CONTINUE. "Continue at 05:00", pressed on a turn a spent allowance stopped, used
   to book the word "Continue" as the person's message (the queue held only words, and a Continue could only start now):
   it stood in the transcript as words nobody wrote, and when it went its turn superseded the turn the sandbox was holding
   instead of re-running it, so the request was never re-run with its own note (2026-10-17). Now the queue holds a
   continuation: no words, drawn as scheduled in every window with its own Change, Send now and take-back, and when it
   goes it is the very Continue a press makes now (carryOnTurn): the held turn runs again as it was, or, with nothing
   held, the agent is told to continue in its own session. A turn that starts first makes it moot, and it is dropped
   (conversation-queue.ts, superseded). */

// The turn a queued continuation makes, attributed to whoever booked it, on the routing it was booked with.
const continuationTurn = (item: Omit<QueuedItem, "revision">): TurnInput & { readonly conversationId: string } => ({
    ...item.turn,
    ...opt("speaker", item.speaker),
    ...opt("actor", item.actor),
});

/**
 * A queued continuation's turn, started now: the Continue a person pressed for this moment. A person's say-so reopens an
 * archived conversation, as their words would. Taken from the queue once the turn has started; a conversation that would
 * not take it now (a sign-in being renewed, a turn already running) keeps it waiting. A door refusal leaves the turn the
 * sandbox's to keep, as a Continue pressed now does, never back in the queue. Undefined when it could not go.
 */
export const continueQueued = async (
    services: Services,
    item: Omit<QueuedItem, "revision">,
): Promise<ReadonlyMap<string, MessageReceipt> | undefined> => {
    const { conversationId } = item.turn;
    if (services.conversations.archived(conversationId)) {
        await services.agents.clearArchived([conversationId]);
    }
    const started = await carryOnTurn(services, continuationTurn(item));
    if (started === undefined) {
        return undefined;
    }
    services.conversations.send(conversationId, { kind: "queue-taken", ids: [item.id] });
    services.logger.info({ conversationId, run: started.id }, "admission: a booked continuation went out");
    return new Map([[item.id, { delivered: "started", run: started.id }]]);
};

// The continuation as the queue keeps it: no words, the conversation's routing as it stands (or the one the press named),
// attributed to whoever booked it.
const continuationItem = (services: Services, ask: ContinueAsk, id: string): Omit<QueuedItem, "revision"> | undefined => {
    const entry = services.agents.entry(ask.conversationId);
    if (entry === undefined) {
        return undefined;
    }
    const profile = conversationProfile(entry);
    const { routing } = ask;
    const turn = {
        ...profile,
        ...profileOf({ agent: routing?.agent ?? profile.agent, harness: routing?.harness ?? profile.harness }),
        ...opt("account", routing?.account ?? profile.account),
        ...opt("model", routing?.model ?? profile.model),
        conversationId: ask.conversationId,
        prompt: "",
        messageId: id,
    };
    return { id, voice: "person", ...opt("actor", ask.actor), ...opt("speaker", ask.speaker), queuedAt: Date.now(), turn, continues: true };
};

/**
 * Books a Continue for later (agent.queueContinue): a continuation booked as a scheduled send is, by the same booking
 * rules. A time already past carries on now, as a Continue pressed now does. The same id booked twice is booked once.
 */
export const bookContinuation = async (services: Services, ask: ContinueAsk, now: number = Date.now()): Promise<ContinueBooked> => {
    const id = ask.messageId ?? randomUUID();
    if (services.conversations.queued(ask.conversationId).items.some((item) => item.id === id)) {
        return "booked";
    }
    const item = continuationItem(services, ask, id);
    if (item === undefined) {
        return "unknown";
    }
    // A reopen is waited out where the continuation goes: who serves it, as its item names them.
    const booking = bookingOfAsk(services, { ...ask, agent: item.turn.agent, account: item.turn.account }, now);
    if (unbookable(booking)) {
        return { invalid: "invalid" in booking ? booking.invalid : booking.why };
    }
    if (booking === undefined) {
        return (await continueQueued(services, item)) === undefined ? "busy" : "started";
    }
    await services.conversations.send(ask.conversationId, { kind: "queue-scheduled", item, booking }).settled;
    services.logger.info({ conversationId: ask.conversationId, until: booking.until, after: booking.after?.conversationId }, "admission: a continuation is booked");
    return "booked";
};
