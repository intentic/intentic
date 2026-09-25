import { uuid } from "../../../lib/uuid";
import { summonChat } from "../../chat/run/summon";
import { useAgents } from "../fleet/useAgents";

// Opens a conversation the main line names (a land, a fix-up, the one a red waits on) the way its card would: a summons,
// since the chat showing it may be another window's. One the roster no longer carries (archived) opens by its session,
// the same door the board and the rail use for a conversation no card stands for.
export const openLandConversation = (conversationId: string, title?: string): void => {
    const agents = useAgents();
    const agent = agents.agentById(conversationId);
    if (agent !== undefined) {
        agents.open(agent);
        return;
    }
    const tab = uuid();
    summonChat({
        kind: `reveal`,
        verb: `show`,
        entries: [{ conversationId: tab, sessionRef: conversationId, ...(title === undefined ? {} : { title }) }],
        focus: tab,
        caret: false,
    });
};
