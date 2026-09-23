import type { ConversationActors } from "../../../agents/actor/conversation-actors.js";
import { turnRunOf } from "../../../agents/actor/conversation-holdings.js";

/** Whether a conversation has work in flight: a live turn, or an armed watch it is waiting on. */
export const conversationBusy = (conversations: Pick<ConversationActors, "turnActive" | "state" | "holdings">, conversationId: string): boolean =>
    conversations.turnActive(conversationId) ||
    turnRunOf(conversations, conversationId)?.done === false ||
    (conversations.state(conversationId)?.watches.length ?? 0) > 0;
