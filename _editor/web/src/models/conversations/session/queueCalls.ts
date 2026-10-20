import type { ConversationQueue, QueuedMessage } from "@intentic/sandbox-contract/schemas/agent";
import type { ResumeRouting } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { t } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { orRefusal, SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { FollowEnd } from "../../../client/sandbox/streams/turnStream";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import type { PendingAttachment } from "../../../features/chat/drafts/useChatAttachments";
import { uuid } from "../../../lib/uuid";
import { holdOfQueue, perMessage, queueFromMessages } from "../drafts/bookings";
import type { SendLater, TurnBooking } from "../drafts/sendLater";
import type { ContinueOptions } from "../endings/pickUp";
import { accountIntent, type SessionRef, type TurnSettings } from "../run/turnRequest";
import { type ChatAttachment, isNudgeText } from "../transcript/transcript";
import type { Conversation } from "./conversation";
import { movedByPick } from "./waitingRouting";

// A conversation's queue as the calls that change it answer it: which of two copies is newer, what a refusal says, the
// Continue booked for later, the waiting words a pick moves, and what goes in and comes out of it (a booking drawn ahead
// of the roster, a message taken back into the composer, a held turn's routing). Apart from TurnClient, which reaches
// them through its own methods.

/** Of two copies of the daemon's queue, the one written last: a card read late must not undo a change made here. */
export const newerQueue = (held: ConversationQueue | undefined, heard: ConversationQueue | undefined): ConversationQueue | undefined =>
    heard === undefined || (held !== undefined && held.revision > heard.revision) ? held : heard;

/** What a waiting message's change was refused for, in the words the error line uses. */
export const queueRefusal = (refusal: SandboxHttpError): string => {
    if (refusal.status === 412) {
        return t(`chat.turnClient.queueChangedElsewhere`);
    }
    return refusal.status === 404 ? t(`chat.turnClient.queueGone`) : refusal.message;
};

/**
 * A Continue booked for later (agent.queueContinue): at the booking's moment the conversation carries on from where its
 * last turn stopped, as Continue pressed then would (a turn the sandbox holds runs again as it was), and nothing is added
 * to it as the reader's words. It waits in the queue drawn as scheduled, with its own Change, Send now and Take back. A
 * moment already past carries on now, which `followNow` follows. Only a sandbox with the route can hold one; its callers
 * book words elsewhere. Resolves with whether the sandbox took it.
 */
export const bookContinue = async (
    chat: Pick<Conversation, "conversationId" | "error" | "box" | "queue">,
    booking: TurnBooking,
    followNow: () => Promise<FollowEnd>,
): Promise<boolean> => {
    chat.error.value = null;
    const left = await orRefusal(
        sandboxRpc.agent.queueContinue({ conversationId: chat.conversationId, ...booking, messageId: uuid() }, { context: { at: chat.box.value } }),
    );
    if (left instanceof SandboxHttpError) {
        chat.error.value = queueRefusal(left);
        return false;
    }
    chat.queue.value = newerQueue(chat.queue.value, left);
    if (!left.items.some((item) => item.continues === true)) {
        await followNow();
    }
    return true;
};

/**
 * Moves the person's words waiting in the queue onto `routing` (agent.queueReroute), among `ids` when named: what a pick
 * in the model picker does to them, since they otherwise go by themselves on the pick they were sent under. Only words
 * served elsewhere are named, so a pick that changes nothing for them asks nothing. Held ones stay held and booked ones
 * keep their time. Only a sandbox with the route can move them; on an older one the divider says they keep theirs.
 * Resolves with whether anything moved.
 */
export const followPick = async (
    chat: Pick<Conversation, "conversationId" | "error" | "box" | "queue">,
    routing: ResumeRouting,
    ids?: readonly string[],
): Promise<boolean> => {
    const moving = movedByPick(chat.queue.value, routing, ids);
    if (moving.length === 0 || !supportsRoute(`agent.queueReroute`)) {
        return false;
    }
    const left = await orRefusal(
        sandboxRpc.agent.queueReroute(
            { conversationId: chat.conversationId, routing, ids: moving.map((item) => item.id) },
            { context: { at: chat.box.value } },
        ),
    );
    // Gone out or taken back since: nothing is left to move, and the queue the next frame brings says so.
    if (left instanceof SandboxHttpError) {
        if (left.status !== 404) {
            chat.error.value = queueRefusal(left);
        }
        return false;
    }
    chat.queue.value = newerQueue(chat.queue.value, left);
    return true;
};

// A nudge (e.g. "Continue") behind a waiting nudge with no files says nothing new, so it is not sent at all. Never
// collapses against real words or files.
export const repeatsNudge = (message: { readonly text: string; readonly attachments: readonly unknown[] }, waiting?: QueuedMessage): boolean => {
    if (waiting === undefined || message.attachments.length > 0 || (waiting.attachments?.length ?? 0) > 0) {
        return false;
    }
    return isNudgeText(message.text) && isNudgeText(waiting.text);
};

// What a press re-runs a held turn on: the runtime and model the composer holds, the account only as a pick the daemon
// has not taken or a hand pick no turn has run on yet (the same rule a send names it by, accountIntent); naming none leaves
// it to the daemon's record, which also moves the turn off an account that can no longer serve. An empty pick means the
// daemon keeps the held model. `carry` keeps the provider session across an account change, only when asked; moving to
// another account is switchAccount's (continueOn). `handoff` is how a spent allowance's held turn continues (the card's
// pick, handoffChoice.ts).
export const heldRouting = (settings: TurnSettings, session: SessionRef | undefined, options: ContinueOptions): ResumeRouting => {
    const routing: ResumeRouting = { agent: settings.agent, harness: settings.harness, model: settings.model || undefined };
    const account = accountIntent(settings, { registered: true, session });
    if (account !== undefined) {
        routing.account = account;
    }
    if (options.carry === true) {
        routing.carry = true;
    }
    if (options.handoff !== undefined) {
        routing.handoff = options.handoff;
    }
    return routing;
};

// A file that went out with a message the daemon never answered for, staged again in the composer as a finished chip.
export const chipOf = (file: ChatAttachment): PendingAttachment => ({ id: uuid(), name: file.name, path: file.path, status: `done`, progress: 100 });

// A person's message taken back goes back where it was written, the inverse of the press that sent it: its words ahead of
// anything typed since, a blank line between (as words the daemon never took come back, giveBack), its files staged
// again as finished chips, and, into a box that held nothing of its own, the booking it waited by, so pressing again
// books it as it was rather than sending it now. Nothing typed is lost to a take-back: clearing the box is how words are
// thrown away. Never the sandbox's or an agent's words, which were nobody's here to write.
export const takeBackInto = (chat: Pick<Conversation, "draft" | "attachments" | "sendLater">, message: QueuedMessage, booking: SendLater | undefined): void => {
    const { draft, attachments, sendLater } = chat;
    const own = draft.value.trim() !== `` || attachments.value.length > 0;
    if (message.text.trim() !== ``) {
        draft.value = draft.value.trim() === `` ? message.text : `${message.text}\n\n${draft.value}`;
    }
    attachments.value = [...(message.attachments ?? []).map((path) => chipOf({ name: basename(path), path })), ...attachments.value];
    if (!own && booking !== undefined && sendLater.value === undefined) {
        sendLater.value = booking;
    }
};

// The scheduled words as the queue will hold them, drawn at the ack rather than on a roster frame that may come late (a
// busy sandbox, another box whose roster is polled). The daemon's own queue, at the same revision, replaces it. The same
// queue where it holds the message already.
export const withBooked = (
    queue: ConversationQueue | undefined,
    message: { readonly id: string; readonly text: string; readonly attachments: readonly string[] },
    booking: TurnBooking,
): ConversationQueue | undefined => {
    const held = queue ?? { items: [], revision: 0 };
    if (held.items.some((item) => item.id === message.id)) {
        return queue;
    }
    const revision = held.revision + 1;
    const item: QueuedMessage = { id: message.id, text: message.text, voice: `person`, queuedAt: Date.now(), revision };
    if (message.attachments.length > 0) {
        item.attachments = [...message.attachments];
    }
    // An instant or an agent to wait for, never both.
    const waitsFor = booking.sendAfter === undefined ? { until: booking.sendAt } : { after: booking.sendAfter };
    // A queue booked as a whole came from a sandbox older than per-message bookings: the newest booking holds all of it
    // there, as that sandbox's own queue will say.
    if (held.paused === `scheduled` && !perMessage(held)) {
        return { items: [...held.items, item], revision, paused: `scheduled`, ...waitsFor };
    }
    // Otherwise the message carries its own booking, and every other keeps its own.
    const hold = holdOfQueue(held);
    return queueFromMessages([...held.items, { ...item, ...waitsFor }], revision, hold === `scheduled` ? undefined : hold);
};
