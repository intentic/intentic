import type { ConversationActors } from "./conversation-actors.js";
import type { BeginOutcome, BeginTurn } from "./conversation-decide.js";

// Opens a turn on a conversation the way the daemon does: the `begin` event, answered once the entry's write has landed.
export const beginTurn = (conversations: Pick<ConversationActors, "send">, turn: BeginTurn, now: number): Promise<BeginOutcome> =>
    conversations.send(turn.conversationId, { kind: "begin", turn }, now).settled;
