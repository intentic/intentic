import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { turnRunOf } from "../../../conversations/actor/conversation-holdings.js";

/** Whether a conversation has a turn in flight: one running, or one whose run has not finished unwinding. */
export const turnInFlight = (conversations: Pick<ConversationActors, "turnActive" | "holdings">, conversationId: string): boolean =>
    conversations.turnActive(conversationId) || turnRunOf(conversations, conversationId)?.done === false;

/** Whether a conversation has work in flight: a live turn, or an armed watch it is waiting on. */
export const conversationBusy = (conversations: Pick<ConversationActors, "turnActive" | "state" | "holdings">, conversationId: string): boolean =>
    turnInFlight(conversations, conversationId) || (conversations.state(conversationId)?.watches.length ?? 0) > 0;
