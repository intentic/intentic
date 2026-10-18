import type { ConversationQueue } from "@intentic/sandbox-contract/schemas/agent";
import { t } from "@intentic/ui/i18n";
import { orRefusal, SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { FollowEnd } from "../../../client/sandbox/streams/turnStream";
import { uuid } from "../../../lib/uuid";
import type { TurnBooking } from "../drafts/sendLater";
import type { Conversation } from "./conversation";

// A conversation's queue as the calls that change it answer it: which of two copies is newer, what a refusal says, and
// the Continue booked for later. Apart from TurnClient, which reaches them through its own methods.

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
